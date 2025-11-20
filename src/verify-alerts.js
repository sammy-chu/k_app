const { Pool } = require('pg');

// 数据库连接池配置
const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function verifyAlerts() {
  try {
    console.log('正在验证 k_alerts �?..');
    
    // 设置搜索路径
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    
    // 1. 验证表存�?    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'market_data' AND table_name = 'k_alerts'
    `);
    console.log('�?表存在检�?', tableCheck.rows.length > 0 ? '通过' : '失败');
    
    // 2. 验证表结�?    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_schema = 'market_data' AND table_name = 'k_alerts'
      ORDER BY ordinal_position
    `);
    console.log('�?表结�?');
    columns.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? 'NOT NULL' : ''} ${col.column_default || ''}`);
    });
    
    // 3. 验证索引
    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes 
      WHERE schemaname = 'market_data' AND tablename = 'k_alerts'
    `);
    console.log('�?索引:');
    indexes.rows.forEach(idx => {
      console.log(`  - ${idx.indexname}`);
    });
    
    // 4. 验证唯一约束
    const constraints = await pool.query(`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints 
      WHERE table_schema = 'market_data' AND table_name = 'k_alerts'
    `);
    console.log('�?约束:');
    constraints.rows.forEach(con => {
      console.log(`  - ${con.constraint_name}: ${con.constraint_type}`);
    });
    
    // 5. 测试基本查询
    const countResult = await pool.query('SELECT COUNT(*) FROM market_data.k_alerts');
    console.log('�?基本查询测试: COUNT(*) =', countResult.rows[0].count);
    
    console.log('\n🎉 所有验证通过！k_alerts 表已成功创建并可正常使用�?);
    
  } catch (error) {
    console.error('�?验证失败:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyAlerts();