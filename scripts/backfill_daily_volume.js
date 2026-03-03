const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function backfill() {
  try {
    await pool.query('SET search_path TO market_data');

    console.log('Starting backfill of tos_daily_volume from tos_trades...');

    // Backfill last 60 days
    const sql = `
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol, DATE(received_at) as trade_date, SUM(size) as daily_volume, now()
      FROM tos_trades
      WHERE received_at >= (now() - INTERVAL '60 days')
      GROUP BY symbol, DATE(received_at)
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = EXCLUDED.daily_volume, updated_at = now();
    `;

    const start = Date.now();
    const res = await pool.query(sql);
    const duration = Date.now() - start;

    console.log(`Backfill completed in ${duration}ms.`);
    console.log(`Inserted/Updated rows: ${res.rowCount}`);

  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    pool.end();
  }
}

backfill();
