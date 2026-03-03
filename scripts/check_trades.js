const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkTrades() {
  try {
    await pool.query('SET search_path TO market_data');

    const res = await pool.query('SELECT MIN(received_at), MAX(received_at), COUNT(*) FROM tos_trades');
    console.log('tos_trades range:', res.rows[0]);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkTrades();
