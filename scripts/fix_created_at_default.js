const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function fixCreatedAt() {
  try {
    await pool.query('SET search_path TO market_data');

    console.log('1. Setting DEFAULT now() for created_at column...');
    await pool.query('ALTER TABLE k_volume_alerts ALTER COLUMN created_at SET DEFAULT now()');

    console.log('2. Backfilling NULL created_at values...');
    // For existing rows, we update created_at to now() if it's null. 
    // Ideally we would use the time of insertion, but we don't have it.
    // We can potentially use the 'bucket' time, but that's just the day start.
    // Let's just use now() for simplicity as these are recent alerts.
    const res = await pool.query(`
      UPDATE k_volume_alerts 
      SET created_at = now() 
      WHERE created_at IS NULL
    `);
    console.log(`Updated ${res.rowCount} rows.`);

  } catch (err) {
    console.error('Failed to fix created_at:', err);
  } finally {
    pool.end();
  }
}

fixCreatedAt();
