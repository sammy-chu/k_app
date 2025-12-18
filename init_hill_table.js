const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function createTable() {
  try {
    const client = await pool.connect();
    console.log('Connected to database.');
    
    const sql = `
      CREATE TABLE IF NOT EXISTS k_hill_alerts (
          id SERIAL PRIMARY KEY,
          symbol TEXT NOT NULL,
          bucket_time TIMESTAMPTZ NOT NULL,
          volume NUMERIC NOT NULL,
          baseline_volume NUMERIC NOT NULL,
          breakout_ratio NUMERIC NOT NULL,
          hill_data JSONB,
          open NUMERIC,
          high NUMERIC,
          low NUMERIC,
          close NUMERIC,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          CONSTRAINT uniq_hill_alert UNIQUE(symbol, bucket_time)
      );
      
      COMMENT ON TABLE k_hill_alerts IS 'Stores volume breakout alerts (hill patterns)';
      COMMENT ON COLUMN k_hill_alerts.bucket_time IS 'Candle time (start of minute)';
      COMMENT ON COLUMN k_hill_alerts.breakout_ratio IS 'Volume / Baseline ratio';
    `;
    
    await client.query(sql);
    console.log('Table k_hill_alerts created or already exists.');
    
    client.release();
  } catch (err) {
    console.error('Error creating table:', err);
  } finally {
    await pool.end();
  }
}

createTable();
