const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function fixAlerts() {
  try {
    await pool.query('SET search_path TO market_data');
    
    // 0. Update constraint to allow 'json'
    try {
        await pool.query('ALTER TABLE app_settings DROP CONSTRAINT app_settings_value_type_check');
        await pool.query("ALTER TABLE app_settings ADD CONSTRAINT app_settings_value_type_check CHECK (value_type IN ('int', 'float', 'string', 'boolean', 'json'))");
        console.log('Updated app_settings_value_type_check constraint');
    } catch (e) {
        console.log('Constraint update skipped or failed:', e.message);
    }
    
    // 1. Insert time_checkpoints if not exists
    const checkpoints = [
      { elapsed_minutes: 120, expected_pct: 0.30, label: "开市2小时" }, 
      { elapsed_minutes: 180, expected_pct: 0.50, label: "开市3小时" }, 
      { elapsed_minutes: 240, expected_pct: 0.75, label: "收盘前" }
    ];
    
    await pool.query(`
      INSERT INTO app_settings (key, value, value_type, description, updated_at)
      VALUES ('time_checkpoints', $1, 'json', 'Time checkpoints for volume alerts', now())
      ON CONFLICT (key) DO UPDATE 
      SET value = EXCLUDED.value, updated_at = now()
    `, [JSON.stringify(checkpoints)]);
    
    console.log('Inserted time_checkpoints into app_settings');

    // 2. Delete old volume_surge alerts to clear confusion
    // Keep only alerts with rule_id starting with 'checkpoint_'
    // Or just delete all if user wants a clean slate. 
    // Given the confusion, deleting all is safer, as new logic will regenerate valid ones.
    const res = await pool.query(`DELETE FROM k_volume_alerts WHERE rule_id NOT LIKE 'checkpoint_%'`);
    console.log(`Deleted ${res.rowCount} old alerts (volume_surge/shrink)`);

    // 3. Verify
    const settings = await pool.query("SELECT * FROM app_settings WHERE key = 'time_checkpoints'");
    console.log('Current settings:', settings.rows[0]);

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

fixAlerts();
