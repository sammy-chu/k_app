const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function runSql(filePath) {
  try {
    const sql = fs.readFileSync(filePath, 'utf8');
    console.log(`Executing ${filePath}...`);
    await pool.query(sql);
    console.log(`Successfully executed ${filePath}`);
  } catch (err) {
    console.error(`Error executing ${filePath}:`, err);
    // Don't throw, try next one? Or stop?
    // Some might fail if already exists (though IF NOT EXISTS should handle it)
    // 003 might fail if 001 didn't run.
  }
}

async function setup() {
  try {
    await pool.query('SET search_path TO market_data');

    // 1. Create k_volume_alerts (from create_volume_table.js)
    console.log('Creating k_volume_alerts table...');
    const createVolumeTableSql = `
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
    await pool.query(createVolumeTableSql);
    console.log('k_volume_alerts table created (or exists).');

    // 2. Run SQL files
    const sqlFiles = [
      path.join(__dirname, '../src/sql/schema/002_tos_daily_volume.sql'),
      path.join(__dirname, '../src/sql/schema/003_volume_alerts_rule_id.sql'),
      path.join(__dirname, '../src/sql/alerts.sql')
    ];

    for (const file of sqlFiles) {
      if (fs.existsSync(file)) {
        await runSql(file);
      } else {
        console.warn(`File not found: ${file}`);
      }
    }

    console.log('Database setup completed.');
  } catch (err) {
    console.error('Setup failed:', err);
  } finally {
    pool.end();
  }
}

setup();
