const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function clearAlerts() {
  try {
    await pool.query('SET search_path TO market_data');
    
    // Clear ALL volume alerts to avoid confusion between "underperformance" and "achievement" alerts
    // Since rule_id format is the same (checkpoint_120min_30pct), we can't distinguish them by ID.
    // We must clear them so new scans generate correct "achievement" alerts.
    const res = await pool.query(`DELETE FROM k_volume_alerts WHERE rule_id LIKE 'checkpoint_%'`);
    console.log(`Deleted ${res.rowCount} checkpoint alerts`);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

clearAlerts();
