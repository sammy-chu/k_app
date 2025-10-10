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

// 提醒查询接口
app.get('/api/alerts', async (req, res) => {
  try {
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    const since = req.query.since || null;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    
    // 读取阈值（默认5000）
    const MIN_VOL = Number(process.env.DAILY_VOLUME_MIN ?? 5000);

    const sql = `
      WITH today AS (
        SELECT
          -- 以上海时区的当日开始/结束，转换为UTC以匹配库中时间列
          (date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'UTC') AS start_utc,
          ((date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) + interval '1 day') AT TIME ZONE 'UTC') AS end_utc,
          (now() AT TIME ZONE 'Asia/Shanghai')::date AS target_date
      ), vol AS (
        SELECT tr.symbol, SUM(tr.size) AS vol
        FROM tos_trades tr, today t
        WHERE tr.received_at >= t.start_utc AND tr.received_at < t.end_utc
          AND COALESCE(tr.size::numeric, 0) > 0
        GROUP BY tr.symbol
      )
      SELECT a.symbol, a.bucket, a.open, a.high, a.low, a.close, a.amplitude_pct, a.direction, a.rule_id, a.created_at
      FROM k_alerts a
      JOIN today t ON true
      JOIN vol v ON v.symbol = a.symbol
      WHERE ($1::timestamptz IS NULL OR a.created_at >= $1::timestamptz)
        AND a.bucket >= t.start_utc
        AND v.vol >= $2
      ORDER BY a.created_at DESC
      LIMIT $3
    `;
    const { rows } = await pool.query(sql, [since, MIN_VOL, limit]);
    res.json(rows);
  } catch (e) {
    console.error('alerts query failed:', e);
    res.status(500).json({ error: 'alerts query failed' });
  }
});

// Alert monitoring configuration and functions
const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || 0.01);
const DAILY_VOLUME_MIN = Number(process.env.DAILY_VOLUME_MIN || 5000);

async function scanAndInsertAlerts() {
  try {
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    // 扫描当前分钟与上一分钟，聚合 O/H/L/C 并触发提醒
    const sql = `
      /*
       * 统一使用本地时区（Asia/Shanghai）的 timestamp 类型进行分钟聚合，
       * 避免 timestamp 与 timestamptz 比较造成的分钟边界错位。
       */
      WITH params AS (
        SELECT 
          date_trunc('minute', (now() AT TIME ZONE 'Asia/Shanghai')) AS cur_bucket_local,
          date_trunc('minute', (now() AT TIME ZONE 'Asia/Shanghai')) - INTERVAL '1 minute' AS prev_bucket_local,
          (now() AT TIME ZONE 'Asia/Shanghai')::date AS target_date
      ),
      minute_trades AS (
        SELECT 
          t.symbol,
          /* 以 received_at 作为服务器收到时间并转换为上海时区的 timestamp */
          (t.received_at AT TIME ZONE 'Asia/Shanghai') AS ts_local,
          t.price::numeric AS price,
          /* 本地时间按分钟截断，得到该笔成交归属的分钟桶 */
          date_trunc('minute', (t.received_at AT TIME ZONE 'Asia/Shanghai')) AS bucket_local
        FROM tos_trades t
        WHERE t.price IS NOT NULL AND t.price::numeric > 0
          AND COALESCE(t.size::numeric, 0) > 0
          /* 使用 received_at 作为数据接收时间进行筛选 */
          AND date_trunc('minute', (t.received_at AT TIME ZONE 'Asia/Shanghai')) IN ((SELECT cur_bucket_local FROM params), (SELECT prev_bucket_local FROM params))
          /* 使用 trade_time 作为实际交易时间进行验证 - 确保交易时间在合理范围内 */
          AND (
            /* 如果 trade_time 包含完整日期时间格式 */
            (t.trade_time ~ '^\d{4}-\d{2}-\d{2}' AND 
             date_trunc('minute', t.trade_time::timestamp) IN ((SELECT cur_bucket_local FROM params), (SELECT prev_bucket_local FROM params)))
            OR
            /* 如果 trade_time 只包含时间部分，则与当前日期组合后验证 */
            (t.trade_time !~ '^\d{4}-\d{2}-\d{2}' AND 
             date_trunc('minute', ((SELECT target_date FROM params) || ' ' || t.trade_time)::timestamp) IN ((SELECT cur_bucket_local FROM params), (SELECT prev_bucket_local FROM params)))
          )
      ),
      agg AS (
        SELECT symbol, bucket_local AS bucket,
               MAX(price) AS high,
               MIN(price) AS low
        FROM minute_trades
        GROUP BY symbol, bucket_local
      ),
      open_close AS (
        SELECT a.symbol, a.bucket,
               (SELECT mt.price FROM minute_trades mt WHERE mt.symbol = a.symbol AND mt.bucket_local = a.bucket ORDER BY mt.ts_local ASC LIMIT 1) AS open,
               (SELECT mt.price FROM minute_trades mt WHERE mt.symbol = a.symbol AND mt.bucket_local = a.bucket ORDER BY mt.ts_local DESC LIMIT 1) AS close,
               a.high, a.low
        FROM agg a
      ),
      alerts AS (
        SELECT symbol,
               /* 插入时将本地分钟桶显式转换为 timestamptz（以 Asia/Shanghai 解释） */
               (bucket AT TIME ZONE 'Asia/Shanghai') AS bucket_tz,
               open, high, low, close,
               CASE WHEN open > 0 THEN (high - low) / open ELSE 0 END AS amplitude_pct,
               CASE WHEN close > open THEN 1 WHEN close < open THEN -1 ELSE 0 END AS direction
        FROM open_close
        WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
      )
      INSERT INTO k_alerts(symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at)
      SELECT symbol, bucket_tz, open, high, low, close, amplitude_pct, direction, 'amplitude_1pct', now()
      FROM alerts
      WHERE amplitude_pct >= $1
      ON CONFLICT (symbol, bucket, rule_id) DO NOTHING
      RETURNING symbol, bucket, amplitude_pct, direction;
    `;

    const { rows } = await pool.query(sql, [ALERT_THRESHOLD_PCT]);
    if (rows.length > 0) {
      console.log('Inserted alerts:', rows.length);
    }
  } catch (e) {
    console.error('scanAndInsertAlerts error:', e.message);
  }
}

function startAlertMonitor() {
  // 先立即跑一次，然后每 5 秒跑一次
  scanAndInsertAlerts();
  setInterval(scanAndInsertAlerts, 5000);
}

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

// 提醒页面路由
app.get('/alerts', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/alerts.html'));
});

// 在静态服务与监听之前启动监控（或在 listen 之后皆可）
startAlertMonitor();
console.log(`[ALERT monitor] starting, interval=5000ms, threshold=${(ALERT_THRESHOLD_PCT * 100).toFixed(1)}%`);
console.log(`[DAILY_VOLUME_MIN] configured threshold: ${DAILY_VOLUME_MIN}`);

const PORT = process.env.PORT || 8889;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));