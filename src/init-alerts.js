const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// 数据库连接池配置
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function initAlerts() {
  try {
    console.log('正在连接数据库...');
    
    // 设置搜索路径
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    console.log('已设置搜索路径为 market_data');
    
    // 读取 SQL 文件
    const sqlPath = path.join(__dirname, 'sql', 'alerts.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log('已读取 SQL 文件:', sqlPath);
    
    // 执行 SQL
    await pool.query(sql);
    console.log('✅ k_alerts 表和索引创建成功');
    
    // 验证表是否创建成功
    const result = await pool.query('SELECT COUNT(*) FROM market_data.k_alerts');
    console.log('✅ 验证查询成功，当前记录数:', result.rows[0].count);
    
  } catch (error) {
    console.error('❌ 初始化失败:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('数据库连接已关闭');
  }
}

initAlerts();