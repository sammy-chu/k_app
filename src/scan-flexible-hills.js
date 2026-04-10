const { Pool } = require('pg');

// 独立运行时使用的连接池配置
const dbConfig = {
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
};

/**
 * 核心策略函数：寻找宽幅/多周期山丘
 * @param {Object} pool - Postgres 连接池
 * @param {string} [dateStr] - 目标日期 (YYYY-MM-DD)，如果不传则自动检测
 * @returns {Promise<Object>} - 结果对象 { date, count, data }
 */
async function getFlexibleHills(pool, dateStr) {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 120000'); // 2 minutes timeout for heavy query
    await client.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    // 1. 获取日期
    let targetDate = dateStr;
    if (!targetDate) {
      const dateRes = await client.query(`
        SELECT MAX(time_period::date) as last_date
        FROM kline_1m
        WHERE time_period >= NOW() - INTERVAL '7 days'
      `);
      targetDate = dateRes.rows[0].last_date;
      if (!targetDate) {
         targetDate = new Date().toISOString().split('T')[0];
      }
    }

    // 2. 从 kline_1m 读取分钟级数据，在 JS 层检测山丘
    const sql = `
      SELECT
        symbol,
        time_period AS bucket,
        volume,
        close AS price
      FROM kline_1m
      WHERE
        time_period >= $1::date
        AND time_period < ($1::date + INTERVAL '1 day')
      ORDER BY symbol, time_period
    `;

    const { rows } = await client.query(sql, [targetDate]);

    if (rows.length === 0) {
      return { date: targetDate, count: 0, data: [] };
    }

    // Step 2: 在 JS 层按 symbol 分组，检测山丘形态
    const bySymbol = {};
    for (const row of rows) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = [];
      bySymbol[row.symbol].push({
        bucket: row.bucket,
        volume: Number(row.volume),
        avg_price: Number(row.price)
      });
    }

    const results = [];

    for (const [symbol, bars] of Object.entries(bySymbol)) {
      if (bars.length < 5) continue;

      // 计算 baseline（前20根均值）和 LAG
      for (let i = 0; i < bars.length; i++) {
        const start = Math.max(0, i - 20);
        const end = i;
        if (end > start) {
          let sum = 0;
          for (let j = start; j < end; j++) sum += bars[j].volume;
          bars[i].baseline = sum / (end - start);
        } else {
          bars[i].baseline = 0;
        }
      }

      // 找 peaks
      for (let i = 2; i < bars.length; i++) {
        const b = bars[i];
        if (b.volume <= 1000) continue;
        if (b.volume * b.avg_price <= 50000) continue;
        if (b.baseline <= 0 || b.volume <= b.baseline * 3) continue;
        if (b.volume <= bars[i-1].volume || b.volume <= bars[i-2].volume) continue;

        // 找到 peak，提取 ±15 分钟上下文
        const peakTime = b.bucket;
        const peakVol = b.volume;
        const baseline = b.baseline;

        // 收集 ±15 分钟窗口
        const contextBars = [];
        for (let j = 0; j < bars.length; j++) {
          const diff = (new Date(bars[j].bucket) - new Date(peakTime)) / 60000;
          if (diff >= -15 && diff <= 15) {
            contextBars.push({ t: bars[j].bucket, v: bars[j].volume });
          }
        }

        if (contextBars.length < 5) continue;

        // 山丘形态检测（与原逻辑一致）
        const peakIndex = contextBars.findIndex(d => new Date(d.t).getTime() === new Date(peakTime).getTime());
        if (peakIndex === -1) continue;

        let leftIndex = peakIndex;
        while (leftIndex > 0) {
          if (contextBars[leftIndex-1].v < peakVol * 0.3 || contextBars[leftIndex-1].v < baseline) {
            leftIndex--;
            break;
          }
          if (contextBars[leftIndex-1].v > contextBars[leftIndex].v) break;
          leftIndex--;
        }

        let rightIndex = peakIndex;
        while (rightIndex < contextBars.length - 1) {
          if (contextBars[rightIndex+1].v < peakVol * 0.3 || contextBars[rightIndex+1].v < baseline) {
            rightIndex++;
            break;
          }
          if (contextBars[rightIndex+1].v > contextBars[rightIndex].v) break;
          rightIndex++;
        }

        const duration = rightIndex - leftIndex + 1;
        if (duration >= 4) {
          let totalVol = 0;
          for (let k = leftIndex; k <= rightIndex; k++) totalVol += contextBars[k].v;
          const fullness = totalVol / (peakVol * duration);

          results.push({
            symbol,
            peakTime,
            startTime: contextBars[leftIndex].t,
            endTime: contextBars[rightIndex].t,
            peakVol,
            baseline,
            ratio: peakVol / (baseline || 1),
            duration,
            fullness,
            shape: contextBars.slice(leftIndex, rightIndex + 1).map(d => d.v)
          });
        }
      }
    }

    // Sort by peakTime descending
    results.sort((a, b) => new Date(b.peakTime) - new Date(a.peakTime));

    return {
      date: targetDate,
      count: results.length,
      data: results
    };
  } finally {
    await client.query('SET statement_timeout = 0').catch(e => console.error(e));
    client.release();
  }
}

// 独立运行时执行
if (require.main === module) {
  (async () => {
    const pool = new Pool(dbConfig);
    try {
      const result = await getFlexibleHills(pool);
      console.log(`=== 正在扫描日期: ${result.date} 的“宽幅/多周期”山丘形放量 ===`);
      
      if (result.count === 0) {
        console.log('未找到符合条件的宽幅山丘。');
      } else {
        console.log(`\n找到 ${result.count} 个“宽幅/多周期”山丘 (按形态饱满度排序):\n`);
        console.log(
          'Symbol'.padEnd(10) + 
          'Time Range'.padEnd(35) + 
          'Peak Vol'.padEnd(10) + 
          'Dur'.padEnd(6) + 
          'Ratio'.padEnd(8) + 
          'Full'.padEnd(6) +
          'Shape'
        );
        console.log('-'.repeat(120));

        result.data.slice(0, 100).forEach(r => {
        const startStr = new Date(r.startTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          const endStr = new Date(r.endTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          const peakStr = new Date(r.peakTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
          const timeRange = `${startStr}-${endStr} (P:${peakStr})`;
          
          const shapePreview = r.shape.length > 7 
            ? `${r.shape[0]}...${r.peakVol}...${r.shape[r.shape.length-1]}`
            : r.shape.join('-');
            
          console.log(
            r.symbol.padEnd(10) + 
            timeRange.padEnd(35) + 
            String(r.peakVol).padEnd(10) + 
            String(r.duration).padEnd(6) + 
            String(r.ratio.toFixed(1) + 'x').padEnd(8) + 
            String(r.fullness.toFixed(2)).padEnd(6) +
            shapePreview
          );
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      await pool.end();
    }
  })();
}

module.exports = { getFlexibleHills };
