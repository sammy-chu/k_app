const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function scanGradualHills() {
  try {
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    // 1. 自动获取数据库中最近的一个交易日期
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
    
    if (!targetDate) {
      targetDate = new Date().toISOString().split('T')[0];
    }
    
    console.log(`=== 正在扫描日期: ${targetDate} 的“渐进式”山丘形放量 ===`);

    // 2. 执行渐进式山丘形态检测查询
    // 策略：严格 5-bar 山丘 (Strict 5-bar Hill)
    // 定义：
    //   - 形态：v_m2 < v_m1 < vol > v_p1 > v_p2 (严格单调递增再递减)
    //   - 宽度支撑：肩膀 (v_m1, v_p1) 必须显著高于基准线 (证明不是单根针)
    //   - 峰值力度：vol 必须显著高于基准线
    
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
      window_stats AS (
        SELECT 
          symbol,
          bucket,
          volume,
          -- 获取前后各2根K线的成交量
          LAG(volume, 2) OVER w as v_m2,
          LAG(volume, 1) OVER w as v_m1,
          LEAD(volume, 1) OVER w as v_p1,
          LEAD(volume, 2) OVER w as v_p2,
          -- 计算基准线：使用 t-20 到 t-3 之间的均值（避开当前山丘的影响）
          AVG(volume) OVER (PARTITION BY symbol ORDER BY bucket ROWS BETWEEN 20 PRECEDING AND 3 PRECEDING) as avg_vol_baseline
        FROM raw_data
        WINDOW w AS (PARTITION BY symbol ORDER BY bucket)
      ),
      candidates AS (
        SELECT 
          *,
          volume / NULLIF(avg_vol_baseline, 0) as peak_ratio,
          v_m1 / NULLIF(avg_vol_baseline, 0) as left_shoulder_ratio,
          v_p1 / NULLIF(avg_vol_baseline, 0) as right_shoulder_ratio
        FROM window_stats
        WHERE 
          volume > 1000 -- 绝对过滤
          AND avg_vol_baseline > 0
          -- 核心形态：严格递增再递减 (渐进爬升)
          AND v_m2 < v_m1 AND v_m1 < volume
          AND volume > v_p1 AND v_p1 > v_p2
      )
      SELECT 
        symbol,
        bucket,
        volume,
        avg_vol_baseline,
        peak_ratio,
        v_m2, v_m1, v_p1, v_p2
      FROM candidates
      WHERE 
        peak_ratio >= 3.0 -- 峰值至少是基准的3倍
        AND left_shoulder_ratio >= 1.5 -- 左肩至少是基准的1.5倍 (确保不是突变)
        AND right_shoulder_ratio >= 1.5 -- 右肩至少是基准的1.5倍 (确保缓慢回落)
      ORDER BY peak_ratio DESC
      LIMIT 50;
    `;

    const { rows } = await pool.query(sql, [targetDate]);

    if (rows.length === 0) {
      console.log('未找到符合条件的“渐进式山丘”形态。');
    } else {
      console.log(`\n找到 ${rows.length} 个符合条件的“渐进式”形态 (按爆发倍数排序):\n`);
      console.log('Symbol'.padEnd(10) + 'Time'.padEnd(25) + 'Volume'.padEnd(10) + 'Base'.padEnd(10) + 'Ratio'.padEnd(10) + 'Pattern (L2-L1-Vol-R1-R2)');
      console.log('-'.repeat(90));
      
      rows.forEach(r => {
        const pattern = `${r.v_m2 || 0}-${r.v_m1}-${r.volume}-${r.v_p1}-${r.v_p2 || 0}`;
        const timeStr = new Date(r.bucket).toLocaleTimeString();
        console.log(
          r.symbol.padEnd(10) + 
          timeStr.padEnd(25) + 
          String(r.volume).padEnd(10) + 
          String(Math.round(r.avg_vol_baseline)).padEnd(10) + 
          String(Number(r.peak_ratio).toFixed(1) + 'x').padEnd(10) + 
          pattern
        );
      });
    }

  } catch (e) {
    console.error('扫描出错:', e);
  } finally {
    await pool.end();
  }
}

scanGradualHills();
