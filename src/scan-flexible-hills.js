const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function scanFlexibleHills() {
  try {
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    // 1. 获取日期
    const dateRes = await pool.query(`
      SELECT MAX(LEFT(trade_time, 10)) as last_date 
      FROM tos_trades 
      WHERE trade_time ~ '^\\d{4}-\\d{2}-\\d{2}'
    `);
    
    let targetDate = dateRes.rows[0].last_date;
    if (!targetDate) {
       const createRes = await pool.query('SELECT MAX(DATE(created_at)) as last_date FROM tos_trades');
       targetDate = createRes.rows[0].last_date;
    }
    if (!targetDate) targetDate = new Date().toISOString().split('T')[0];
    
    console.log(`=== 正在扫描日期: ${targetDate} 的“宽幅/多周期”山丘形放量 ===`);

    // 2. 执行多尺度山丘检测
    // 策略：使用窗口聚合 + 形状相关性/特征检测
    // 我们不再硬编码 5 分钟，而是寻找一个时间窗口 (例如 5-15 分钟)，其成交量呈现 "低-高-低" 
    // 实现方法：
    //   a. 预计算每个点的 3分钟、5分钟、9分钟 移动平均量 (MA)
    //   b. 核心逻辑：
    //      - 找到局部最大值点 (Peak)
    //      - 向左寻找“起涨点” (Start): 连续 N 分钟量小于 Peak 的一定比例
    //      - 向右寻找“结束点” (End): 连续 N 分钟量小于 Peak 的一定比例
    //      - 计算持续时间 (Duration) = End - Start
    //      - 计算形态得分：是否中间高两边低
    
    // 下面的 SQL 逻辑：
    // 1. raw_data: 分钟级数据
    // 2. peaks: 找出局部峰值 (比前后 3 分钟都大)
    // 3. hill_context: 对每个峰值，获取其前后各 5 分钟的数据 (共11分钟窗口)，在应用层做灵活判断
    
    const sql = `
      WITH raw_data AS (
        SELECT 
          symbol,
          CASE 
             WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN date_trunc('minute', trim(trade_time)::timestamp)
             ELSE date_trunc('minute', ($1 || ' ' || trim(trade_time))::timestamp)
          END AS bucket,
          SUM(size) as volume
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
           -- 计算平滑基准线 (20分钟均线)
           AVG(volume) OVER (PARTITION BY symbol ORDER BY bucket ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) as baseline
         FROM raw_data
      ),
      peaks_raw AS (
        SELECT 
          symbol,
          bucket,
          volume,
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
          AND volume > baseline * 3 
          AND volume > v_m1 AND volume > v_m2 
          AND volume > v_p1 AND volume > v_p2
      ),
      context AS (
        -- 对于每个峰值，抓取它前后各 5 分钟的详细数据，组成一个数组
        SELECT
           p.symbol,
           p.bucket as peak_time,
           p.volume as peak_volume,
           p.baseline,
           -- 聚合前后数据：这里用 array_agg 比较复杂，我们换一种方式：
           -- 直接找出峰值，应用层再回查或者用 JSON 聚合
           (
             SELECT json_agg(json_build_object('t', r.bucket, 'v', r.volume))
             FROM raw_data r
             WHERE r.symbol = p.symbol 
               AND r.bucket >= p.bucket - INTERVAL '7 minutes'
               AND r.bucket <= p.bucket + INTERVAL '7 minutes'
           ) as hill_data
        FROM peaks p
      )
      SELECT * FROM context
      WHERE json_array_length(hill_data) >= 5 -- 确保数据点足够
    `;

    const { rows } = await pool.query(sql, [targetDate]);

    // 3. 应用层高级形态分析
    const results = [];
    
    for (const row of rows) {
      const data = row.hill_data.sort((a, b) => new Date(a.t) - new Date(b.t));
      const peakVol = row.peak_volume;
      const peakIndex = data.findIndex(d => new Date(d.t).getTime() === new Date(row.peak_time).getTime());
      
      if (peakIndex === -1) continue;

      // 寻找左边界 (Start)
      let leftIndex = peakIndex;
      while (leftIndex > 0) {
        // 如果量跌破峰值的 30% 或者 跌破基准线，视为山脚
        if (data[leftIndex-1].v < peakVol * 0.3 || data[leftIndex-1].v < row.baseline) {
          leftIndex--; // 包含这个低点作为山脚
          break; 
        }
        // 如果出现反向升高，说明是另一个山峰，停止
        if (data[leftIndex-1].v > data[leftIndex].v) break;
        leftIndex--;
      }

      // 寻找右边界 (End)
      let rightIndex = peakIndex;
      while (rightIndex < data.length - 1) {
        if (data[rightIndex+1].v < peakVol * 0.3 || data[rightIndex+1].v < row.baseline) {
          rightIndex++; // 包含这个低点作为山脚
          break;
        }
        if (data[rightIndex+1].v > data[rightIndex].v) break;
        rightIndex++;
      }

      const duration = rightIndex - leftIndex + 1;
      
      // 过滤：
      // 1. 持续时间至少 5 分钟 (如果不止5分钟，可以改大)
      // 2. 只有当它是一个真正的宽峰时才保留
      if (duration >= 5) {
        // 构建形态字符串
        const shapeStr = data.slice(leftIndex, rightIndex + 1).map(d => d.v).join('-');
        
        // 计算整体 fullness (填充度)：(总成交量 / (峰值 * 持续时间))
        // 三角形是 0.5，矩形是 1.0。山丘通常在 0.4 - 0.7 之间
        let totalVol = 0;
        for(let i=leftIndex; i<=rightIndex; i++) totalVol += data[i].v;
        const fullness = totalVol / (peakVol * duration);

        results.push({
          symbol: row.symbol,
          peakTime: row.peak_time,
          peakVol: peakVol,
          baseline: row.baseline,
          ratio: peakVol / row.baseline,
          duration: duration,
          fullness: fullness,
          shape: data.slice(leftIndex, rightIndex + 1).map(d => d.v)
        });
      }
    }

    // 排序并输出
    results.sort((a, b) => b.fullness - a.fullness); // 按饱满度排序，或者按 ratio 排序

    if (results.length === 0) {
      console.log('未找到符合条件的宽幅山丘。');
    } else {
      console.log(`\n找到 ${results.length} 个“宽幅/多周期”山丘 (按形态饱满度排序):\n`);
      console.log(
        'Symbol'.padEnd(10) + 
        'Peak Time'.padEnd(15) + 
        'Peak Vol'.padEnd(10) + 
        'Dur(min)'.padEnd(10) + 
        'Ratio'.padEnd(8) + 
        'Fullness'.padEnd(10) +
        'Shape (Start...Peak...End)'
      );
      console.log('-'.repeat(100));

      results.slice(0, 30).forEach(r => {
        const timeStr = new Date(r.peakTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const shapePreview = r.shape.length > 7 
          ? `${r.shape[0]}...${r.peakVol}...${r.shape[r.shape.length-1]}`
          : r.shape.join('-');
          
        console.log(
          r.symbol.padEnd(10) + 
          timeStr.padEnd(15) + 
          String(r.peakVol).padEnd(10) + 
          String(r.duration).padEnd(10) + 
          String(r.ratio.toFixed(1) + 'x').padEnd(8) + 
          String(r.fullness.toFixed(2)).padEnd(10) +
          shapePreview
        );
      });
    }

  } catch (e) {
    console.error('扫描出错:', e);
  } finally {
    await pool.end();
  }
}

scanFlexibleHills();
