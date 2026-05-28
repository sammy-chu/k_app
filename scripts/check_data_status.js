const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkData() {
  try {
    await pool.query('SET search_path TO market_data');

    // 1. Check latest date in tos_daily_volume
    const resDate = await pool.query('SELECT MAX(trade_date) as max_date, COUNT(*) as count FROM tos_daily_volume');
    console.log('Latest tos_daily_volume:', resDate.rows[0]);

    // 2. Check today's data count (UTC)
    const today = new Date().toISOString().split('T')[0];
    const resToday = await pool.query('SELECT COUNT(*) FROM tos_daily_volume WHERE trade_date = $1::date', [today]);
    console.log(`Data count for today (${today}):`, resToday.rows[0].count);

    // 3. Check specific symbol example if exists
    const resSample = await pool.query('SELECT * FROM tos_daily_volume ORDER BY trade_date DESC LIMIT 5');
    console.table(resSample.rows);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkData();
