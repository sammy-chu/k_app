const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function addUpdatedAt() {
  try {
    await pool.query('SET search_path TO market_data');

    console.log('Adding updated_at column...');
    await pool.query('ALTER TABLE k_volume_alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now()');

    // Initialize updated_at with created_at for existing rows
    await pool.query('UPDATE k_volume_alerts SET updated_at = created_at WHERE updated_at IS NULL');

    console.log('Done.');
  } catch (err) {
    console.error('Failed:', err);
  } finally {
    pool.end();
  }
}

addUpdatedAt();
