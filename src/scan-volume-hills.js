const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function scanVolumeHills() {
  try {
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    // 1. 自动获取数据库中最近的一个交易日期
    // 优先从 trade_time 获取日期，因为它反映了实际交易时间
    const dateRes = await pool.query(`
      SELECT MAX(LEFT(trade_time, 10)) as last_date 
      FROM tos_trades 
      WHERE trade_time ~ '^\\d{4}-\\d{2}-\\d{2}'
    `);
    
    let targetDate = dateRes.rows[0].last_date;
    
    // 如果 trade_time 中没有日期（只有时间），则回退到 created_at
    if (!targetDate) {
       const createRes = await pool.query('SELECT MAX(DATE(created_at)) as last_date FROM tos_trades');
       targetDate = createRes.rows[0].last_date;
    }
    
    // 如果还是没有，默认使用今天
    if (!targetDate) {
      targetDate = new Date().toISOString().split('T')[0];
    }
    
    console.log(`=== 正在扫描日期: ${targetDate} 的山丘形放量 ===`);

    // 2. 执行山丘形态检测查询
    // 策略：左右斜率法 (Relaxed Slope Method)
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
          -- 计算过去20分钟的平均成交量（基准线）
          AVG(volume) OVER (PARTITION BY symbol ORDER BY bucket ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) as avg_vol_20
        FROM raw_data
        WINDOW w AS (PARTITION BY symbol ORDER BY bucket)
      ),
      candidates AS (
        SELECT 
          *,
          -- 计算幅度倍数
          volume / NULLIF(avg_vol_20, 0) as magnitude_ratio
        FROM window_stats
        WHERE 
          volume > 500 -- 降低绝对阈值
          AND volume > v_m1 AND volume > v_p1 -- 基础山丘：比左右都高
      )
      SELECT 
        symbol,
        bucket,
        volume,
        avg_vol_20,
        magnitude_ratio,
        v_m2, v_m1, v_p1, v_p2
      FROM candidates
      WHERE 
        magnitude_ratio >= 2.0 -- 降低相对阈值到2倍
        -- 增强形态检查：
        AND (
          (v_m1 > v_m2 AND v_p1 > v_p2) OR -- 完美山丘
          (magnitude_ratio > 4.0) -- 或者如果量特别大，形态要求可以稍微放宽
        )
      ORDER BY magnitude_ratio DESC
      LIMIT 50;
    `;

    const { rows } = await pool.query(sql, [targetDate]);

    if (rows.length === 0) {
      console.log('未找到符合条件的“山丘形放量”形态。');
    } else {
      console.log(`\n找到 ${rows.length} 个符合条件的形态 (按爆发倍数排序):\n`);
      console.log('Symbol'.padEnd(10) + 'Time'.padEnd(25) + 'Volume'.padEnd(10) + 'Avg(20m)'.padEnd(10) + 'Ratio'.padEnd(10) + 'Pattern (L2-L1-Vol-R1-R2)');
      console.log('-'.repeat(90));
      
      rows.forEach(r => {
        const pattern = `${r.v_m2 || 0}-${r.v_m1}-${r.volume}-${r.v_p1}-${r.v_p2 || 0}`;
        const timeStr = new Date(r.bucket).toLocaleTimeString();
        console.log(
          r.symbol.padEnd(10) + 
          timeStr.padEnd(25) + 
          String(r.volume).padEnd(10) + 
          String(Math.round(r.avg_vol_20)).padEnd(10) + 
          String(Number(r.magnitude_ratio).toFixed(1) + 'x').padEnd(10) + 
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

scanVolumeHills();
