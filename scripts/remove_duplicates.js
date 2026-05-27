const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

async function removeDuplicates() {
  try {
    await pool.query('SET search_path TO market_data');

    const sql = `
      DELETE FROM k_volume_alerts a
      USING k_volume_alerts b
      WHERE a.id < b.id
        AND a.symbol = b.symbol
        AND a.bucket = b.bucket
        AND a.rule_id = b.rule_id;
    `;
    const res = await pool.query(sql);
    console.log(`Deleted ${res.rowCount} duplicate rows.`);

    // Now try to add the constraint again
    try {
      await pool.query('ALTER TABLE k_volume_alerts ADD CONSTRAINT uq_vol_alerts_symbol_bucket_rule UNIQUE (symbol, bucket, rule_id)');
      console.log('Successfully added UNIQUE constraint on (symbol, bucket, rule_id)');
    } catch (e) {
      console.error('Failed to add constraint:', e.message);
    }

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

removeDuplicates();
