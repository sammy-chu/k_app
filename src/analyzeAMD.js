const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

async function analyzeAMDTrades() {
  try {
    // 设置搜索路径
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    
    // 查询AMD.BL�?0:44分钟内的所有交易记�?    const query = `
      SELECT 
        symbol,
        trade_time,
        received_at,
        price,
        size,
        condition
      FROM tos_trades 
      WHERE symbol = 'AMD.BL'
        AND received_at >= '2025-10-08 11:15:00+08'
        AND trade_time >= '11:15:00'
        AND trade_time < '11:16:00'
        AND COALESCE(size::numeric, 0) > 0
      ORDER BY received_at, trade_time;
    `;
    
    const result = await pool.query(query);
    const trades = result.rows;
    
    console.log(`=== AMD.BL �?11:15 分钟内的交易数据分析 ===`);
    console.log(`总交易记录数: ${trades.length}`);
    
    if (trades.length === 0) {
      console.log('该分钟内没有找到符合条件的交易记�?);
      return;
    }
    
    // 显示所有交易记�?    console.log('\n=== 交易记录详情 ===');
    trades.forEach((trade, index) => {
      console.log(`${index + 1}. 时间: ${trade.trade_time} | 接收: ${trade.received_at} | 价格: ${trade.price} | 数量: ${trade.size} | 条件: ${trade.condition || 'NULL'}`);
    });
    
    // 计算OHLC
    const prices = trades.map(t => parseFloat(t.price));
    const open = prices[0];
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const close = prices[prices.length - 1];
    
    console.log('\n=== OHLC数据 ===');
    console.log(`开盘价 (Open): ${open}`);
    console.log(`最高价 (High): ${high}`);
    console.log(`最低价 (Low): ${low}`);
    console.log(`收盘�?(Close): ${close}`);
    
    // 计算绝对幅度和百分比幅度
    const absoluteAmplitude = high - low;
    const percentageAmplitude = ((high - low) / low) * 100;
    
    console.log('\n=== 幅度分析 ===');
    console.log(`绝对幅度: ${absoluteAmplitude.toFixed(4)}`);
    console.log(`百分比幅�? ${percentageAmplitude.toFixed(4)}%`);
    
    // 计算涨跌�?    const priceChange = close - open;
    const priceChangePercent = ((close - open) / open) * 100;
    
    console.log('\n=== 涨跌分析 ===');
    console.log(`价格变动: ${priceChange.toFixed(4)}`);
    console.log(`涨跌�? ${priceChangePercent.toFixed(4)}%`);
    
    // 统计交易分布
    console.log('\n=== 交易分布统计 ===');
    const priceDistribution = {};
    trades.forEach(trade => {
      const price = parseFloat(trade.price);
      priceDistribution[price] = (priceDistribution[price] || 0) + 1;
    });
    
    console.log('价格分布:');
    Object.entries(priceDistribution)
      .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
      .forEach(([price, count]) => {
        console.log(`  ${price}: ${count}笔交易`);
      });
    
  } catch (error) {
    console.error('查询错误:', error);
  } finally {
    await pool.end();
  }
}

analyzeAMDTrades();