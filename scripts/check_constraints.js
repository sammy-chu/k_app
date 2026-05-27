const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function check() {
  try {
    await pool.query('SET search_path TO market_data');

    // Check tables
    const tableSql = `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'market_data' AND tablename IN ('k_volume_alerts', 'tos_daily_volume');
    `;
    const tables = await pool.query(tableSql);
    console.log('Tables:');
    console.table(tables.rows);

    // Check constraints
    const conSql = `
      SELECT conname, conrelid::regclass, contype, pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid::regclass::text IN ('market_data.k_volume_alerts', 'market_data.tos_daily_volume', 'k_volume_alerts', 'tos_daily_volume');
    `;
    const cons = await pool.query(conSql);
    console.log('Constraints:');
    console.table(cons.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

check();
