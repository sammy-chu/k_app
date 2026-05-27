const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkDuplicates() {
  try {
    await pool.query('SET search_path TO market_data');

    const sql = `
      SELECT symbol, bucket, rule_id, COUNT(*)
      FROM k_volume_alerts
      GROUP BY symbol, bucket, rule_id
      HAVING COUNT(*) > 1;
    `;
    const { rows } = await pool.query(sql);
    console.log('Duplicates found:', rows.length);
    if (rows.length > 0) {
      console.table(rows.slice(0, 10)); // Show first 10
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkDuplicates();
