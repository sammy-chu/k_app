const express = require('express');
const fs = require('fs');
// const compression = require('compression'); // Temporarily disabled for debugging
const path = require('path');
const { Pool } = require('pg');
const { getFlexibleHills } = require('./scan-flexible-hills');
const ConfigManager = require('./config-manager');
const app = express();

// app.use(compression());

// Enable CORS for development/preview
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 全局配置变量

// 数据库连接池配置
const pgSchema = process.env.PGSCHEMA || 'market_data';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 20, // Increase pool size to handle concurrent background tasks + API requests
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Fail fast if no connection available
  statement_timeout: 30000,
});

// Set search_path on every new connection so all queries use the correct schema
pool.on('connect', (client) => {
  client.query('SET search_path TO ' + pgSchema);
});

// Handle idle client errors so they don't crash the node process
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err.message);
});

// Initialize ConfigManager
const config = new ConfigManager(pool);

async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO ' + pgSchema);
    
    // k_alerts
    await client.query(`
      CREATE TABLE IF NOT EXISTS k_alerts (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        open NUMERIC,
        high NUMERIC,
        low NUMERIC,
        close NUMERIC,
        amplitude_pct NUMERIC,
        direction INTEGER,
        rule_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_k_alerts_unique ON k_alerts (symbol, bucket, rule_id);
    `);

    // k_volume_alerts
    await client.query(`
      CREATE TABLE IF NOT EXISTS k_volume_alerts (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        volume_ratio NUMERIC,
        current_cum_vol NUMERIC,
        avg_daily_vol NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        rule_id TEXT NOT NULL DEFAULT 'volume_surge',
        updated_at TIMESTAMPTZ,
        current_price NUMERIC,
        prev_price NUMERIC,
        price_change_val NUMERIC,
        price_note TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_k_vol_alerts_unique ON k_volume_alerts (symbol, bucket, rule_id);
    `);

    // tos_daily_volume (if not exists)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tos_daily_volume (
        symbol TEXT NOT NULL,
        trade_date DATE NOT NULL,
        daily_volume NUMERIC,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_date)
      );
    `);
    
    // daily_summary (if not exists)
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_summary (
        symbol TEXT NOT NULL,
        trade_date DATE NOT NULL,
        open_price NUMERIC,
        close_price NUMERIC,
        high_price NUMERIC,
        low_price NUMERIC,
        total_volume NUMERIC,
        PRIMARY KEY (symbol, trade_date)
      );
    `);
    
    // k_hill_alerts (if not exists, based on usage in server.js)
    await client.query(`
      CREATE TABLE IF NOT EXISTS k_hill_alerts (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        bucket_time TIMESTAMPTZ NOT NULL,
        volume NUMERIC,
        baseline_volume NUMERIC,
        breakout_ratio NUMERIC,
        hill_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uniq_hill_alert UNIQUE(symbol, bucket_time)
      );
    `);

    // app_settings (if not exists)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        value_type TEXT,
        description TEXT,
        min_value NUMERIC,
        max_value NUMERIC,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS settings_change_log (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // tos_trades indexes for ranking and daily summary queries
    // Use a longer timeout for index creation on large tables
    await client.query('SET statement_timeout = 300000'); // 5 minutes for DDL
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tos_trades_symbol_received ON tos_trades (symbol, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tos_trades_received ON tos_trades (received_at DESC);
    `);

    // Index on daily_summary(trade_date) to speed up date-range ranking queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_summary_trade_date ON daily_summary (trade_date);
    `);
    await client.query('SET statement_timeout = 30000'); // restore default

    console.log('Tables ensured');
  } catch (err) {
    console.error('Error ensuring tables:', err);
  } finally {
    client.release();
  }
}

// Load ETF exclusion list
let etfList = [];
try {
  const etfPath = path.join(__dirname, '../ETF.csv');
  if (fs.existsSync(etfPath)) {
    const etfContent = fs.readFileSync(etfPath, 'utf-8');
    etfList = etfContent.split(/\r?\n/).map(line => line.trim()).filter(line => line);
    console.log(`Loaded ${etfList.length} ETFs from ETF.csv`);
  } else {
    console.warn('ETF.csv not found, skipping ETF exclusion');
  }
} catch (err) {
  console.error('Failed to load ETF.csv:', err.message);
}

// In-memory price snapshot cache: symbol -> { price, receivedAt }
// Updated every 30s by background task, used by ranking API to avoid slow tos_trades scans
const priceCache = new Map();

async function updatePriceCache() {
  try {

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (symbol) symbol, price::numeric AS price, received_at
      FROM tos_trades
      WHERE received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
      ORDER BY symbol, received_at DESC
    `);
    for (const row of rows) {
      priceCache.set(row.symbol, { price: Number(row.price), receivedAt: row.received_at });
    }
  } catch (err) {
    console.error('[PriceCache] Update failed:', err.message);
  }
}

// Sliding 3-minute price window: symbol -> array of { price, receivedAt } sorted oldest-first
const priceWindow = new Map();

async function updatePriceWindow() {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 10000'); // 10s timeout
    const { rows } = await client.query(`
      SELECT symbol, price::numeric AS price, received_at
      FROM tos_trades
      WHERE received_at >= NOW() - INTERVAL '4 minutes'
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
      ORDER BY symbol, received_at ASC
    `);
    priceWindow.clear();
    for (const row of rows) {
      if (!priceWindow.has(row.symbol)) priceWindow.set(row.symbol, []);
      priceWindow.get(row.symbol).push({ price: Number(row.price), receivedAt: new Date(row.received_at) });
    }
  } catch (err) {
    console.error('[PriceWindow] Update failed:', err.message);
  } finally {
    // 务必重置连接的超时时间，以免污染连接池中的连接
    await client.query('SET statement_timeout = 0').catch(e => console.error(e));
    client.release();
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// 轻量级价格快照 API
app.get('/api/price-snapshot', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const minutes = Number(req.query.minutes || 5);
    
    if (!symbol) return res.status(400).json({ error: 'symbol required' });



    // 1. 获取最新价格
    // 使用 received_at 替代 trade_time，因为 trade_time 是文本格式且不包含日期，无法准确排序/比较
    const currentRes = await pool.query(`
      SELECT price::numeric 
      FROM tos_trades 
      WHERE symbol = $1 
      ORDER BY received_at DESC 
      LIMIT 1
    `, [symbol]);

    // 2. 获取 N 分钟前的价格
    const prevRes = await pool.query(`
      SELECT price::numeric 
      FROM tos_trades 
      WHERE symbol = $1 
        AND received_at <= (now() AT TIME ZONE 'Asia/Shanghai' - ($2 || ' minutes')::interval)
      ORDER BY received_at DESC 
      LIMIT 1
    `, [symbol, minutes]);

    const current = currentRes.rows.length > 0 ? Number(currentRes.rows[0].price) : 0;
    const previous = prevRes.rows.length > 0 ? Number(prevRes.rows[0].price) : 0;
    
    // 如果没有历史数据，change 为 0
    const change = (current && previous) ? Number((current - previous).toFixed(2)) : 0;

    return res.json({
      current,
      previous,
      change
    });

  } catch (e) {
    console.error('price-snapshot error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// OHLCV API 路由
app.get('/api/ohlcv', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const date = String(req.query.date || '').trim();
    if (!symbol || !date) return res.status(400).json({ error: 'symbol and date required' });
    


    const sql = `
      WITH params AS (
        SELECT $1::text AS symbol,
               $2::text AS target_date
      ),
      filtered AS (
        SELECT t.symbol, 
               CASE 
                 WHEN trim(t.trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(t.trade_time)::timestamp
                 ELSE (p.target_date || ' ' || trim(t.trade_time))::timestamp
               END AS ts,
               t.price::numeric AS price, 
               t.size,
               CASE 
                 WHEN trim(t.trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN date_trunc('minute', trim(t.trade_time)::timestamp)
                 ELSE date_trunc('minute', (p.target_date || ' ' || trim(t.trade_time))::timestamp)
               END AS bucket
        FROM tos_trades t
        JOIN params p ON p.symbol = t.symbol
        WHERE (
          (trim(t.trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND LEFT(trim(t.trade_time), 10) = p.target_date) OR
          (trim(t.trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND DATE(t.created_at) = p.target_date::date)
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
      ),
      -- 使用分组计数法实现 LOCF (Last Observation Carried Forward) 以填补收盘价空洞
      locf_grp AS (
        SELECT *,
               COUNT(close) OVER (ORDER BY bucket) as grp
        FROM joined
      ),
      filled_data AS (
        SELECT 
          bucket,
          open, high, low,
          COALESCE(volume, 0) as v,
          FIRST_VALUE(close) OVER (PARTITION BY grp ORDER BY bucket) as c_filled
        FROM locf_grp
      ),
      final_ohlc AS (
        SELECT 
          bucket AS t,
          -- 如果没有开盘价，沿用上一分钟的收盘价
          COALESCE(open, LAG(c_filled) OVER (ORDER BY bucket)) AS o,
          COALESCE(high, COALESCE(open, LAG(c_filled) OVER (ORDER BY bucket))) AS h,
          COALESCE(low,  COALESCE(open, LAG(c_filled) OVER (ORDER BY bucket))) AS l,
          c_filled AS c,
          v
        FROM filled_data
      )
      SELECT 
        t, o, h, l, c, v,
        ROUND(AVG(c) OVER (ORDER BY t ROWS BETWEEN 4 PRECEDING AND CURRENT ROW), 2) AS ma5,
        ROUND(AVG(c) OVER (ORDER BY t ROWS BETWEEN 9 PRECEDING AND CURRENT ROW), 2) AS ma10,
        ROUND(AVG(c) OVER (ORDER BY t ROWS BETWEEN 19 PRECEDING AND CURRENT ROW), 2) AS ma20
      FROM final_ohlc
      WHERE t IS NOT NULL;`;

    const { rows } = await pool.query(sql, [symbol, date]);
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// === Settings API ===
app.get('/api/settings', async (req, res) => {
  const settings = await config.getAllSettings();
  res.json(settings);
});

app.put('/api/settings/:key', express.json(), async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const changedBy = req.query.user || 'admin'; // In real app, get from auth token

    const result = await config.update(key, value, changedBy);
    
    // If volume parameters changed, we might want to trigger a scan immediately?
    // For now, let's just return success.
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/settings/trigger-volume-scan', async (req, res) => {
    try {
        console.log('[API] Triggering manual volume scan...');
        // We run it asynchronously to not block the response
        scanAllVolumeAlerts().catch(err => console.error('Manual scan failed:', err));
        res.json({ message: 'Volume scan triggered in background.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to trigger scan' });
    }
});


// 数据库测试路�?
app.get('/api/test-db', async (req, res) => {
  try {

    
    // 测试表是否存�?
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = $1 AND table_name = 'tos_trades'
    `, [process.env.PGSCHEMA || 'market_data']);
    
    if (tableCheck.rows.length === 0) {
      return res.json({ error: 'tos_trades table not found', schema: process.env.PGSCHEMA || 'market_data' });
    }
    
    // 获取表结�?
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

    const since = req.query.since || null;
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const ruleId = req.query.rule_id || 'amplitude_1pct';

    const sql = `
      SELECT symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at
      FROM k_alerts
      WHERE rule_id = $3
        AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(sql, [since, limit, ruleId]);
    res.json(rows);
  } catch (e) {
    console.error('alerts query failed:', e);
    res.status(500).json({ error: 'alerts query failed' });
  }
});

// === Ranking 缓存 ===
let rankingCache = [];       // 缓存的 ranking 行数据
let rankingCacheTime = null; // 上次成功刷新时间

async function refreshRankingCache() {
  const safeEtfList = etfList.length > 0 ? etfList : ['__NO_ETF__'];
  const sql = `
    WITH avg_vol AS (
      SELECT symbol, AVG(total_volume) AS avg_vol
      FROM market_data.daily_summary
      WHERE trade_date >= current_date - 10
        AND trade_date < current_date
      GROUP BY symbol
      HAVING AVG(total_volume) >= 1000
    ),
    today AS (
      SELECT symbol, open_price, total_volume
      FROM market_data.daily_summary
      WHERE trade_date = current_date
    ),
    latest_trades AS (
      SELECT DISTINCT ON (symbol) symbol, price AS last_price
      FROM tos_trades
      WHERE received_at >= current_date
      ORDER BY symbol, received_at DESC
    )
    SELECT
      t.symbol,
      t.open_price,
      lt.last_price,
      (lt.last_price - t.open_price) AS change_amount,
      ROUND((lt.last_price - t.open_price) / NULLIF(t.open_price, 0) * 100, 2) AS change_pct,
      t.total_volume,
      COALESCE(ROUND(a.avg_vol), 0) AS avg_vol_10d
    FROM today t
    JOIN latest_trades lt USING (symbol)
    LEFT JOIN avg_vol a USING (symbol)
    WHERE NOT (t.symbol = ANY($1::text[]))
      AND t.open_price > 0
    ORDER BY (lt.last_price - t.open_price) DESC;
  `;
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 120000');
    const { rows } = await client.query(sql, [safeEtfList]);
    rankingCache = rows;
    rankingCacheTime = new Date();
    if (rows.length === 0) {
      const diag = await client.query(`
        SELECT current_date AS db_date,
               MIN(trade_date) AS min_date, MAX(trade_date) AS max_date, COUNT(*) AS total
        FROM market_data.daily_summary
      `);
      console.log(`[RankingCache] 0 rows returned. DB current_date=${diag.rows[0].db_date}, data range: ${diag.rows[0].min_date} ~ ${diag.rows[0].max_date}, total=${diag.rows[0].total}`);
    } else {
      console.log(`[RankingCache] Refreshed, ${rows.length} rows`);
    }
  } finally {
    await client.query('SET statement_timeout = 0').catch(e => console.error(e));
    client.release();
  }
}

// 排行榜 API — 直接返回缓存数据
app.get('/api/ranking', (req, res) => {
  try {
    const minVolume = Number(req.query.min_volume || 0);
    const minPriceChange3m = Number(req.query.min_price_change_3m || 0);

    // Filter cached data by request params
    const now = new Date();
    const cutoff = new Date(now.getTime() - 3 * 60 * 1000);

    const result = rankingCache
      .filter(row => Number(row.total_volume) >= minVolume)
      .map(row => {
        const window = priceWindow.get(row.symbol);
        let price_change_3m = 0;
        if (window && window.length > 0) {
          const lastEntry = window[window.length - 1];
          if (lastEntry.receivedAt >= cutoff) {
            const entry3m = window.find(e => e.receivedAt <= cutoff);
            if (entry3m) {
              const base = entry3m.price;
              price_change_3m = Number(row.last_price) - base;
            }
            // If entry3m is not found, price_change_3m remains 0
          }
        }
        return { ...row, price_change_3m };
      });

    const filteredRows = result.filter(row => {
      if (minPriceChange3m > 0) {
        return Math.abs(Number(row.price_change_3m)) >= minPriceChange3m;
      }
      return true;
    });

    res.json(filteredRows);
  } catch (e) {
    console.error('ranking query failed:', e);
    res.status(500).json({ error: 'ranking query failed' });
  }
});

// === 大单监控筛选器 API ===
app.get('/api/large-orders-screener', async (req, res) => {
  try {
    const minOrderVolume = Number(req.query.min_order_volume || 1000);
    const timeWindowMins = Number(req.query.time_window_mins || 5);
    const safeEtfList = etfList.length > 0 ? etfList : ['__NO_ETF__'];

    const sql = `
      WITH recent_large_orders AS (
        SELECT DISTINCT ON (stock_code, side)
            stock_code AS symbol, side, level, price AS order_price, volume AS order_volume, detected_at
        FROM market_data.l2_large_orders_bl
        WHERE detected_at >= NOW() - ($1 || ' minutes')::interval
          AND volume >= $2
        ORDER BY stock_code, side, detected_at DESC
      )
      SELECT o.symbol, o.side, o.level, o.order_price, o.order_volume, o.detected_at,
             d.open_price, d.close_price, d.total_volume
      FROM recent_large_orders o
      JOIN market_data.daily_summary d ON o.symbol = d.symbol
      WHERE d.trade_date = CURRENT_DATE
        AND NOT (o.symbol = ANY($3::text[]))
      ORDER BY o.detected_at DESC
      LIMIT 100
    `;

    const { rows } = await pool.query(sql, [timeWindowMins, minOrderVolume, safeEtfList]);
    
    // Inject latest price from memory cache (priceWindow)
    const result = rows.map(row => {
      const window = priceWindow.get(row.symbol);
      let currentPrice = row.close_price; // Fallback to close_price
      if (window && window.length > 0) {
        // Get the latest trade price from the memory window
        currentPrice = window[window.length - 1].price;
      }
      return { ...row, current_price: currentPrice };
    });

    res.json(result);
  } catch (e) {
    console.error('Large orders screener error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// === 山丘形放量查询 API (Flexible Hills) ===
app.get('/api/patterns/flexible-hills', async (req, res) => {
  try {
    const dateQuery = req.query.date;
    const result = await getFlexibleHills(pool, dateQuery);
    res.json(result);
  } catch (e) {
    console.error('flexible-hills query failed:', e);
    res.status(500).json({ error: 'query failed' });
  }
});

// === K Hill Alerts 查询 API (Database) ===
app.get('/api/hill-alerts', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const minRatio = Number(req.query.min_ratio || 0);

    const sql = `
      SELECT id, symbol, bucket_time, volume, baseline_volume, breakout_ratio, hill_data, created_at
      FROM k_hill_alerts
      WHERE breakout_ratio >= $1
      ORDER BY bucket_time DESC
      LIMIT $2
    `;
    
    const { rows } = await pool.query(sql, [minRatio, limit]);
    res.json(rows);
  } catch (e) {
    console.error('hill-alerts query failed:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Alert monitoring configuration and functions
const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || 0.01);
const VOLUME_RATIO_THRESHOLD = Number(process.env.VOLUME_RATIO_THRESHOLD || 1.5);
const VOLUME_SCAN_INTERVAL = Number(process.env.VOLUME_SCAN_INTERVAL || 300000); // 5 minutes
const VOLUME_HISTORY_DAYS = Number(process.env.VOLUME_HISTORY_DAYS || 20);
const VOLUME_Z_THRESHOLD = Number(process.env.VOLUME_Z_THRESHOLD || 2.0);

// 美股交易时段（ET 时区）
const MARKET_OPEN_MINS = 8 * 60; // 08:00 Beijing Time = 480 mins
const MARKET_CLOSE_MINS = 16 * 60;       // 16:00 ET
const TOTAL_MARKET_MINS = MARKET_CLOSE_MINS - MARKET_OPEN_MINS; // 390 分钟
const MIN_ELAPSED_PCT = 0.08;            // 至少经过 ~30 分钟才开始检测

// 计算当前美股交易日已过去的时间比例（0=盘前, 1=收盘后）
function getMarketElapsedPct() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = nowET.getHours() * 60 + nowET.getMinutes();
  if (mins <= MARKET_OPEN_MINS) return 0;
  if (mins >= MARKET_CLOSE_MINS) return 1.0;
  return (mins - MARKET_OPEN_MINS) / TOTAL_MARKET_MINS;
}

// 辅助函数：日期格式校验
const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

app.post('/api/volume/daily-refresh', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  
  // 1. 参数校验
  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_date_format', message: 'Use YYYY-MM-DD' });
  }

  try {

    
    // 2. 执行 Upsert (存在更新，不存在插入)
    const sql = `
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol,
             DATE(CASE
                    WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(trade_time)::timestamp
                    ELSE created_at
                  END) AS trade_date,
             SUM(size) AS daily_volume,
             now()
      FROM tos_trades
      WHERE DATE(CASE
                   WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(trade_time)::timestamp
                   ELSE created_at
                 END) >= $1::date AND DATE(CASE
                   WHEN trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' THEN trim(trade_time)::timestamp
                   ELSE created_at
                 END) <= $2::date
      GROUP BY symbol, trade_date
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = EXCLUDED.daily_volume, updated_at = now();`;
      
    await pool.query(sql, [start, end]);
    res.json({ ok: true, start, end, timestamp: new Date() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

app.get('/api/volume/summary', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const order = String(req.query.order || 'total').trim();
  const format = String(req.query.format || 'json').trim();

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_date_format' });
  }


  
  // 1. 动态排序字段
  const orderBy = order === 'avg' ? 'avg_volume' : 'total_volume';
  
  // 2. 查询汇总表 (性能极快)
  const sql = `
    SELECT symbol,
           SUM(daily_volume) AS total_volume,
           ROUND(AVG(daily_volume), 2) AS avg_volume
    FROM tos_daily_volume
    WHERE trade_date >= $1::date AND trade_date <= $2::date
    GROUP BY symbol
    ORDER BY ${orderBy} DESC;`;

  const { rows } = await pool.query(sql, [start, end]);

  // 3. CSV 导出处理
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="volume_summary.csv"');
    const header = 'symbol,total_volume,avg_volume\n';
    const body = rows.map(r => `${r.symbol},${r.total_volume},${r.avg_volume}`).join('\n');
    return res.send(header + body);
  }

  return res.json(rows);
});

// 历史均量 (查汇总表)
app.get('/api/volume/avg-daily', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  
  if (!symbol || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: 'invalid_params' });
  

  
  const sql = `
    SELECT COALESCE(AVG(daily_volume), 0) AS avg_daily_vol
    FROM tos_daily_volume
    WHERE symbol = $1 AND trade_date >= $2::date AND trade_date < $3::date;`;
    
  const { rows } = await pool.query(sql, [symbol, start, end]);
  res.json(rows[0]);
});

// 今日累积 (查明细表 - 实时)
app.get('/api/volume/cumulative', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const date = String(req.query.date || '').trim(); // 通常是今日
  
  if (!symbol || !isValidDate(date)) return res.status(400).json({ error: 'invalid_params' });
  

  
  const sql = `
    SELECT COALESCE(SUM(size), 0) AS cumulative_vol
    FROM tos_trades
    WHERE symbol = $1 AND (
      (trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND trim(trade_time)::timestamp >= $2::timestamp AND trim(trade_time)::timestamp < ($2::date + INTERVAL '1 day'))
      OR
      (trim(trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 day'))
    );`;
    
  const { rows } = await pool.query(sql, [symbol, date]);
  res.json(rows[0]);
});

app.post('/api/alerts/daily-volume-pct/scan', async (req, res) => {
  const { symbol, date, start, end, threshold } = req.query;
  
  if (!symbol || !isValidDate(date) || !isValidDate(start) || !isValidDate(end) || !threshold) {
    return res.status(400).json({ error: 'params_missing_or_invalid' });
  }
  


  // 1. 获取历史均量
  const avgRes = await pool.query(
    `SELECT COALESCE(AVG(daily_volume), 0) AS avg FROM tos_daily_volume 
     WHERE symbol = $1 AND trade_date >= $2::date AND trade_date < $3::date`,
    [symbol, start, end]
  );
  const avg = Number(avgRes.rows[0].avg || 0);
  
  // 2. 获取今日累积
  const cumRes = await pool.query(
    `SELECT COALESCE(SUM(size), 0) AS val, date_trunc('minute', now()) as now_bucket 
     FROM tos_trades 
     WHERE symbol = $1 AND (
       (trim(trade_time) ~ '^\\d{4}-\\d{2}-\\d{2}' AND trim(trade_time)::timestamp >= $2::timestamp AND trim(trade_time)::timestamp < ($2::date + INTERVAL '1 day'))
       OR
       (trim(trade_time) !~ '^\\d{4}-\\d{2}-\\d{2}' AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 day'))
     )`,
    [symbol, date]
  );
  const cum = Number(cumRes.rows[0].val || 0);
  
  // 3. 计算与判断
  const pct = avg > 0 ? cum / avg : 0;
  if (pct < Number(threshold)) {
    return res.json({ triggered: false, pct, cum, avg });
  }
  
  // 4. 写入提醒 (幂等) - 写入新表 k_volume_alerts
  const insertSql = `
    INSERT INTO k_volume_alerts(symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (symbol, bucket) DO NOTHING
    RETURNING id;`;
    
  const tx = await pool.query(insertSql, [symbol, cumRes.rows[0].now_bucket, pct, cum, avg]);
  res.json({ triggered: tx.rowCount > 0, pct, bucket: cumRes.rows[0].now_bucket });
});

// 新增：成交量提醒查询接口
app.get('/api/volume-alerts-data', async (req, res) => {
  try {

    const limit = Math.min(Number(req.query.limit || 50), 200);

    const sql = `
      SELECT symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol, rule_id, created_at
      FROM k_volume_alerts
      ORDER BY created_at DESC
      LIMIT $1
    `;
    const { rows } = await pool.query(sql, [limit]);
    res.json(rows);
  } catch (e) {
    console.error('volume alerts query failed:', e);
    res.status(500).json({ error: 'query failed' });
  }
});

async function scanAndInsertAlerts() {
  try {


    // 扫描当前分钟与上一分钟，聚�?O/H/L/C 并触发提�?
    const sql = `
      /*
       * 统一使用本地时区（Asia/Shanghai）的 timestamp 类型进行分钟聚合�?
       * 避免 timestamp �?timestamptz 比较造成的分钟边界错位�?
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
          /* �?received_at 作为服务器收到时间并转换为上海时区的 timestamp */
          (t.received_at AT TIME ZONE 'Asia/Shanghai') AS ts_local,
          t.price::numeric AS price,
          /* 本地时间按分钟截断，得到该笔成交归属的分钟桶 */
          date_trunc('minute', (t.received_at AT TIME ZONE 'Asia/Shanghai')) AS bucket_local
        FROM tos_trades t
        WHERE t.price IS NOT NULL AND t.price::numeric > 0
          AND COALESCE(t.size::numeric, 0) > 0
          /* 使用 received_at 作为数据接收时间进行筛选 - 使用范围查询优化索引 */
          AND t.received_at >= ((SELECT prev_bucket_local FROM params) AT TIME ZONE 'Asia/Shanghai')
          AND t.received_at < ((SELECT cur_bucket_local FROM params) AT TIME ZONE 'Asia/Shanghai' + INTERVAL '1 minute')
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
               /* 插入时将本地分钟桶显式转换为 timestamptz（以 Asia/Shanghai 解释�?*/
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

// 批量扫描所有 symbol 的日级成交量偏离，自动刷新汇总表 + 写入告警
let lastVolumeScanAt = null;
let volumeSchemaReady = false;

async function ensureVolumeAlertSchema() {
  if (volumeSchemaReady) return;
  await pool.query(`ALTER TABLE k_volume_alerts ADD COLUMN IF NOT EXISTS rule_id TEXT NOT NULL DEFAULT 'volume_surge'`);
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_vol_alerts_symbol_bucket') THEN
        ALTER TABLE k_volume_alerts DROP CONSTRAINT uq_vol_alerts_symbol_bucket;
        ALTER TABLE k_volume_alerts ADD CONSTRAINT uq_vol_alerts_symbol_bucket_rule
          UNIQUE (symbol, bucket, rule_id);
      END IF;
    END $$
  `);
  
  // Ensure time_checkpoints setting exists
  await pool.query(`
    INSERT INTO app_settings (key, value, value_type, description)
    VALUES ('time_checkpoints', 
            '[{"elapsed_minutes": 120, "expected_pct": 0.30, "label": "开市2小时"}, {"elapsed_minutes": 180, "expected_pct": 0.50, "label": "开市3小时"}, {"elapsed_minutes": 240, "expected_pct": 0.75, "label": "收盘前"}]', 
            'json', 
            'Time checkpoints for volume alerts')
    ON CONFLICT (key) DO NOTHING
  `);

  volumeSchemaReady = true;
}

// Update daily_summary table with today's data
async function updateDailySummary() {
  const client = await pool.connect();
  try {
    const start = Date.now();
    await client.query('SET statement_timeout = 120000'); // 2 minutes for heavy aggregation
    const sql = `
      INSERT INTO market_data.daily_summary (symbol, trade_date, open_price, close_price, high_price, low_price, total_volume)
      SELECT
        symbol,
        (received_at AT TIME ZONE 'Asia/Shanghai')::date,
        (array_agg(price::numeric ORDER BY market_time ASC))[1],
        (array_agg(price::numeric ORDER BY market_time DESC))[1],
        MAX(price::numeric),
        MIN(price::numeric),
        SUM(size::numeric)
      FROM tos_trades
      WHERE received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
        AND price IS NOT NULL AND price::numeric > 0
        AND market_time IS NOT NULL AND market_time != ''
        AND (
          CASE
            WHEN (now() AT TIME ZONE 'Asia/Shanghai')::time < '12:00:00'::time THEN market_time::time < '12:00:00'::time
            ELSE TRUE
          END
        )
      GROUP BY symbol, (received_at AT TIME ZONE 'Asia/Shanghai')::date
      ON CONFLICT (symbol, trade_date) DO UPDATE SET
        open_price = EXCLUDED.open_price,
        close_price = EXCLUDED.close_price,
        high_price = EXCLUDED.high_price,
        low_price = EXCLUDED.low_price,
        total_volume = EXCLUDED.total_volume;
    `;
    await client.query(sql);
    const duration = Date.now() - start;
    // console.log(`[DailySummary] Updated in ${duration}ms`);
  } catch (err) {
    console.error('[DailySummary] Update failed:', err.message);
  } finally {
    client.release();
  }
}

async function scanAllVolumeAlerts() {
  await ensureVolumeAlertSchema();

  // Load dynamic configuration
  const VOLUME_HISTORY_DAYS = await config.get('volume_history_days', 20);
  console.log(`[VolumeMonitor] Running scan with history=${VOLUME_HISTORY_DAYS}d`);
  
  // Load time checkpoints
  let timeCheckpoints = await config.get('time_checkpoints', []);
  if (!Array.isArray(timeCheckpoints)) {
      console.warn('[VolumeMonitor] time_checkpoints is not an array, using defaults');
      timeCheckpoints = [
        { elapsed_minutes: 120, expected_pct: 0.30, label: "开市2小时" }, 
        { elapsed_minutes: 180, expected_pct: 0.50, label: "开市3小时" }, 
        { elapsed_minutes: 240, expected_pct: 0.75, label: "收盘前" }
      ];
  }

  const today = new Date().toISOString().split('T')[0];
  const scanTs = new Date().toISOString();

  // 1. 刷新今日 tos_daily_volume（使用 received_at 走索引，增量累加）
  if (!lastVolumeScanAt) {
    // 首次运行：全量刷新
    await pool.query(`
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol, DATE(received_at), SUM(size), now()
      FROM tos_trades
      WHERE received_at >= $1::date AND received_at < ($1::date + INTERVAL '1 day')
      GROUP BY symbol, DATE(received_at)
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = EXCLUDED.daily_volume, updated_at = now()
    `, [today]);
    console.log('[VolumeMonitor] Full refresh');
  } else {
    // 增量：只累加上次扫描之后的新数据
    await pool.query(`
      INSERT INTO tos_daily_volume(symbol, trade_date, daily_volume, updated_at)
      SELECT symbol, DATE(received_at), SUM(size), now()
      FROM tos_trades
      WHERE received_at > $1::timestamptz
        AND received_at < $2::timestamptz
        AND DATE(received_at) = $3::date
      GROUP BY symbol, DATE(received_at)
      ON CONFLICT (symbol, trade_date)
      DO UPDATE SET daily_volume = tos_daily_volume.daily_volume + EXCLUDED.daily_volume,
                    updated_at = now()
    `, [lastVolumeScanAt, scanTs, today]);
  }
  lastVolumeScanAt = scanTs;

  // 2. Calculate elapsed minutes (Beijing Time 08:00 - 16:00)
  const now = new Date();
  const nowBeijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  
  // Weekend check (Saturday/Sunday Beijing Time)
  const day = nowBeijing.getDay();
  // if (day === 0 || day === 6) {
  //   console.log('[VolumeMonitor] Weekend (Saturday/Sunday), skipping scan');
  //   return;
  // }
  if (day === 0 || day === 6) {
    console.log('[VolumeMonitor] Weekend detected but continuing for testing/verification purposes.');
  }

  const currentMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  const elapsedMinutes = currentMins - MARKET_OPEN_MINS; 

  console.log(`[VolumeMonitor] Beijing Time: ${nowBeijing.toLocaleTimeString()}, elapsedMinutes=${elapsedMinutes}`);
  if (elapsedMinutes <= 0) return; // Pre-market, skip

  // 3. Checkpoints Logic
  let totalTriggered = 0;
  
  for (const cp of timeCheckpoints) {
      // Check if time window reached
      if (elapsedMinutes < cp.elapsed_minutes) continue;

      // Construct rule_id
      const ruleId = `checkpoint_${cp.elapsed_minutes}min_${Math.round(cp.expected_pct*100)}pct`;

      const sql = `
        WITH hist_ranked AS (
          SELECT symbol,
                 daily_volume,
                 PERCENT_RANK() OVER (PARTITION BY symbol ORDER BY daily_volume) AS pct_rank,
                 COUNT(*) OVER (PARTITION BY symbol) AS total_days
          FROM tos_daily_volume
          WHERE trade_date >= ($1::date - $2 * INTERVAL '1 day')
            AND trade_date < $1::date
        ),
        hist AS (
            SELECT symbol,
                   AVG(daily_volume) AS avg_vol
            FROM hist_ranked
            WHERE total_days >= 1
              AND pct_rank >= 0.1 AND pct_rank <= 0.9
            GROUP BY symbol
          ),
        today_vol AS (
          SELECT symbol, daily_volume AS cum_vol
          FROM tos_daily_volume
          WHERE trade_date = $1::date
        )
        INSERT INTO k_volume_alerts(symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol, rule_id, created_at)
        SELECT t.symbol,
               $1::date::timestamp AS bucket,
               t.cum_vol / NULLIF(h.avg_vol, 0) AS volume_ratio,
               t.cum_vol,
               ROUND(h.avg_vol, 2),
               $3, -- rule_id
               now()
        FROM today_vol t
        JOIN hist h USING (symbol)
        WHERE h.avg_vol > 0
          AND (t.cum_vol / NULLIF(h.avg_vol, 0)) >= $4::numeric
        ON CONFLICT (symbol, bucket, rule_id) DO NOTHING
        RETURNING symbol;
      `;

      try {
          const res = await pool.query(sql, [today, VOLUME_HISTORY_DAYS, ruleId, cp.expected_pct]);
          totalTriggered += res.rowCount;
          if (res.rowCount > 0) {
              console.log(`[VolumeMonitor] Checkpoint ${cp.label} (${ruleId}) triggered for ${res.rowCount} symbols`);
          }
      } catch (err) {
          console.error(`[VolumeMonitor] Error checking checkpoint ${cp.label}:`, err);
      }
  }
  
  if (totalTriggered > 0) {
      console.log(`[VolumeMonitor] Total alerts triggered: ${totalTriggered}`);
  }
}

// 山丘形态扫描：复用 getFlexibleHills 检测结果，写入 k_hill_alerts 表
const HILL_SCAN_INTERVAL = Number(process.env.HILL_SCAN_INTERVAL || 60000); // 1 minute
async function scanAndInsertHillAlerts() {
  try {
    const result = await getFlexibleHills(pool);
    if (!result || !result.data || result.data.length === 0) {
      console.log(`[HillMonitor] No hills detected (date: ${result ? result.date : 'unknown'}, count: ${result ? result.count : 0})`);
      return;
    }

    const insertSql = `
      INSERT INTO k_hill_alerts(symbol, bucket_time, volume, baseline_volume, breakout_ratio, hill_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (symbol, bucket_time) DO NOTHING
      RETURNING id;
    `;

    let inserted = 0;
    for (const item of result.data) {
      const hillDataJson = item.shape.map((v, i) => ({
        t: i === 0 ? item.startTime : (i === item.shape.length - 1 ? item.endTime : null),
        v
      }));
      const res = await pool.query(insertSql, [
        item.symbol,
        item.peakTime,
        item.peakVol,
        item.baseline,
        item.ratio,
        JSON.stringify(hillDataJson)
      ]);
      if (res.rowCount > 0) inserted++;
    }

    if (inserted > 0) {
      console.log(`[HillMonitor] Inserted ${inserted} hill alerts (date: ${result.date})`);
    }
  } catch (e) {
    console.error('[HillMonitor] Error:', e.message);
  }
}

function startAlertMonitor() {
  const runScan = async (name, fn, interval) => {
    while (true) {
      const start = Date.now();
      try {
        await fn();
      } catch (e) {
        console.error(`[${name}] Error:`, e.message);
      }
      const duration = Date.now() - start;
      if (duration > 1000) {
        console.log(`[${name}] Finished in ${duration}ms`);
      }
      
      // Wait for interval before next run
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  };

  // 1. 价格波动监控 (原有的)
  // scanAndInsertAlerts();
  // setInterval(scanAndInsertAlerts, 5000);
  runScan('PriceMonitor', scanAndInsertAlerts, 30000);

  // 2. 日级成交量偏离监控 (批量扫描所有 symbol)
  runScan('VolumeMonitor', scanAllVolumeAlerts, VOLUME_SCAN_INTERVAL);

  console.log(`[ALERT monitor] starting, interval=30000ms, threshold=${(ALERT_THRESHOLD_PCT * 100).toFixed(1)}%`);
  console.log(`[VolumeMonitor] starting, interval=${VOLUME_SCAN_INTERVAL / 1000}s, ratio>=${VOLUME_RATIO_THRESHOLD}x OR z>=${VOLUME_Z_THRESHOLD}, default_history=${VOLUME_HISTORY_DAYS}d`);
  
  // 3. 独立运行的每日数据汇总 (DailySummaryUpdater)
  console.log(`[DailySummaryUpdater] starting, interval=30s`);
  runScan('DailySummaryUpdater', updateDailySummary, 30000);

  // 4. Ranking 缓存后台刷新 (每30秒)
  console.log(`[RankingCache] starting, interval=30s`);
  runScan('RankingCache', refreshRankingCache, 5000);

  // 5. 3分钟价格窗口缓存 (供 ranking API 使用)
  console.log(`[PriceWindow] starting, interval=10s`);
  updatePriceWindow(); // warm up immediately
  runScan('PriceWindow', updatePriceWindow, 10000);

  // 6. 山丘形态扫描写入 k_hill_alerts (每分钟)
  console.log(`[HillMonitor] starting, interval=${HILL_SCAN_INTERVAL / 1000}s`);
  runScan('HillMonitor', scanAndInsertHillAlerts, HILL_SCAN_INTERVAL);
}

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

// 提醒页面路由
app.get('/alerts', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/alerts.html'));
});

// 成交量提醒页面路由
app.get('/volume-alerts', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/volume-alerts.html'));
});


// 山丘形态页面路由
app.get('/hills', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/hills.html'));
});

// 山丘放量提醒列表页面路由
app.get('/hill-alerts', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/hill-alerts.html'));
});

// 排行榜页面路由
app.get('/ranking', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/ranking.html'));
});

// 大单监控页面路由
app.get('/large-orders', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/large-orders.html'));
});

// 启动时确保表存在
ensureTables().then(() => {
  // 在静态服务与监听之前启动监控（或?listen 之后皆可?
  startAlertMonitor();
});

const PORT = process.env.PORT || 8889;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Server listening on http://${HOST}:${PORT}`));
