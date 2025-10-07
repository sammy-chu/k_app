const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();

// 数据库连接池配置
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// OHLCV API 路由
app.get('/api/ohlcv', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const date = String(req.query.date || '').trim();
    if (!symbol || !date) return res.status(400).json({ error: 'symbol and date required' });
    
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    const sql = `
      WITH params AS (
        SELECT $1::text AS symbol,
               $2::text AS target_date
      ),
      filtered AS (
        SELECT t.symbol, 
               CASE 
                 WHEN t.trade_time ~ '^\d{4}-\d{2}-\d{2}' THEN t.trade_time::timestamp
                 ELSE (p.target_date || ' ' || t.trade_time)::timestamp
               END AS ts,
               t.price::numeric AS price, 
               t.size,
               CASE 
                 WHEN t.trade_time ~ '^\d{4}-\d{2}-\d{2}' THEN date_trunc('minute', t.trade_time::timestamp)
                 ELSE date_trunc('minute', (p.target_date || ' ' || t.trade_time)::timestamp)
               END AS bucket
        FROM tos_trades t
        JOIN params p ON p.symbol = t.symbol
        WHERE (
          (t.trade_time ~ '^\d{4}-\d{2}-\d{2}' AND LEFT(t.trade_time, 10) = p.target_date) OR
          (t.trade_time !~ '^\d{4}-\d{2}-\d{2}' AND DATE(t.created_at) = p.target_date::date)
        )
          AND t.price IS NOT NULL
          AND t.price::numeric > 0
      ),
      open_price AS (
        SELECT DISTINCT ON (bucket) bucket, price AS open
        FROM filtered
        ORDER BY bucket, ts ASC
      ),
      close_price AS (
        SELECT DISTINCT ON (bucket) bucket, price AS close
        FROM filtered
        ORDER BY bucket, ts DESC
      ),
      hlv AS (
        SELECT bucket,
               MAX(price) AS high,
               MIN(price) AS low,
               COALESCE(SUM(size), 0) AS volume
        FROM filtered
        GROUP BY bucket
      ),
      ohlcv AS (
        SELECT h.bucket, o.open, h.high, h.low, c.close, h.volume
        FROM hlv h
        LEFT JOIN open_price o USING (bucket)
        LEFT JOIN close_price c USING (bucket)
      ),
      day_range AS (
        SELECT MIN(bucket) AS day_start,
               MAX(bucket) + INTERVAL '1 minute' AS day_end
        FROM ohlcv
      ),
      series AS (
        SELECT generate_series(dr.day_start, dr.day_end - INTERVAL '1 minute', INTERVAL '1 minute') AS bucket
        FROM day_range dr
        WHERE dr.day_start IS NOT NULL
      ),
      joined AS (
        SELECT s.bucket,
               o.open, o.high, o.low, o.close, o.volume
        FROM series s
        LEFT JOIN ohlcv o USING (bucket)
        ORDER BY s.bucket
      )
      SELECT bucket AS t,
             COALESCE(open, LAG(close) OVER (ORDER BY bucket)) AS o,
             COALESCE(high, COALESCE(open, LAG(close) OVER (ORDER BY bucket))) AS h,
             COALESCE(low,  COALESCE(open, LAG(close) OVER (ORDER BY bucket))) AS l,
             COALESCE(close, LAG(close) OVER (ORDER BY bucket)) AS c,
             COALESCE(volume, 0) AS v
      FROM joined
      WHERE bucket IS NOT NULL;`;

    const { rows } = await pool.query(sql, [symbol, date]);
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// 数据库测试路由
app.get('/api/test-db', async (req, res) => {
  try {
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    
    // 测试表是否存在
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = $1 AND table_name = 'tos_trades'
    `, [process.env.PGSCHEMA || 'market_data']);
    
    if (tableCheck.rows.length === 0) {
      return res.json({ error: 'tos_trades table not found', schema: process.env.PGSCHEMA || 'market_data' });
    }
    
    // 获取表结构
    const columns = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = $1 AND table_name = 'tos_trades'
      ORDER BY ordinal_position
    `, [process.env.PGSCHEMA || 'market_data']);
    
    // 获取样本数据
    const sample = await pool.query('SELECT * FROM tos_trades LIMIT 3');
    
    return res.json({
      table_exists: true,
      columns: columns.rows,
      sample_data: sample.rows,
      row_count: sample.rowCount
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'database_error', message: e.message });
  }
});

app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));