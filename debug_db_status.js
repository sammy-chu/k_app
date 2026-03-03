const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function checkDbStatus() {
  try {
    const client = await pool.connect();
    console.log('Connected to database successfully.');
    
    // Check active queries
    const res = await client.query(`
      SELECT 
        pid, 
        state, 
        now() - query_start as duration, 
        query 
      FROM pg_stat_activity 
      WHERE state != 'idle' 
        AND pid != pg_backend_pid()
      ORDER BY duration DESC;
    `);
    
    console.log('\n--- Active Queries ---');
    if (res.rows.length === 0) {
      console.log('No active queries.');
    } else {
      res.rows.forEach(row => {
        console.log(`PID: ${row.pid} | State: ${row.state} | Duration: ${JSON.stringify(row.duration)}`);
        console.log(`Query: ${row.query.substring(0, 200)}...`); // Truncate long queries
        console.log('------------------------');
      });
    }

    // Check connection count
    const countRes = await client.query(`
      SELECT count(*) as total_conns, state FROM pg_stat_activity GROUP BY state;
    `);
    console.log('\n--- Connection Counts ---');
    console.table(countRes.rows);

    client.release();
  } catch (err) {
    console.error('Error checking DB status:', err);
  } finally {
    await pool.end();
  }
}

checkDbStatus();
