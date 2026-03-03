const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function fix() {
  try {
    await pool.query('SET search_path TO market_data');

    console.log('Fixing constraints on k_volume_alerts...');

    // 1. Add Primary Key on id
    try {
      await pool.query('ALTER TABLE k_volume_alerts ADD PRIMARY KEY (id)');
      console.log('Added PRIMARY KEY on id');
    } catch (e) {
      console.log('PRIMARY KEY on id might already exist or failed:', e.message);
    }

    // 2. Add UNIQUE constraint on (symbol, bucket, rule_id)
    try {
      await pool.query('ALTER TABLE k_volume_alerts ADD CONSTRAINT uq_vol_alerts_symbol_bucket_rule UNIQUE (symbol, bucket, rule_id)');
      console.log('Added UNIQUE constraint on (symbol, bucket, rule_id)');
    } catch (e) {
      console.log('UNIQUE constraint might already exist or failed:', e.message);
    }

  } catch (err) {
    console.error('Fix failed:', err);
  } finally {
    pool.end();
  }
}

fix();
