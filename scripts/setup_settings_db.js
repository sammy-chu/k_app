const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function setupSettingsDb() {
  try {
    await pool.query('SET search_path TO market_data');

    console.log('1. Creating app_settings table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(50) PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        value_type VARCHAR(20) NOT NULL CHECK (value_type IN ('int', 'float', 'string', 'boolean')),
        min_value NUMERIC,
        max_value NUMERIC,
        updated_at TIMESTAMP DEFAULT now()
      );
    `);

    console.log('2. Creating settings_change_log table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings_change_log (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50) NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_at TIMESTAMP DEFAULT now(),
        changed_by VARCHAR(50) DEFAULT 'system'
      );
    `);

    console.log('3. Inserting default settings...');
    const defaultSettings = [
      {
        key: 'volume_history_days',
        value: '20',
        description: '计算均量的历史天数 (Volume History Days)',
        value_type: 'int',
        min_value: 5,
        max_value: 365
      },
      {
        key: 'volume_ratio_threshold',
        value: '1.5',
        description: '放量阈值 (Volume Ratio Threshold)',
        value_type: 'float',
        min_value: 1.0,
        max_value: 10.0
      },
      {
        key: 'volume_z_threshold',
        value: '2.0',
        description: 'Z-Score 阈值 (Z-Score Threshold)',
        value_type: 'float',
        min_value: 0.0,
        max_value: 10.0
      }
    ];

    for (const setting of defaultSettings) {
      await pool.query(`
        INSERT INTO app_settings (key, value, description, value_type, min_value, max_value)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (key) DO UPDATE SET
          description = EXCLUDED.description,
          value_type = EXCLUDED.value_type,
          min_value = EXCLUDED.min_value,
          max_value = EXCLUDED.max_value;
      `, [setting.key, setting.value, setting.description, setting.value_type, setting.min_value, setting.max_value]);
    }

    console.log('Settings database setup complete.');

  } catch (err) {
    console.error('Failed to setup settings db:', err);
  } finally {
    pool.end();
  }
}

setupSettingsDb();
