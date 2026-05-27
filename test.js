const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});
pool.query(`
EXPLAIN ANALYZE SELECT s.symbol, t.price::numeric AS price, t.received_at
FROM market_data.daily_summary s
CROSS JOIN LATERAL (
  SELECT price, received_at
  FROM market_data.tos_trades
  WHERE symbol = s.symbol
    AND received_at >= NOW() - INTERVAL '12 hours'
  ORDER BY received_at DESC, id DESC
  LIMIT 1
) t
WHERE s.trade_date = current_date
  AND s.open_price > 0
`).then(res => { console.log(res.rows.map(r => r['QUERY PLAN']).join('\n')); pool.end(); }).catch(err => { console.error(err); pool.end(); });
