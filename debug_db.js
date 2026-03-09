const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function checkSettings() {
  try {
    await pool.query('SET search_path TO market_data');
    const res = await pool.query('SELECT * FROM app_settings');
    console.log('Settings count:', res.rowCount);
    res.rows.forEach(row => {
        console.log(`Key: ${row.key}, Type: ${row.value_type}, Value: ${row.value}`);
    });
    
    // Check volume alerts
    const alerts = await pool.query('SELECT * FROM k_volume_alerts ORDER BY created_at DESC LIMIT 5');
    console.log('\nRecent Volume Alerts:');
    alerts.rows.forEach(row => {
        console.log(`Symbol: ${row.symbol}, Rule: ${row.rule_id}, Ratio: ${row.volume_ratio}, Created: ${row.created_at}`);
    });

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

checkSettings();
