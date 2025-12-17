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
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

  // 1. 获取日期
  let targetDate = dateStr;
  if (!targetDate) {
    const dateRes = await pool.query(`
      SELECT MAX(LEFT(trade_time, 10)) as last_date 
      FROM tos_trades 
      WHERE trade_time ~ '^\\d{4}-\\d{2}-\\d{2}'
    `);
    targetDate = dateRes.rows[0].last_date;
    if (!targetDate) {
       const createRes = await pool.query('SELECT MAX(DATE(created_at)) as last_date FROM tos_trades');
       targetDate = createRes.rows[0].last_date;
    }
    if (!targetDate) targetDate = new Date().toISOString().split('T')[0];
  }

  // 2. 执行查询
  // 使用 15分钟 前后窗口以捕捉更完整的山丘
  const sql = `
    WITH raw_data AS (
      SELECT 
        symbol,
        CASE 
           WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN date_trunc('minute', trim(trade_time)::timestamp)
           ELSE date_trunc('minute', ($1 || ' ' || trim(trade_time))::timestamp)
        END AS bucket,
        SUM(size) as volume,
        AVG(price) as avg_price
      FROM tos_trades
      WHERE 
        (trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND LEFT(trim(trade_time), 10) = $1::text) OR
        (trim(trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND DATE(created_at) = $1::date)
      GROUP BY 1, 2
    ),
    smoothed AS (
       SELECT
         symbol,
         bucket,
         volume,
         avg_price,
         AVG(volume) OVER (PARTITION BY symbol ORDER BY bucket ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) as baseline
       FROM raw_data
    ),
    peaks_raw AS (
      SELECT 
        symbol,
        bucket,
        volume,
        avg_price,
        baseline,
        LAG(volume, 1) OVER w as v_m1,
        LAG(volume, 2) OVER w as v_m2,
        LEAD(volume, 1) OVER w as v_p1,
        LEAD(volume, 2) OVER w as v_p2
      FROM smoothed
      WINDOW w AS (PARTITION BY symbol ORDER BY bucket)
    ),
    peaks AS (
      SELECT * FROM peaks_raw
      WHERE 
        volume > 1000 
        AND volume * avg_price > 50000 
        AND volume > baseline * 2 
        AND volume > v_m1 AND volume > v_m2 
        AND volume > v_p1 AND volume > v_p2
    ),
    context AS (
      SELECT
         p.symbol,
         p.bucket as peak_time,
         p.volume as peak_volume,
         p.baseline,
         (
           SELECT json_agg(json_build_object('t', r.bucket, 'v', r.volume))
           FROM raw_data r
           WHERE r.symbol = p.symbol 
             AND r.bucket >= p.bucket - INTERVAL '15 minutes'
             AND r.bucket <= p.bucket + INTERVAL '15 minutes'
         ) as hill_data
      FROM peaks p
    )
    SELECT * FROM context
    WHERE json_array_length(hill_data) >= 5
  `;

  const { rows } = await pool.query(sql, [targetDate]);

  // 3. 应用层处理
  const results = [];
  
  for (const row of rows) {
    if (!row.hill_data) continue;
    
    const data = row.hill_data.sort((a, b) => new Date(a.t) - new Date(b.t));
    const peakVol = row.peak_volume;
    const peakIndex = data.findIndex(d => new Date(d.t).getTime() === new Date(row.peak_time).getTime());
    
    if (peakIndex === -1) continue;

    let leftIndex = peakIndex;
    while (leftIndex > 0) {
      if (data[leftIndex-1].v < peakVol * 0.3 || data[leftIndex-1].v < row.baseline) {
        leftIndex--; 
        break; 
      }
      if (data[leftIndex-1].v > data[leftIndex].v) break;
      leftIndex--;
    }

    let rightIndex = peakIndex;
    while (rightIndex < data.length - 1) {
      if (data[rightIndex+1].v < peakVol * 0.3 || data[rightIndex+1].v < row.baseline) {
        rightIndex++; 
        break;
      }
      if (data[rightIndex+1].v > data[rightIndex].v) break;
      rightIndex++;
    }

    const duration = rightIndex - leftIndex + 1;
    
    if (duration >= 4) {
      let totalVol = 0;
      for(let i=leftIndex; i<=rightIndex; i++) totalVol += data[i].v;
      const fullness = totalVol / (peakVol * duration);

      results.push({
        symbol: row.symbol,
        peakTime: row.peak_time,
        startTime: data[leftIndex].t, // Added start time
        endTime: data[rightIndex].t,   // Added end time
        peakVol: peakVol,
        baseline: row.baseline,
        ratio: peakVol / (row.baseline || 1),
        duration: duration,
        fullness: fullness,
        shape: data.slice(leftIndex, rightIndex + 1).map(d => d.v)
      });
    }
  }

  // Sort by peakTime descending (latest first)
  results.sort((a, b) => new Date(b.peakTime) - new Date(a.peakTime));
  
  return {
    date: targetDate,
    count: results.length,
    data: results
  };
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
