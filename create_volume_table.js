const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function createTable() {
  try {
    await pool.query('SET search_path TO market_data');
    const sql = `
      CREATE TABLE IF NOT EXISTS k_volume_alerts (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        bucket TIMESTAMP NOT NULL,
        volume_ratio NUMERIC NOT NULL,
        current_cum_vol NUMERIC,
        avg_daily_vol NUMERIC,
        created_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT uq_vol_alerts_symbol_bucket UNIQUE (symbol, bucket)
      );
    `;
    await pool.query(sql);
    console.log('Table k_volume_alerts created successfully');
  } catch (err) {
    console.error('Error creating table:', err);
  } finally {
    pool.end();
  }
}

createTable();