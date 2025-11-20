const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function testAlertSQL() {
  try {
    await pool.query('SET search_path TO market_data');
    
    // 测试简化版的提醒查�?    const sql = `
      WITH recent_trades AS (
        SELECT symbol, trade_time, price::numeric AS price
        FROM tos_trades 
        WHERE price IS NOT NULL AND price::numeric > 0
        ORDER BY id DESC 
        LIMIT 1000
      ),
      minute_agg AS (
        SELECT symbol,
               MAX(price) AS high,
               MIN(price) AS low,
               (array_agg(price ORDER BY trade_time ASC))[1] AS open,
               (array_agg(price ORDER BY trade_time DESC))[1] AS close
        FROM recent_trades
        GROUP BY symbol
      ),
      alerts AS (
        SELECT symbol, open, high, low, close,
               CASE WHEN open > 0 THEN (high - low) / open ELSE 0 END AS amplitude_pct,
               CASE WHEN close > open THEN 1 WHEN close < open THEN -1 ELSE 0 END AS direction
        FROM minute_agg
        WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
      )
      SELECT symbol, open, high, low, close, amplitude_pct, direction
      FROM alerts
      WHERE amplitude_pct >= 0.01
      ORDER BY amplitude_pct DESC
      LIMIT 10;
    `;

    const { rows } = await pool.query(sql);
    console.log('Found potential alerts:', rows.length);
    console.log('Sample alerts:', rows);
    
    // 如果有符合条件的提醒，尝试插�?    if (rows.length > 0) {
      for (const alert of rows.slice(0, 3)) { // 只插入前3个作为测�?        try {
          await pool.query(`
            INSERT INTO k_alerts(symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at)
            VALUES ($1, date_trunc('minute', now()), $2, $3, $4, $5, $6, $7, 'amplitude_1pct', now())
            ON CONFLICT (symbol, bucket, rule_id) DO NOTHING
          `, [alert.symbol, alert.open, alert.high, alert.low, alert.close, alert.amplitude_pct, alert.direction]);
          console.log(`Inserted alert for ${alert.symbol}`);
        } catch (e) {
          console.error(`Failed to insert alert for ${alert.symbol}:`, e.message);
        }
      }
    }
    
    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testAlertSQL();