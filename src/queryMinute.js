const { Pool } = require('pg');

(async () => {
  const symbol = process.argv[2] || 'TSM.BL';
  const ymd = process.argv[3] || '2025-10-08';
  const hm = process.argv[4] || '10:34'; // HH:MM without seconds

  const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'ppro8_market_data',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres'
  });

  try {
    await pool.query("SET search_path TO market_data");
    const res = await pool.query(
      `SELECT id, symbol, trade_time, price::numeric, size
       FROM tos_trades
       WHERE symbol=$1
         AND (
           (trade_time ~ '^[0-9]{4}-') -- full datetime stored
             AND trade_time::timestamp BETWEEN $2::timestamp AND ($2::timestamp + INTERVAL '1 minute' - INTERVAL '1 microsecond')
           OR (
             trade_time !~ '^[0-9]{4}-' -- time only stored
             AND ($3 || ' ' || trade_time)::timestamp BETWEEN $2::timestamp AND ($2::timestamp + INTERVAL '1 minute' - INTERVAL '1 microsecond')
           )
         )
       ORDER BY trade_time::text::text` ,
      [symbol, `${ymd} ${hm}:00`, ymd]
    );
    console.log(`Found ${res.rows.length} trades for ${symbol} in minute ${ymd} ${hm}`);
    console.table(res.rows);
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();