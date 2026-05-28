const express = require('express');
const fs = require('fs');
const path = require('path');
const compression = require('compression');
const { Pool } = require('pg');
const { getFlexibleHills } = require('./scan-flexible-hills');
const ConfigManager = require('./config-manager');

const app = express();
app.use(compression());

// Enable CORS for development/preview
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// 主连接池
const pgSchema = process.env.PGSCHEMA || 'market_data';
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
});

pool.on('connect', (client) => {
  client.query('SET search_path TO ' + pgSchema);
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err.message);
});

// [FIX 1] 独立连接池，专供 PriceWindow、PriceCache 和 QuoteCache
const pricePool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 15000,
});

pricePool.on('connect', (client) => {
  client.query('SET search_path TO ' + pgSchema);
});

pricePool.on('error', (err) => {
  console.error('[pricePool] Unexpected error on idle client', err.message);
});

// Initialize ConfigManager
const config = new ConfigManager(pool);

async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO ' + pgSchema);

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS tos_daily_volume (
        symbol TEXT NOT NULL,
        trade_date DATE NOT NULL,
        daily_volume NUMERIC,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_date)
      );
    `);

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS intraday_volume_surge (
        symbol        TEXT NOT NULL,
        trade_date    DATE NOT NULL,
        bucket_time   TIMESTAMPTZ NOT NULL,
        window_vol    NUMERIC,
        avg_daily_vol NUMERIC,
        vol_ratio     NUMERIC,
        PRIMARY KEY (symbol, trade_date)
      );
    `);

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

    await client.query('SET statement_timeout = 300000');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tos_trades_symbol_received ON tos_trades (symbol, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tos_trades_received ON tos_trades (received_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_summary_trade_date ON daily_summary (trade_date);
    `);
    await client.query('SET statement_timeout = 30000');

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
const priceCache = new Map();

// L1 quote cache: symbol -> { bid, ask, spread, receivedAt }
// 冷启动：LATERAL 取5分钟内每个 symbol 最新一条（只跑一次）
// 之后每10秒：只扫 received_at >= NOW()-30s 的增量行，merge 进缓存
// 依赖索引: idx_l1_quote_bl_received_at (received_at DESC)  → 0.67ms / 3841行
const quoteCache = new Map();
let quoteCacheInitialized = false;

async function initQuoteCache() {
  // 冷启动改用与增量相同的扫描方式（走 idx_l1_quote_bl_received_at，极快）
  // 用较大窗口（10分钟）尽量覆盖更多 symbol，失败也不阻塞启动
  const windows = ['10 minutes', '30 minutes', '60 minutes'];
  for (const w of windows) {
    try {
      const { rows } = await pricePool.query(`
        SELECT symbol,
               bid::numeric AS bid,
               ask::numeric AS ask,
               received_at
        FROM market_data.l1_quote_bl
        WHERE received_at >= NOW() - INTERVAL '${w}'
          AND bid IS NOT NULL AND bid::numeric > 0
          AND ask IS NOT NULL AND ask::numeric > 0
        ORDER BY received_at DESC
      `);
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.symbol)) continue;
        seen.add(row.symbol);
        const bid    = Number(row.bid);
        const ask    = Number(row.ask);
        const spread = Number((ask - bid).toFixed(4));
        quoteCache.set(row.symbol, { bid, ask, spread, receivedAt: row.received_at });
      }
      quoteCacheInitialized = true;
      console.log(`[QuoteCache] Cold-start done (window=${w}), ${quoteCache.size} symbols loaded`);
      return;
    } catch (err) {
      console.error(`[QuoteCache] Cold-start failed (window=${w}):`, err.message);
    }
  }
  // 所有窗口都失败，仍标记完成让增量接管
  quoteCacheInitialized = true;
  console.log(`[QuoteCache] Cold-start skipped, incremental update will populate cache`);
}

async function updateQuoteCache() {
  // 冷启动未完成时跳过增量更新，避免覆盖空缓存
  if (!quoteCacheInitialized) return;
  try {
    // 增量：只扫最近30秒新增的行，走 idx_l1_quote_bl_received_at
    // 实测：0.67ms，70 buffers全部 shared hit，无磁盘读
    const { rows } = await pricePool.query(`
      SELECT symbol,
             bid::numeric AS bid,
             ask::numeric AS ask,
             received_at
      FROM market_data.l1_quote_bl
      WHERE received_at >= NOW() - INTERVAL '30 seconds'
        AND bid IS NOT NULL AND bid::numeric > 0
        AND ask IS NOT NULL AND ask::numeric > 0
      ORDER BY received_at DESC
    `);

    // 每个 symbol 只保留最新一条（ORDER BY DESC，第一次出现的就是最新的）
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      const bid    = Number(row.bid);
      const ask    = Number(row.ask);
      const spread = Number((ask - bid).toFixed(4));
      quoteCache.set(row.symbol, { bid, ask, spread, receivedAt: row.received_at });
    }
  } catch (err) {
    console.error('[QuoteCache] Incremental update failed:', err.message);
  }
}

// [FIX 2] updatePriceCache 改用 LATERAL 逐 symbol 取最新价
// 避免 DISTINCT ON 全表扫描 + 磁盘排序（原耗时 9.7s -> 29ms）
async function updatePriceCache() {
  try {
    const { rows } = await pricePool.query(`
      SELECT s.symbol, t.price::numeric AS price, t.received_at
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
    `);
    for (const row of rows) {
      priceCache.set(row.symbol, { price: Number(row.price), receivedAt: row.received_at });
    }
  } catch (err) {
    console.error('[PriceCache] Update failed:', err.message);
  }
}

// Sliding 4-minute price window: symbol -> array of { price, receivedAt } sorted oldest-first
const priceWindow = new Map();

// 10-minute OHLCV window cache (方案A: GROUP BY 聚合，实测 ~71ms)
// symbol -> array of { bucket, open, high, low, close, volume } sorted oldest-first
// 每根 bar 代表一个完整分钟，最多 10 根
const window10m = new Map();

// [FIX 3] updatePriceWindow 改用 pricePool，加 id ASC 修复同毫秒乱序
async function updatePriceWindow() {
  const client = await pricePool.connect();
  try {
    const { rows } = await client.query(`
      SELECT symbol, price::numeric AS price, received_at
      FROM tos_trades
      WHERE received_at >= NOW() - INTERVAL '2 minutes'
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
      ORDER BY symbol, received_at ASC, id ASC
    `);
    priceWindow.clear();
    for (const row of rows) {
      if (!priceWindow.has(row.symbol)) priceWindow.set(row.symbol, []);
      priceWindow.get(row.symbol).push({ price: Number(row.price), receivedAt: new Date(row.received_at) });
    }
  } catch (err) {
    console.error('[PriceWindow] Update failed:', err.message);
  } finally {
    client.release();
  }
}

// [Window10m] 10分钟每分钟 OHLCV 聚合缓存（方案A: GROUP BY）
// 走 idx_tos_trades_received_at 索引，实测 ~71ms / 31628 行 / 2839 bars
// 仅用 pricePool，与其他 pricePool 任务完全隔离，不影响任何现有功能
async function updateWindow10m() {
  const client = await pricePool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    const { rows } = await client.query(`
      SELECT
        symbol,
        date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai') AS bucket,
        (array_agg(price::numeric ORDER BY received_at ASC,  id ASC))[1]  AS open,
        MAX(price::numeric)                                                AS high,
        MIN(price::numeric)                                                AS low,
        (array_agg(price::numeric ORDER BY received_at DESC, id DESC))[1] AS close,
        COALESCE(SUM(size::numeric), 0)                                   AS volume
      FROM tos_trades
      WHERE received_at >= NOW() - INTERVAL '10 minutes'
        AND received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '8 hours'
        AND price IS NOT NULL
        AND price::numeric > 0
      GROUP BY symbol, date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai')
      ORDER BY symbol, bucket ASC
    `);

    window10m.clear();
    for (const row of rows) {
      if (!window10m.has(row.symbol)) window10m.set(row.symbol, []);
      window10m.get(row.symbol).push({
        bucket: new Date(row.bucket),
        open:   Number(row.open),
        high:   Number(row.high),
        low:    Number(row.low),
        close:  Number(row.close),
        volume: Number(row.volume),
      });
    }
  } catch (err) {
    console.error('[Window10m] Update failed:', err.message);
  } finally {
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

    const currentRes = await pool.query(`
      SELECT price::numeric
      FROM tos_trades
      WHERE symbol = $1
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `, [symbol]);

    const prevRes = await pool.query(`
      SELECT price::numeric
      FROM tos_trades
      WHERE symbol = $1
        AND received_at <= (now() AT TIME ZONE 'Asia/Shanghai' - ($2 || ' minutes')::interval)
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `, [symbol, minutes]);

    const current = currentRes.rows.length > 0 ? Number(currentRes.rows[0].price) : 0;
    const previous = prevRes.rows.length > 0 ? Number(prevRes.rows[0].price) : 0;
    const change = (current && previous) ? Number((current - previous).toFixed(2)) : 0;

    return res.json({ current, previous, change });
  } catch (e) {
    console.error('price-snapshot error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// OHLCV API
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

// === L2 Alert History API ===
app.get('/api/l2-alert-history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const minutes = Number(req.query.minutes || 0);
    const market = String(req.query.market || 'BL').toLowerCase();

    const ALLOWED_MARKETS = new Set(['bl', 'sh', 'sz']);
    if (!ALLOWED_MARKETS.has(market)) {
      return res.status(400).json({ error: 'invalid_market' });
    }
    const table = `market_data.l2_alert_history_${market}`;

    let timeCondition = '';
    const params = [limit];

    if (minutes > 0) {
      timeCondition = `WHERE h.created_at >= NOW() - INTERVAL '${minutes} minutes' AND h.level <= 3`;
    } else {
      timeCondition = `WHERE h.created_at >= CURRENT_DATE`;
    }

    const sql = `
      SELECT h.id, h.stock_code, h.alert_type, h.level, h.price, h.volume, h.price_ratio,
             h.trend_type, h.prev_price, h.prev_volume, h.prev_level,
             h.price_change_abs, h.price_change_ratio, h.volume_change_abs, h.volume_change_ratio,
             h.level_delta, h.alert_message, h.created_at,
             COALESCE(d.total_volume, 0) AS total_volume,
             d.open_price
      FROM ${table} h
      LEFT JOIN market_data.daily_summary d ON h.stock_code = d.symbol AND d.trade_date = CURRENT_DATE
      ${timeCondition}
      ORDER BY h.created_at DESC
      LIMIT $1
    `;

    const { rows } = await pool.query(sql, params);

    // 用 priceCache 实时计算当日涨跌幅，与 /api/ranking 逻辑保持一致
    const enriched = rows.map(row => {
      const openPrice = Number(row.open_price);
      if (!openPrice) return { ...row, day_change_pct: null, day_change_amt: null };

      const cached   = priceCache.get(row.stock_code);
      const lastPrice = cached ? cached.price : Number(row.price); // 兜底用挂单价
      const changeAmt = lastPrice - openPrice;
      const changePct = Number((changeAmt / openPrice * 100).toFixed(2));

      return {
        ...row,
        day_change_pct: changePct,
        day_change_amt: Number(changeAmt.toFixed(3)),
      };
    });

    res.json(enriched);
  } catch (e) {
    console.error('l2-alert-history query failed:', e);
    res.status(500).json({ error: e.message });
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
    const changedBy = req.query.user || 'admin';
    const result = await config.update(key, value, changedBy);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/settings/trigger-volume-scan', async (req, res) => {
  try {
    console.log('[API] Triggering manual volume scan...');
    scanAllVolumeAlerts().catch(err => console.error('Manual scan failed:', err));
    res.json({ message: 'Volume scan triggered in background.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger scan' });
  }
});

// 数据库测试路由
app.get('/api/test-db', async (req, res) => {
  try {
    const tableCheck = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'tos_trades'
    `, [process.env.PGSCHEMA || 'market_data']);

    if (tableCheck.rows.length === 0) {
      return res.json({ error: 'tos_trades table not found', schema: process.env.PGSCHEMA || 'market_data' });
    }

    const columns = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'tos_trades'
      ORDER BY ordinal_position
    `, [process.env.PGSCHEMA || 'market_data']);

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
let rankingCache = [];
let rankingCacheTime = null;

// === 当前时段10日均量缓存 ===
// daily_intraday_vol.period_vol 存的是当天截至该分钟的累计量
// 所以取截至当前时刻的最后一条（MAX(period_vol)）即为同期累计量，再对10日求均值
const intradayAvgVolCache = new Map();

async function refreshIntradayAvgVolCache() {
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const beijingMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  // 08:00 前或 17:00 后不写入，避免收盘后产生大量重复记录
  if (beijingMins < 8 * 60 || beijingMins >= 17 * 60) return;

  const timeStr = nowBeijing.toTimeString().slice(0, 8); // 'HH:MM:SS'

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    // MAX(period_vol) = 截至 timeStr 的累计量（period_vol 单调递增）
    const { rows } = await client.query(`
      SELECT symbol,
             ROUND(AVG(day_vol)) AS avg_intraday_vol
      FROM (
        SELECT symbol,
               trade_date,
               MAX(period_vol) AS day_vol
        FROM market_data.daily_intraday_vol
        WHERE trade_date >= current_date - INTERVAL '14 days'
          AND trade_date <  current_date
          AND minute_time <= $1::time
        GROUP BY symbol, trade_date
      ) daily
      GROUP BY symbol
      HAVING COUNT(*) >= 3
    `, [timeStr]);

    intradayAvgVolCache.clear();
    for (const row of rows) {
      intradayAvgVolCache.set(row.symbol, Number(row.avg_intraday_vol));
    }
  } catch (err) {
    console.error('[IntradayAvgVol] Refresh failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// === 当日分时成交量写入 daily_intraday_vol ===
// period_vol 存当天从开盘到该分钟的累计成交量（单调递增）

// 每分钟写入当前分钟的累计量
async function writeIntradayVolMinute() {
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const beijingMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  // 08:00 前或 17:00 后不写入，避免收盘后产生大量重复记录
  if (beijingMins < 8 * 60 || beijingMins >= 17 * 60) return;

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    // 每次写入：从开盘到当前分钟截断时刻的全天累计量
    await client.query(`
      INSERT INTO market_data.daily_intraday_vol (symbol, trade_date, minute_time, period_vol)
      SELECT
        symbol,
        (received_at AT TIME ZONE 'Asia/Shanghai')::date                     AS trade_date,
        date_trunc('minute', NOW() AT TIME ZONE 'Asia/Shanghai')::time       AS minute_time,
        SUM(size::numeric)                                                    AS period_vol
      FROM tos_trades
      WHERE received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '8 hours'
        AND received_at <  date_trunc('minute', NOW() AT TIME ZONE 'Asia/Shanghai')
                           AT TIME ZONE 'Asia/Shanghai'
        AND size IS NOT NULL AND size::numeric > 0
        AND market_time IS NOT NULL AND market_time != ''
        AND trim(trade_time)::time <= (received_at AT TIME ZONE 'Asia/Shanghai')::time + INTERVAL '1 second'
      GROUP BY symbol,
               (received_at AT TIME ZONE 'Asia/Shanghai')::date
      ON CONFLICT (symbol, trade_date, minute_time)
      DO UPDATE SET period_vol = EXCLUDED.period_vol
    `);
  } catch (err) {
    console.error('[IntradayVolWriter] Minute write failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// 收盘后全量补写当天每分钟的累计量快照
async function snapshotTodayAllMinutes() {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 60000');
    // 先按分钟聚合出每分钟增量，再用窗口函数累计
    const { rowCount } = await client.query(`
      INSERT INTO market_data.daily_intraday_vol (symbol, trade_date, minute_time, period_vol)
      SELECT
        symbol,
        trade_date,
        minute_time,
        SUM(minute_vol) OVER (
          PARTITION BY symbol, trade_date
          ORDER BY minute_time
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS period_vol
      FROM (
        SELECT
          symbol,
          (received_at AT TIME ZONE 'Asia/Shanghai')::date                     AS trade_date,
          date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai')::time AS minute_time,
          SUM(size::numeric)                                                    AS minute_vol
        FROM tos_trades
        WHERE received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '8 hours'
          AND received_at <  current_date AT TIME ZONE 'Asia/Shanghai' + INTERVAL '17 hours'
          AND size IS NOT NULL AND size::numeric > 0
          AND market_time IS NOT NULL AND market_time != ''
          AND trim(trade_time)::time <= (received_at AT TIME ZONE 'Asia/Shanghai')::time + INTERVAL '1 second'
        GROUP BY symbol,
                 (received_at AT TIME ZONE 'Asia/Shanghai')::date,
                 date_trunc('minute', received_at AT TIME ZONE 'Asia/Shanghai')::time
      ) minute_agg
      ON CONFLICT (symbol, trade_date, minute_time)
      DO UPDATE SET period_vol = EXCLUDED.period_vol
    `);
    console.log(`[IntradaySnapshot] Today's snapshot done, ${rowCount} rows upserted`);
  } catch (err) {
    console.error('[IntradaySnapshot] Snapshot failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

// [FIX 4] refreshRankingCache 不再查 tos_trades，改用内存 priceCache join
async function refreshRankingCache() {
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 20000');
    const safeEtfList = etfList.length > 0 ? etfList : ['__NO_ETF__'];

    const sql = `
      WITH avg_vol AS (
        SELECT symbol, AVG(total_volume) AS avg_vol
        FROM market_data.daily_summary
        WHERE trade_date >= current_date - 10
          AND trade_date < current_date
        GROUP BY symbol
        HAVING AVG(total_volume) >= 1000
      )
      SELECT
        t.symbol,
        t.open_price,
        t.high_price,
        t.low_price,
        t.total_volume,
        COALESCE(ROUND(a.avg_vol), 0) AS avg_vol_10d
      FROM market_data.daily_summary t
      LEFT JOIN avg_vol a USING (symbol)
      WHERE t.trade_date = current_date
        AND NOT (t.symbol = ANY($1::text[]))
        AND t.open_price > 0
    `;

    const { rows } = await client.query(sql, [safeEtfList]);

    const newCache = rows.map(row => {
      const cached = priceCache.get(row.symbol);
      const lastPrice = cached ? cached.price : Number(row.open_price);
      const openPrice = Number(row.open_price);
      const changeAmt = lastPrice - openPrice;
      // 优先使用当前时段10日均量；缓存未就绪时回退到全天均量
      const intradayAvg = intradayAvgVolCache.get(row.symbol);
      const avg_vol_10d = intradayAvg != null ? intradayAvg : Number(row.avg_vol_10d);
      return {
        symbol: row.symbol,
        open_price: openPrice,
        last_price: lastPrice,
        change_amount: changeAmt,
        change_pct: openPrice > 0 ? Number((changeAmt / openPrice * 100).toFixed(2)) : 0,
        total_volume: row.total_volume,
        avg_vol_10d,
        high_price: Number(row.high_price || 0),
        low_price:  Number(row.low_price  || 0),
      };
    });

    newCache.sort((a, b) => b.change_amount - a.change_amount);
    rankingCache = newCache;
    rankingCacheTime = new Date();

    if (rows.length === 0) {
      const diag = await client.query(`
        SELECT current_date AS db_date,
               MIN(trade_date) AS min_date, MAX(trade_date) AS max_date, COUNT(*) AS total
        FROM market_data.daily_summary
      `);
      console.log(`[RankingCache] 0 rows. DB date=${diag.rows[0].db_date}, range: ${diag.rows[0].min_date}~${diag.rows[0].max_date}, total=${diag.rows[0].total}`);
    } else {
      console.log(`[RankingCache] Refreshed, ${rankingCache.length} rows`);
    }
  } catch (err) {
    console.error('[RankingCache] Error:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(e => console.error(e));
    client.release();
  }
}

// 排行榜 API
app.get('/api/ranking', (req, res) => {
  try {
    const minVolume = Number(req.query.min_volume || 0);
    const minPriceChange3m = Number(req.query.min_price_change_3m || 0);

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
              price_change_3m = Number(row.last_price) - entry3m.price;
            }
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

// === 分价格区间波动筛选器 API ===
const SWING_RULES = [
  { maxPrice: 20,        minSwing: 0.20, minChangePct: 2.0  },
  { maxPrice: 100,       minSwing: 0.50, minChangePct: 1.0  },
  { maxPrice: 300,       minSwing: 1.00, minChangePct: 0.5  },
  { maxPrice: 600,       minSwing: 1.50, minChangePct: 0.35 },
  { maxPrice: Infinity,  minSwing: 2.00, minChangePct: 0.3  },
];

function getSwingRule(price) {
  for (const rule of SWING_RULES) {
    if (price < rule.maxPrice) return rule;
  }
  return SWING_RULES[SWING_RULES.length - 1];
}

app.get('/api/price-swing-screener', (req, res) => {
  try {
    const minVolume = Number(req.query.min_volume || 0);
    const results = [];

    for (const row of rankingCache) {
      if (Number(row.total_volume) < minVolume) continue;

      const lastPrice = Number(row.last_price);
      if (!lastPrice) continue;

      // 无实时窗口数据直接跳过，不用 daily 兜底
      const win = priceWindow.get(row.symbol);
      if (!win || win.length < 2) continue;

      // 2分钟窗口内高低价 & 波动额
      let windowHigh = win[0].price;
      let windowLow  = win[0].price;
      for (const e of win) {
        if (e.price > windowHigh) windowHigh = e.price;
        if (e.price < windowLow)  windowLow  = e.price;
      }
      const swing = windowHigh - windowLow;

      // 2分钟窗口内涨跌：最旧价 -> 最新价
      const priceStart  = win[0].price;
      const priceEnd    = win[win.length - 1].price;
      const changeAmt2m = Number((priceEnd - priceStart).toFixed(3));
      const changePct2m = priceStart > 0
        ? Number(((priceEnd - priceStart) / priceStart * 100).toFixed(2))
        : 0;

      const rule = getSwingRule(lastPrice);

      if (swing >= rule.minSwing && Math.abs(changePct2m) >= rule.minChangePct) {
        results.push({
          symbol:              row.symbol,
          open_price:          row.open_price,
          last_price:          priceEnd,
          change_pct:          changePct2m,
          change_amount:       changeAmt2m,
          swing:               Number(swing.toFixed(3)),
          swing_source:        'realtime',
          window_high:         Number(windowHigh.toFixed(3)),
          window_low:          Number(windowLow.toFixed(3)),
          total_volume:        row.total_volume,
          avg_vol_10d:         row.avg_vol_10d,
          rule_min_swing:      rule.minSwing,
          rule_min_change_pct: rule.minChangePct,
        });
      }
    }

    results.sort((a, b) => b.swing - a.swing);
    res.json(results);
  } catch (e) {
    console.error('[SwingScreener] error:', e);
    res.status(500).json({ error: 'swing_screener_failed' });
  }
});

// === 自由选股器 API ===
app.get('/api/screener', (req, res) => {
  try {
    const q = req.query;

    // AND / OR 逻辑模式，默认 AND
    const logic = (q.logic || 'and').toLowerCase() === 'or' ? 'or' : 'and';

    // 价格区间
    const priceMin = q.price_min !== undefined && q.price_min !== '' ? Number(q.price_min) : null;
    const priceMax = q.price_max !== undefined && q.price_max !== '' ? Number(q.price_max) : null;

    // 涨跌幅区间（支持负数）
    const changMin = q.change_min !== undefined && q.change_min !== '' ? Number(q.change_min) : null;
    const changMax = q.change_max !== undefined && q.change_max !== '' ? Number(q.change_max) : null;

    // 量比区间（total_volume / avg_vol_10d）
    const volRatioMin = q.vol_ratio_min !== undefined && q.vol_ratio_min !== '' ? Number(q.vol_ratio_min) : null;
    const volRatioMax = q.vol_ratio_max !== undefined && q.vol_ratio_max !== '' ? Number(q.vol_ratio_max) : null;

    // 绝对成交量下限
    const volMin = q.vol_min !== undefined && q.vol_min !== '' ? Number(q.vol_min) : null;

    // 价差区间 (ask - bid)
    const spreadMin = q.spread_min !== undefined && q.spread_min !== '' ? Number(q.spread_min) : null;
    const spreadMax = q.spread_max !== undefined && q.spread_max !== '' ? Number(q.spread_max) : null;

    // 是否有任何条件
    const hasPrice    = priceMin    !== null || priceMax    !== null;
    const hasChange   = changMin    !== null || changMax    !== null;
    const hasVolRatio = volRatioMin !== null || volRatioMax !== null;
    const hasVol      = volMin      !== null;
    const hasSpread   = spreadMin   !== null || spreadMax   !== null;
    const hasAny      = hasPrice || hasChange || hasVolRatio || hasVol || hasSpread;

    const results = [];

    for (const row of rankingCache) {
      const price     = Number(row.last_price);
      const changePct = Number(row.change_pct);
      const vol       = Number(row.total_volume) || 0;
      const avgVol    = Number(row.avg_vol_10d)  || 0;
      const volRatio  = avgVol > 0 ? vol / avgVol : 0;

      if (!price) continue;

      // 从 quoteCache 取 bid/ask/价差
      const quote  = quoteCache.get(row.symbol);
      const bid    = quote ? quote.bid    : null;
      const ask    = quote ? quote.ask    : null;
      const spread = quote ? quote.spread : null;

      // 无任何条件时返回全部
      if (!hasAny) {
        results.push({ symbol: row.symbol, last_price: price, open_price: row.open_price,
          change_pct: changePct, change_amount: Number(row.change_amount),
          total_volume: vol, avg_vol_10d: avgVol,
          vol_ratio: avgVol > 0 ? Number(volRatio.toFixed(2)) : null,
          high_price: row.high_price, low_price: row.low_price,
          bid, ask, spread });
        continue;
      }

      // 每个条件组：先判断该组是否"激活"，再判断是否"命中"
      const priceHit = !hasPrice || (
        (priceMin === null || price     >= priceMin) &&
        (priceMax === null || price     <= priceMax)
      );
      const changeHit = !hasChange || (
        (changMin  === null || changePct >= changMin) &&
        (changMax  === null || changePct <= changMax)
      );
      const volRatioHit = !hasVolRatio || (
        (volRatioMin === null || volRatio >= volRatioMin) &&
        (volRatioMax === null || volRatio <= volRatioMax)
      );
      const volHit    = !hasVol    || vol >= volMin;
      const spreadHit = !hasSpread || (spread !== null && (
        (spreadMin === null || spread >= spreadMin) &&
        (spreadMax === null || spread <= spreadMax)
      ));

      // AND：全部激活的条件组都要命中；OR：任一命中即可
      let pass;
      if (logic === 'and') {
        pass = priceHit && changeHit && volRatioHit && volHit && spreadHit;
      } else {
        const hits = [
          hasPrice    && priceHit,
          hasChange   && changeHit,
          hasVolRatio && volRatioHit,
          hasVol      && volHit,
          hasSpread   && spreadHit,
        ].filter((_, i) => [hasPrice, hasChange, hasVolRatio, hasVol, hasSpread][i]);
        pass = hits.some(Boolean);
      }

      if (pass) {
        results.push({
          symbol:        row.symbol,
          last_price:    price,
          open_price:    row.open_price,
          change_pct:    changePct,
          change_amount: Number(row.change_amount),
          total_volume:  vol,
          avg_vol_10d:   avgVol,
          vol_ratio:     avgVol > 0 ? Number(volRatio.toFixed(2)) : null,
          high_price:    row.high_price,
          low_price:     row.low_price,
          bid,
          ask,
          spread,
        });
      }
    }

    results.sort((a, b) => b.change_pct - a.change_pct);
    res.json(results);
  } catch (e) {
    console.error('[Screener] error:', e);
    res.status(500).json({ error: 'screener_failed' });
  }
});

// === 稳定选股器 API ===
// 在自由选股器基础上叠加 5 条稳定性规则（全部基于 window10m 内存缓存，不查库）
// R1: 10分钟内 high-low < 现价 × 1.2%
// R2: 10分钟内总成交量 >= 110
// R3: |现价 - 10分钟收盘均价| / 均价 < 0.5%
// R4: |首根中间价 - 末根中间价| / 末根中间价 < 0.3%（绝对值）
// R5: 每分钟 |close-open|/open < 阈值（价格<200用0.5%，>=200用0.3%），至少7分钟满足
app.get('/api/screener-stable', (req, res) => {
  try {
    const q = req.query;

    // 基础筛选参数（与 /api/screener 相同）
    const priceMin = q.price_min !== undefined && q.price_min !== '' ? Number(q.price_min) : null;
    const priceMax = q.price_max !== undefined && q.price_max !== '' ? Number(q.price_max) : null;
    const changMin = q.change_min !== undefined && q.change_min !== '' ? Number(q.change_min) : null;
    const changMax = q.change_max !== undefined && q.change_max !== '' ? Number(q.change_max) : null;
    const volMin   = q.vol_min   !== undefined && q.vol_min   !== '' ? Number(q.vol_min)   : null;
    const volMax   = q.vol_max   !== undefined && q.vol_max   !== '' ? Number(q.vol_max)   : null;

    const results = [];

    for (const row of rankingCache) {
      const price     = Number(row.last_price);
      const changePct = Number(row.change_pct);
      const vol       = Number(row.total_volume) || 0;
      const avgVol    = Number(row.avg_vol_10d)  || 0;

      if (!price) continue;

      // ── 基础过滤 ──
      if (priceMin !== null && price     < priceMin) continue;
      if (priceMax !== null && price     > priceMax) continue;
      if (changMin !== null && changePct < changMin) continue;
      if (changMax !== null && changePct > changMax) continue;
      if (volMin   !== null && vol       < volMin)   continue;
      if (volMax   !== null && vol       > volMax)   continue;

      // ── window10m 数据 ──
      const bars = window10m.get(row.symbol);

      // 数据不足时仍返回，但规则字段为 null（前端显示"—"）
      let r1_val = null, r2_vol = null, r3_pct = null, r4_pct = null, r5_cnt = null;

      if (bars && bars.length > 0) {
        // R1: 10分钟振幅 % = (windowHigh - windowLow) / price * 100
        const winHigh = Math.max(...bars.map(b => b.high));
        const winLow  = Math.min(...bars.map(b => b.low));
        r1_val = Number(((winHigh - winLow) / price * 100).toFixed(3));

        // R2: 10分钟总成交量
        r2_vol = bars.reduce((s, b) => s + b.volume, 0);

        // R3: |现价 - 10分钟收盘均价| / 均价 × 100 (%)
        const avgClose = bars.reduce((s, b) => s + b.close, 0) / bars.length;
        r3_pct = avgClose > 0
          ? Number((Math.abs(price - avgClose) / avgClose * 100).toFixed(3))
          : null;

        // R4: |首根中间价 - 末根中间价| / 末根中间价 × 100 (%)
        const firstMid = (bars[0].high + bars[0].low) / 2;
        const lastMid  = (bars[bars.length - 1].high + bars[bars.length - 1].low) / 2;
        r4_pct = lastMid > 0
          ? Number((Math.abs(firstMid - lastMid) / lastMid * 100).toFixed(3))
          : null;

        // R5: 安静蜡烛数（价格<200阈值0.5%，>=200阈值0.3%）
        const candleThresh = price >= 200 ? 0.003 : 0.005;
        r5_cnt = bars.filter(b =>
          b.open > 0 && Math.abs(b.close - b.open) / b.open < candleThresh
        ).length;
      }

      // quote
      const quote  = quoteCache.get(row.symbol);
      const bid    = quote ? quote.bid    : null;
      const ask    = quote ? quote.ask    : null;
      const spread = quote ? quote.spread : null;

      results.push({
        symbol:        row.symbol,
        last_price:    price,
        open_price:    row.open_price,
        change_pct:    changePct,
        change_amount: Number(row.change_amount),
        total_volume:  vol,
        avg_vol_10d:   avgVol,
        vol_ratio:     avgVol > 0 ? Number((vol / avgVol).toFixed(2)) : null,
        high_price:    row.high_price,
        low_price:     row.low_price,
        bid,
        ask,
        spread,
        // 5条规则原始指标值（前端负责计算通过/失败和评分）
        r1_val,   // 10min振幅%，< 1.2% 为通过
        r2_vol,   // 10min总量，>= 110 为通过
        r3_pct,   // 现价偏离均价%，< 0.5% 为通过
        r4_pct,   // 首尾中间价漂移%，< 0.3% 为通过
        r5_cnt,   // 安静分钟数，>= 7 为通过
        bars_count: bars ? bars.length : 0,
      });
    }

    results.sort((a, b) => b.change_pct - a.change_pct);
    res.json(results);
  } catch (e) {
    console.error('[StableScreener] error:', e);
    res.status(500).json({ error: 'stable_screener_failed' });
  }
});

// 当日分时放量 symbol 列表 API
app.get('/api/volume-surge-today', (req, res) => {
  res.json([...volumeSurgeToday]);
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
        WHERE detected_at >= NOW() - ($1 * INTERVAL '1 minute')
          AND volume >= $2
        ORDER BY stock_code, side, detected_at DESC
      )
      SELECT o.symbol, o.side, o.level, o.order_price, o.order_volume, o.detected_at,
             d.open_price, d.close_price, d.total_volume
      FROM recent_large_orders o
      JOIN market_data.daily_summary d ON o.symbol = d.symbol AND d.trade_date = CURRENT_DATE
      WHERE NOT (o.symbol = ANY($3::text[]))
      ORDER BY o.detected_at DESC
      LIMIT 100
    `;

    const { rows } = await pool.query(sql, [timeWindowMins, minOrderVolume, safeEtfList]);

    const result = rows.map(row => {
      const window = priceWindow.get(row.symbol);
      let currentPrice;
      if (window && window.length > 0) {
        currentPrice = window[window.length - 1].price;
      } else {
        const cached = priceCache.get(row.symbol);
        currentPrice = cached ? cached.price : Number(row.close_price);
      }
      return { ...row, current_price: currentPrice };
    });

    res.json(result);
  } catch (e) {
    console.error('Large orders screener error:', e);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// === 山丘形放量查询 API ===
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

// === K Hill Alerts 查询 API ===
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

// Alert monitoring configuration
const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || 0.01);
const VOLUME_RATIO_THRESHOLD = Number(process.env.VOLUME_RATIO_THRESHOLD || 1.5);
const VOLUME_SCAN_INTERVAL = Number(process.env.VOLUME_SCAN_INTERVAL || 300000);
const VOLUME_HISTORY_DAYS = Number(process.env.VOLUME_HISTORY_DAYS || 20);
const VOLUME_Z_THRESHOLD = Number(process.env.VOLUME_Z_THRESHOLD || 2.0);

const MARKET_OPEN_MINS = 8 * 60;
const MARKET_CLOSE_MINS = 16 * 60;
const TOTAL_MARKET_MINS = MARKET_CLOSE_MINS - MARKET_OPEN_MINS;

function getMarketElapsedPct() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = nowET.getHours() * 60 + nowET.getMinutes();
  if (mins <= MARKET_OPEN_MINS) return 0;
  if (mins >= MARKET_CLOSE_MINS) return 1.0;
  return (mins - MARKET_OPEN_MINS) / TOTAL_MARKET_MINS;
}

const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);

app.post('/api/volume/daily-refresh', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_date_format', message: 'Use YYYY-MM-DD' });
  }

  try {
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

  const orderBy = order === 'avg' ? 'avg_volume' : 'total_volume';

  const sql = `
    SELECT symbol,
           SUM(daily_volume) AS total_volume,
           ROUND(AVG(daily_volume), 2) AS avg_volume
    FROM tos_daily_volume
    WHERE trade_date >= $1::date AND trade_date <= $2::date
    GROUP BY symbol
    ORDER BY ${orderBy} DESC;`;

  const { rows } = await pool.query(sql, [start, end]);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="volume_summary.csv"');
    const header = 'symbol,total_volume,avg_volume\n';
    const body = rows.map(r => `${r.symbol},${r.total_volume},${r.avg_volume}`).join('\n');
    return res.send(header + body);
  }

  return res.json(rows);
});

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

app.get('/api/volume/cumulative', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const date = String(req.query.date || '').trim();

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

  const avgRes = await pool.query(
    `SELECT COALESCE(AVG(daily_volume), 0) AS avg FROM tos_daily_volume
     WHERE symbol = $1 AND trade_date >= $2::date AND trade_date < $3::date`,
    [symbol, start, end]
  );
  const avg = Number(avgRes.rows[0].avg || 0);

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

  const pct = avg > 0 ? cum / avg : 0;
  if (pct < Number(threshold)) {
    return res.json({ triggered: false, pct, cum, avg });
  }

  const insertSql = `
    INSERT INTO k_volume_alerts(symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (symbol, bucket) DO NOTHING
    RETURNING id;`;

  const tx = await pool.query(insertSql, [symbol, cumRes.rows[0].now_bucket, pct, cum, avg]);
  res.json({ triggered: tx.rowCount > 0, pct, bucket: cumRes.rows[0].now_bucket });
});

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
    const sql = `
      WITH params AS (
        SELECT
          date_trunc('minute', (now() AT TIME ZONE 'Asia/Shanghai')) AS cur_bucket_local,
          date_trunc('minute', (now() AT TIME ZONE 'Asia/Shanghai')) - INTERVAL '1 minute' AS prev_bucket_local,
          (now() AT TIME ZONE 'Asia/Shanghai')::date AS target_date
      ),
      minute_trades AS (
        SELECT
          t.symbol,
          (t.received_at AT TIME ZONE 'Asia/Shanghai') AS ts_local,
          t.price::numeric AS price,
          date_trunc('minute', (t.received_at AT TIME ZONE 'Asia/Shanghai')) AS bucket_local
        FROM tos_trades t
        WHERE t.price IS NOT NULL AND t.price::numeric > 0
          AND COALESCE(t.size::numeric, 0) > 0
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

// [FIX 6] updateDailySummary 全天汇总模式
// [FIX H] open_price 使用 CASE 保护，一旦写入不再覆盖
// [FIX I] 过滤 trade_time 晚于 received_at 当天时刻的补推历史单
// [FIX J] 去掉 2 分钟窗口改为全天汇总，close/high/low/volume 直接覆盖，避免重复累加
// [FIX K] 开市前（北京时间 08:00 前）直接跳过，防止补推历史单污染 open_price
// [FIX L] open_price 自纠错：若已写入值与新算出值偏差 > 20%，允许覆盖（应对极少数脏数据锁定场景）
async function updateDailySummary() {
  // [FIX K] 非交易时段不写入，避免凌晨补推数据锁定错误 open_price
  const nowBeijing = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const beijingMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  if (beijingMins < 8 * 60) {
    // 08:00 前静默跳过，无需打日志
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 15000');
    const sql = `
      INSERT INTO market_data.daily_summary
        (symbol, trade_date, open_price, close_price, high_price, low_price, total_volume)
      SELECT
        symbol,
        (received_at AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
        (array_agg(price::numeric ORDER BY received_at ASC, id ASC))[1]  AS open_price,
        (array_agg(price::numeric ORDER BY received_at DESC, id DESC))[1] AS close_price,
        MAX(price::numeric)  AS high_price,
        MIN(price::numeric)  AS low_price,
        SUM(size::numeric)   AS total_volume
      FROM tos_trades
      WHERE received_at >= current_date AT TIME ZONE 'Asia/Shanghai' + interval '8 hours'
        AND price IS NOT NULL AND price::numeric > 0
        AND market_time IS NOT NULL AND market_time != ''
        AND trim(trade_time)::time <= (received_at AT TIME ZONE 'Asia/Shanghai')::time + interval '1 second'
      GROUP BY symbol, (received_at AT TIME ZONE 'Asia/Shanghai')::date
      ON CONFLICT (symbol, trade_date) DO UPDATE SET
        -- [FIX L] 正常情况保留已写入的 open_price 不覆盖；
        --         但若偏差超过 20%，说明之前锁定的是脏数据，允许纠正。
        open_price   = CASE
                         WHEN daily_summary.open_price IS NULL
                           THEN EXCLUDED.open_price
                         WHEN daily_summary.open_price > 0
                           AND ABS(daily_summary.open_price - EXCLUDED.open_price)
                               / daily_summary.open_price > 0.20
                           THEN EXCLUDED.open_price
                         ELSE daily_summary.open_price
                       END,
        close_price  = EXCLUDED.close_price,
        high_price   = EXCLUDED.high_price,
        low_price    = EXCLUDED.low_price,
        total_volume = EXCLUDED.total_volume
    `;
    await client.query(sql);
  } catch (err) {
    console.error('[DailySummary] Update failed:', err.message);
  } finally {
    await client.query('SET statement_timeout = 0').catch(() => {});
    client.release();
  }
}

async function scanAllVolumeAlerts() {
  await ensureVolumeAlertSchema();

  const VOLUME_HISTORY_DAYS = await config.get('volume_history_days', 20);
  console.log(`[VolumeMonitor] Running scan with history=${VOLUME_HISTORY_DAYS}d`);

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

  if (!lastVolumeScanAt) {
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

  const now = new Date();
  const nowBeijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));

  const day = nowBeijing.getDay();
  if (day === 0 || day === 6) {
    console.log('[VolumeMonitor] Weekend detected but continuing for testing/verification purposes.');
  }

  const currentMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
  const elapsedMinutes = currentMins - MARKET_OPEN_MINS;

  console.log(`[VolumeMonitor] Beijing Time: ${nowBeijing.toLocaleTimeString()}, elapsedMinutes=${elapsedMinutes}`);
  if (elapsedMinutes <= 0) return;

  let totalTriggered = 0;

  for (const cp of timeCheckpoints) {
    if (elapsedMinutes < cp.elapsed_minutes) continue;

    const ruleId = `checkpoint_${cp.elapsed_minutes}min_${Math.round(cp.expected_pct * 100)}pct`;

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
             $3,
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

// ── 分时放量监控 ──────────────────────────────────────────────────────────────

// 当日已触发量异常的 symbol（内存 Set，进程重启时从 DB 恢复）
const volumeSurgeToday = new Set();

async function loadVolumeSurgeFromDB() {
  try {
    const { rows } = await pool.query(`
      SELECT symbol FROM intraday_volume_surge
      WHERE trade_date = current_date
    `);
    rows.forEach(r => volumeSurgeToday.add(r.symbol));
    console.log(`[VolumeSurge] Loaded ${volumeSurgeToday.size} symbols from DB`);
  } catch (e) {
    console.error('[VolumeSurge] loadFromDB error:', e.message);
  }
}

async function scanIntradayVolumeSurge() {
  const SURGE_WINDOW  = Number(process.env.INTRADAY_SURGE_WINDOW  || 30);  // 分钟
  const SURGE_RATIO   = Number(process.env.INTRADAY_SURGE_RATIO   || 3);   // 倍数
  const SURGE_HISTORY = Number(process.env.INTRADAY_SURGE_HISTORY || 10);  // 历史天数

  try {
    const { rows } = await pool.query(`
      WITH window_vol AS (
        SELECT t.symbol, SUM(t.size) AS vol
        FROM market_data.tos_trades t
        INNER JOIN market_data.daily_summary ds
          ON ds.symbol = t.symbol AND ds.trade_date = current_date
        WHERE t.received_at >= NOW() - ($1 * INTERVAL '1 minute')
        GROUP BY t.symbol
      ),
      hist_avg AS (
        SELECT symbol, AVG(daily_volume) AS avg_vol
        FROM tos_daily_volume
        WHERE trade_date >= current_date - CAST($2 AS INTEGER)
          AND trade_date < current_date
        GROUP BY symbol
        HAVING COUNT(*) >= 3
      )
      INSERT INTO intraday_volume_surge
        (symbol, trade_date, bucket_time, window_vol, avg_daily_vol, vol_ratio)
      SELECT
        w.symbol,
        current_date,
        date_trunc('minute', NOW()),
        w.vol,
        ROUND(h.avg_vol, 2),
        ROUND(w.vol / h.avg_vol, 2)
      FROM window_vol w
      JOIN hist_avg h USING (symbol)
      WHERE w.vol / h.avg_vol >= $3
      ON CONFLICT (symbol, trade_date) DO NOTHING
      RETURNING symbol, vol_ratio
    `, [SURGE_WINDOW, SURGE_HISTORY, SURGE_RATIO]);

    if (rows.length > 0) {
      rows.forEach(r => volumeSurgeToday.add(r.symbol));
      console.log(`[VolumeSurge] ${rows.length} new surge(s): ${rows.map(r => `${r.symbol}(${r.vol_ratio}x)`).join(', ')}`);
    }
  } catch (e) {
    console.error('[VolumeSurge] scan error:', e.message);
  }
}

// [FIX 7] HillMonitor 间隔 300s
const HILL_SCAN_INTERVAL = Number(process.env.HILL_SCAN_INTERVAL || 300000);

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
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  };

  runScan('PriceMonitor', scanAndInsertAlerts, 30000);
  runScan('VolumeMonitor', scanAllVolumeAlerts, VOLUME_SCAN_INTERVAL);

  console.log(`[ALERT monitor] starting, interval=30000ms, threshold=${(ALERT_THRESHOLD_PCT * 100).toFixed(1)}%`);
  console.log(`[VolumeMonitor] starting, interval=${VOLUME_SCAN_INTERVAL / 1000}s, ratio>=${VOLUME_RATIO_THRESHOLD}x OR z>=${VOLUME_Z_THRESHOLD}, default_history=${VOLUME_HISTORY_DAYS}d`);
  console.log(`[DailySummaryUpdater] starting, interval=60s`);
  runScan('DailySummaryUpdater', updateDailySummary, 60000);

  console.log(`[IntradayAvgVol] starting, interval=60s`);
  refreshIntradayAvgVolCache();
  runScan('IntradayAvgVol', refreshIntradayAvgVolCache, 60000);

  console.log(`[IntradayVolWriter] starting, interval=60s`);
  runScan('IntradayVolWriter', writeIntradayVolMinute, 60000);

  console.log(`[PriceCache] warming up...`);
  updatePriceCache().then(() => {
    console.log(`[PriceCache] warm up done, starting RankingCache`);
    runScan('RankingCache', refreshRankingCache, 10000);
  });

  runScan('PriceCache', updatePriceCache, 10000);

  console.log(`[QuoteCache] cold-start initializing in 15s...`);
  setTimeout(() => {
    initQuoteCache().then(() => {
      runScan('QuoteCache', updateQuoteCache, 10000);
    });
  }, 15000);

  console.log(`[PriceWindow] starting, interval=10s`);
  updatePriceWindow();
  runScan('PriceWindow', updatePriceWindow, 10000);

  console.log(`[Window10m] starting, interval=10s`);
  updateWindow10m();
  runScan('Window10m', updateWindow10m, 10000);

  console.log(`[HillMonitor] starting, interval=${HILL_SCAN_INTERVAL / 1000}s`);
  runScan('HillMonitor', scanAndInsertHillAlerts, HILL_SCAN_INTERVAL);

  // 启动时从 DB 恢复当日已触发记录，再启动定时扫描
  loadVolumeSurgeFromDB();
  const SURGE_SCAN_INTERVAL = Number(process.env.INTRADAY_SURGE_INTERVAL || 300000);
  console.log(`[VolumeSurge] starting, interval=${SURGE_SCAN_INTERVAL / 1000}s, window=${process.env.INTRADAY_SURGE_WINDOW || 30}min, ratio>=${process.env.INTRADAY_SURGE_RATIO || 3}x`);
  runScan('VolumeSurge', scanIntradayVolumeSurge, SURGE_SCAN_INTERVAL);

  // 每天 17:01 北京时间触发收盘快照，补全当日所有分钟到 daily_intraday_vol
  let lastSnapshotDate = null;
  console.log(`[IntradaySnapshot] scheduler starting, will trigger at 17:01 Asia/Shanghai daily`);
  setInterval(() => {
    const bj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const h  = bj.getHours();
    const m  = bj.getMinutes();
    const todayStr = bj.toISOString().slice(0, 10);
    if (h === 17 && m === 1 && lastSnapshotDate !== todayStr) {
      lastSnapshotDate = todayStr;
      snapshotTodayAllMinutes();
    }
  }, 60000);
}

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
}));

app.get('/alerts',          (req, res) => res.sendFile(path.join(__dirname, '../public/alerts.html')));
app.get('/volume-alerts',   (req, res) => res.sendFile(path.join(__dirname, '../public/volume-alerts.html')));
app.get('/hills',           (req, res) => res.sendFile(path.join(__dirname, '../public/hills.html')));
app.get('/hill-alerts',     (req, res) => res.sendFile(path.join(__dirname, '../public/hill-alerts.html')));
app.get('/ranking',         (req, res) => res.sendFile(path.join(__dirname, '../public/ranking.html')));
app.get('/large-orders',    (req, res) => res.sendFile(path.join(__dirname, '../public/large-orders.html')));
app.get('/l2-alerts',       (req, res) => res.sendFile(path.join(__dirname, '../public/l2_alert_history.html')));
app.get('/swing-screener',  (req, res) => res.sendFile(path.join(__dirname, '../public/swing-screener.html')));
app.get('/screener',        (req, res) => res.sendFile(path.join(__dirname, '../public/screener.html')));
app.get('/stable-screener', (req, res) => res.sendFile(path.join(__dirname, '../public/screener-stable.html')));

ensureTables().then(() => {
  startAlertMonitor();
});

const PORT = process.env.PORT || 8889;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Server listening on http://${HOST}:${PORT}`));