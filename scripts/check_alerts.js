const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkAlerts() {
  try {
    await pool.query('SET search_path TO market_data');

    const res = await pool.query(`
      SELECT * FROM k_volume_alerts 
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    
    console.table(res.rows);
    console.log(`Total rows found: ${res.rowCount}`);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkAlerts();
