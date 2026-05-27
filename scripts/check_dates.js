const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkDateRange() {
  try {
    await pool.query('SET search_path TO market_data');

    // Check date distribution
    const res = await pool.query(`
      SELECT trade_date, COUNT(*) 
      FROM tos_daily_volume 
      GROUP BY trade_date 
      ORDER BY trade_date DESC 
      LIMIT 10
    `);
    console.table(res.rows);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkDateRange();
