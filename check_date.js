const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkDate() {
  try {
    await pool.query('SET search_path TO market_data');
    const res = await pool.query('SELECT MAX(trade_date) as max_date, COUNT(*) as count FROM tos_daily_volume');
    console.log('Latest trade date:', res.rows[0].max_date);
    console.log('Total records:', res.rows[0].count);
    
    // Check if there are any alerts for today
    const alerts = await pool.query("SELECT * FROM k_volume_alerts WHERE created_at::date = CURRENT_DATE");
    console.log('Alerts today:', alerts.rowCount);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkDate();
