const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function fixId() {
  try {
    await pool.query('SET search_path TO market_data');

    // 1. Create a sequence
    await pool.query('CREATE SEQUENCE IF NOT EXISTS k_volume_alerts_id_seq');

    // 2. Set default value for id
    await pool.query("ALTER TABLE k_volume_alerts ALTER COLUMN id SET DEFAULT nextval('k_volume_alerts_id_seq')");

    // 3. Update sequence value to max id (if any data exists)
    const maxRes = await pool.query('SELECT MAX(id) FROM k_volume_alerts');
    const maxId = maxRes.rows[0].max || 0;
    await pool.query(`SELECT setval('k_volume_alerts_id_seq', ${maxId})`);
    
    console.log(`Successfully fixed id column. Max ID was: ${maxId}`);

  } catch (err) {
    console.error('Failed to fix id:', err);
  } finally {
    pool.end();
  }
}

fixId();
