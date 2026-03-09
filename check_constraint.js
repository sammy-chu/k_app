const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkConstraint() {
  try {
    await pool.query('SET search_path TO market_data');
    const res = await pool.query("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'app_settings_value_type_check'");
    if (res.rows.length > 0) {
        console.log('Constraint:', res.rows[0].pg_get_constraintdef);
    } else {
        console.log('Constraint not found');
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkConstraint();
