const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function checkTrades() {
  try {
    await pool.query('SET search_path TO market_data');
    
    const result = await pool.query('SELECT COUNT(*) as count FROM tos_trades');
    console.log('tos_trades table record count:', result.rows[0].count);
    
    const recent = await pool.query('SELECT symbol, trade_time, price FROM tos_trades ORDER BY id DESC LIMIT 10');
    console.log('Recent trades:', recent.rows);
    
    // 检查当前时间和最近一分钟的数据
    const now = new Date();
    console.log('Current time:', now.toISOString());
    
    const currentMinute = await pool.query(`
      SELECT symbol, trade_time, price 
      FROM tos_trades 
      WHERE trade_time LIKE '%' || to_char(now(), 'HH24:MI') || '%'
      ORDER BY id DESC LIMIT 5
    `);
    console.log('Current minute trades:', currentMinute.rows);
    
    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
  }
}

checkTrades();