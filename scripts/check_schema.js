const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkSchema() {
  try {
    await pool.query('SET search_path TO market_data');

    // Get column details
    const res = await pool.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'market_data'
        AND table_name = 'k_volume_alerts'
    `);
    console.table(res.rows);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkSchema();
