# K 线 MVP 开发计划（基于 market_data.tos_trades）

> 目标：支持按用户搜索的 `symbol` 生成当日 1 分钟 K 线，后端从 `market_data.tos_trades` 聚合 OHLCV，前端绘图并显示最新价标签。严格遵守数据库配置，不改动其值。

- db-host: `localhost`
- db-port: `5432`
- db-name: `ppro8_market_data`
- db-user: `postgres`
- db-password: `postgres`
- schema: `market_data`
- 成交表：`market_data.tos_trades`

---

## 范围与MVP原则

- 一次只实现一个功能，能用即可，后续迭代优化。
- 仅支持当日(`00:00–23:59:59`)的 1 分钟线。
- 仅使用 `market_data.tos_trades` 作为数据源。
- 仅支持单 `symbol` 查询；不做多图、多周期、回放等复杂功能。

### 不做清单（控制范围）
- 不做 L2/盘口深度、VWAP、指标（EMA/RSI 等）。
- 不做多周期（5m/15m/1h/日线）切换。
- 不做权限/用户系统与复杂缓存层。
- 不做跨日合并、复杂时区转换（统一到展示时区）。
- 不做前端复杂样式与绘图工具栏；仅展示基本K线与最新价标签。

---

## 架构概览（建议）

- 后端：Node.js + Express，`pg` 连接 PostgreSQL，输出 `[{ t,o,h,l,c,v }]` JSON。
- 前端：`public/index.html` + `lightweight-charts` 在浏览器绘图。
- 目录：
  - `src/server.js`（API：`/api/ohlcv?symbol=...&date=YYYY-MM-DD`）
  - `src/sql/ohlcv.sql`（可选，集中管理SQL）
  - `public/index.html`（搜索输入、图表渲染）
  - `.env`（数据库连接，使用上述固定配置）

---

## Git 使用原则

- 每个功能从干净状态开始：`git status` 确认无未提交；必要时 `git reset --hard`。
- 每完成一个功能，提交一次：`git add -A && git commit -m "feat: <功能>"`。
- 失败时果断重置到上一个稳定点：`git reset --hard HEAD~1`。

---

## 迭代 0：项目最小化搭建

- 要做什么：初始化后端服务与前端静态页的最小骨架。
- 文件改动：
  - `package.json`：增加脚本与依赖（示例片段）。
  - `src/server.js`：创建 Express 服务与健康检查路由。
  - `public/index.html`：最小静态页（后续迭代用于绘图）。
  - `.env`：写入数据库配置（与现有配置一致）。

### 修改片段示例

- `package.json`（示例脚本）：
```json
{
  "name": "k_app",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
```

- `.env`：
```
PGHOST=localhost
PGPORT=5432
PGDATABASE=ppro8_market_data
PGUSER=postgres
PGPASSWORD=postgres
PGSCHEMA=market_data
```

- `src/server.js`：
```js
const express = require('express');
const path = require('path');
const app = express();

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
```

- `public/index.html`：
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>K Chart MVP</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <h1>K Chart MVP</h1>
    <p>后续迭代将加载 /api/ohlcv 数据并绘图。</p>
  </body>
</html>
```

### 如何验证
- 安装依赖：`npm install`。
- 启动：`npm run start`。
- 浏览器访问：`http://localhost:3000/health` 应返回 `{"ok": true, ...}`。

### DoD（完成定义）
- 服务可启动并提供健康检查接口；静态页可访问。

---

## 迭代 1：后端 OHLCV API（当日 1m）

- 要做什么：实现 `/api/ohlcv`，按 `symbol` 与 `date` 从 `market_data.tos_trades` 聚合当日 1 分钟 OHLCV，补齐空分钟。
- 文件改动：
  - `src/server.js`：新增数据库连接与路由 `/api/ohlcv`。
  - `src/sql/ohlcv.sql`（可选）：抽离 SQL。

### SQL 逻辑（参数：`$1=symbol`, `$2=date`）
```sql
-- 设置模式
SET search_path TO market_data;

WITH params AS (
  SELECT $1::text AS symbol,
         ($2::date)::timestamptz AS day_start,
         (($2::date) + INTERVAL '1 day')::timestamptz AS day_end
),
filtered AS (
  SELECT t.symbol, t.ts, t.price, t.size,
         date_trunc('minute', t.ts) AS bucket
  FROM tos_trades t
  JOIN params p ON p.symbol = t.symbol
  WHERE t.ts >= p.day_start AND t.ts < p.day_end
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
series AS (
  SELECT generate_series(p.day_start, p.day_end - INTERVAL '1 minute', INTERVAL '1 minute') AS bucket
  FROM params p
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
FROM joined;
```

### 路由代码片段（`src/server.js`）
```js
const express = require('express');
const { Pool } = require('pg');
const app = express();

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
});

app.get('/api/ohlcv', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const date = String(req.query.date || '').trim();
    if (!symbol || !date) return res.status(400).json({ error: 'symbol and date required' });
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

    const sql = `
      WITH params AS (
        SELECT $1::text AS symbol,
               ($2::date)::timestamptz AS day_start,
               (($2::date) + INTERVAL '1 day')::timestamptz AS day_end
      ),
      filtered AS (
        SELECT t.symbol, t.ts, t.price, t.size,
               date_trunc('minute', t.ts) AS bucket
        FROM tos_trades t
        JOIN params p ON p.symbol = t.symbol
        WHERE t.ts >= p.day_start AND t.ts < p.day_end
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
      series AS (
        SELECT generate_series(p.day_start, p.day_end - INTERVAL '1 minute', INTERVAL '1 minute') AS bucket
        FROM params p
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
      FROM joined;`;

    const { rows } = await pool.query(sql, [symbol, date]);
    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error' });
  }
});
```

### 如何验证
- 启动服务：`npm run start`。
- `curl`：
  - `curl "http://localhost:3000/api/ohlcv?symbol=AMZN.BL&date=2025-10-07"`
- 预期：返回按时间升序的 JSON 数组，包含 `t,o,h,l,c,v` 字段，分钟数约为当日交易时段的分钟数（空分钟已补齐）。

### DoD（完成定义）
- 对任意存在成交的 `symbol+date`，API 返回有效的 1m OHLCV 序列；空分钟正确补齐；错误参数返回 400。

---

## 迭代 2：前端绘图（静态加载）

- 要做什么：在 `public/index.html` 中添加搜索框与图表，加载 `/api/ohlcv` 数据绘制 1m K线，显示最新价标签。
- 文件改动：`public/index.html`。

### 代码片段（最小实现）
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>K Chart MVP</title>
    <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
    <style>
      #chart { width: 100%; height: 600px; }
      #toolbar { display: flex; gap: 8px; margin: 8px 0; }
    </style>
  </head>
  <body>
    <div id="toolbar">
      <input id="symbol" placeholder="输入symbol，如 AMZN.BL" />
      <input id="date" type="date" />
      <button id="load">加载</button>
    </div>
    <div id="chart"></div>

    <script>
      const chart = LightweightCharts.createChart(document.getElementById('chart'), {
        layout: { background: { type: 'solid', color: '#000' }, textColor: '#ddd' },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false },
      });
      const series = chart.addCandlestickSeries();

      async function loadData() {
        const symbol = document.getElementById('symbol').value.trim();
        const date = document.getElementById('date').value;
        if (!symbol || !date) { alert('请输入symbol与date'); return; }
        const res = await fetch(`/api/ohlcv?symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}`);
        const rows = await res.json();
        const candles = rows.map(r => ({
          time: Math.floor(new Date(r.t).getTime() / 1000),
          open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c)
        }));
        series.setData(candles);
      }

      document.getElementById('load').addEventListener('click', loadData);
      document.getElementById('date').valueAsDate = new Date();
    </script>
  </body>
</html>
```

### 如何验证
- 启动服务：`npm run start`。
- 浏览器：`http://localhost:3000/` 输入 `symbol` 与日期，点击“加载”。
- 预期：图表展示 1m K线；右侧价格刻度显示最新价标签（库默认蓝色标签）。

### DoD（完成定义）
- 对有效的 `symbol+date`，页面成功绘图且时间轴连续；无成交分钟位置保持连续、蜡烛体为上一分钟价格。

---

## 迭代 3：符号搜索建议（可选）

- 要做什么：提供 `/api/symbols?q=AMZN` 返回最近有成交的 `symbol` 列表，前端输入框支持联想。
- 文件改动：`src/server.js`：新增路由。

### SQL 片段
```sql
SET search_path TO market_data;
SELECT symbol, MAX(ts) AS last_ts, COUNT(*) AS trades
FROM tos_trades
WHERE symbol ILIKE $1 || '%'
GROUP BY symbol
ORDER BY last_ts DESC
LIMIT 20;
```

### 路由片段
```js
app.get('/api/symbols', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  const { rows } = await pool.query(
    `SELECT symbol, MAX(ts) AS last_ts, COUNT(*) AS trades
     FROM tos_trades WHERE symbol ILIKE $1 || '%'
     GROUP BY symbol ORDER BY last_ts DESC LIMIT 20;`,
    [q]
  );
  res.json(rows.map(r => r.symbol));
});
```

### 如何验证
- `curl "http://localhost:3000/api/symbols?q=AMZN"` 返回符号列表。

### DoD（完成定义）
- 对常见前缀返回 5–20 个候选；无输入返回空数组；接口耗时可接受。

---

## 迭代 4：增量更新（当前分钟）— 可选

- 要做什么：前端每 5 秒拉取一次最新 `/api/ohlcv` 并仅更新最后一根蜡烛。
- 文件改动：`public/index.html`：增加简单轮询逻辑。

### 代码片段
```js
let poller;
function startPolling() {
  if (poller) clearInterval(poller);
  poller = setInterval(async () => {
    // 仅重新加载最后 N 分钟也可，MVP全量即可
    await loadData();
  }, 5000);
}
// 加载成功后启动
// document.getElementById('load').addEventListener('click', () => { loadData().then(startPolling); });
```

### 如何验证
- 观察 1–2 分钟内有新成交时，最后一根的高/低/收随数据变化。

### DoD（完成定义）
- 前端可自动刷新当前分钟的蜡烛，不卡顿、不重复闪烁。

---

## 性能与稳定性建议（后续迭代考虑）
- 索引：`CREATE INDEX ON market_data.tos_trades(symbol, ts);`
- 视图：对高频 `symbol` 与当日分钟线构建物化视图以提升查询速度。
- 清洗：剔除离群价、重复打印、非正成交量。

---

## 回滚与故障处理
- 若某迭代实现后接口超时或前端报错：`git reset --hard` 回退；分步排查。
- 将 SQL 独立成文件便于单独在 psql 中验证。

---

## 验收清单（总体 DoD）
- 输入 `symbol` 与日期后，前端能绘制当日 1m K线，时间轴连续，最新价标签显示。
- 后端 API 在合理时间返回（< 1–2s，视数据量而定）。
- 所有步骤均有可重复的验证命令与回滚策略。

---

## 迭代 5：当日成交量百分比提醒（MVP）

- 目标：当日累积成交量达到近 D 个交易日平均成交量的 X% 时触发提醒，写入 `market_data.k_alerts` 并在提醒页面展示。
- 参考文件：
  - [server.js](file:///c:/Users/sami/Desktop/k_app/src/server.js)
  - [alerts.sql](file:///c:/Users/sami/Desktop/k_app/src/sql/alerts.sql)
  - [alerts.html](file:///c:/Users/sami/Desktop/k_app/public/alerts.html)

### Git 工作流（每步都可套用）
- 干净开始：`git status -sb` 确认无未提交；必要时 `git reset --hard`。
- 建分支：`git switch -c feature/daily-volume-pct-alert`。
- 失败回滚：`git reset --hard` 或回到上一个提交。

### 步骤 1：计算近 D 日平均成交量（后端查询）
- 要做什么：提供查询获取某 symbol 近 D 个交易日的“每日总成交量”均值 `avg_daily_vol`。
- 需要修改的文件：`src/server.js` 新增路由 `/api/volume/avg-daily`（MVP可直接实现为查询）。
- 代码片段：
```js
app.get('/api/volume/avg-daily', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const days = Number(req.query.days || 5);
  if (!symbol || !days) return res.status(400).json({ error: 'symbol and days required' });
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  const sql = `
    WITH d AS (
      SELECT DATE(ts) AS day, SUM(size) AS vol
      FROM tos_trades
      WHERE symbol = $1
      GROUP BY day
      ORDER BY day DESC
      LIMIT $2
    )
    SELECT COALESCE(AVG(vol), 0) AS avg_daily_vol FROM d;`;
  const { rows } = await pool.query(sql, [symbol, days]);
  res.json(rows[0]);
});
```
- 如何验证：
  - 启动服务：`npm run start`。
  - `curl "http://localhost:3000/api/volume/avg-daily?symbol=AMZN.BL&days=5"`。
  - 预期：返回 `{ "avg_daily_vol": <number> }`，数值与数据库手算接近。
- DoD：
  - 常见活跃标的能在合理时间返回均值；参数校验健壮。

### 步骤 2：计算当日累积成交量（实时）
- 要做什么：查询当日从开盘至当前时刻的累积成交量 `cumulative_vol`。
- 需要修改的文件：`src/server.js` 新增路由 `/api/volume/cumulative`。
- 代码片段：
```js
app.get('/api/volume/cumulative', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const date = String(req.query.date || '').trim();
  if (!symbol || !date) return res.status(400).json({ error: 'symbol and date required' });
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  const sql = `
    WITH p AS (
      SELECT ($2::date)::timestamptz AS day_start,
             (($2::date) + INTERVAL '1 day')::timestamptz AS day_end
    )
    SELECT COALESCE(SUM(size), 0) AS cumulative_vol
    FROM tos_trades t, p
    WHERE t.symbol = $1 AND t.ts >= p.day_start AND t.ts < LEAST(p.day_end, now());`;
  const { rows } = await pool.query(sql, [symbol, date]);
  res.json(rows[0]);
});
```
- 如何验证：
  - `curl "http://localhost:3000/api/volume/cumulative?symbol=AMZN.BL&date=2025-10-07"`。
  - 预期：返回 `{ "cumulative_vol": <number> }`，与分钟级 `v` 累加一致。
- DoD：
  - 活跃交易日返回非零累积值；空交易日返回 0。

### 步骤 3：阈值检测并写入提醒
- 要做什么：当 `cumulative_vol / avg_daily_vol >= X` 且首次跨越阈值时，写入 `market_data.k_alerts`。
- 需要修改的文件：
  - `src/server.js` 新增路由 `/api/alerts/daily-volume-pct/scan` 触发一次扫描（MVP用手动触发）。
  - 不改动表结构，使用现有唯一键（`symbol,bucket,rule_id`）。
- 代码片段：
```js
app.post('/api/alerts/daily-volume-pct/scan', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const date = String(req.query.date || '').trim();
  const days = Number(req.query.days || 5);
  const thresholds = String(req.query.thresholds || '0.5,0.8,1.0')
    .split(',').map(s => Number(s)).filter(n => n > 0);
  if (!symbol || !date || thresholds.length === 0) return res.status(400).json({ error: 'params required' });
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  const { rows: avgRows } = await pool.query(
    `WITH d AS (
       SELECT DATE(ts) AS day, SUM(size) AS vol
       FROM tos_trades WHERE symbol = $1
       GROUP BY day ORDER BY day DESC LIMIT $2
     ) SELECT COALESCE(AVG(vol),0) AS avg_daily_vol FROM d;`,
    [symbol, days]
  );
  const avg = Number(avgRows[0].avg_daily_vol || 0);
  const { rows: cumRows } = await pool.query(
    `WITH p AS (
       SELECT ($2::date)::timestamptz AS day_start,
              (($2::date) + INTERVAL '1 day')::timestamptz AS day_end
     ) SELECT COALESCE(SUM(size),0) AS cumulative_vol,
              date_trunc('minute', COALESCE(MAX(ts), now())) AS bucket
     FROM tos_trades t, p
     WHERE t.symbol=$1 AND t.ts >= p.day_start AND t.ts < LEAST(p.day_end, now());`,
    [symbol, date]
  );
  const cum = Number(cumRows[0].cumulative_vol || 0);
  const bucket = cumRows[0].bucket;
  const pct = avg > 0 ? cum / avg : 0;
  const hit = thresholds.filter(x => pct >= x);
  if (hit.length === 0) return res.json({ triggered: false, pct });
  const txs = await pool.query(
    `INSERT INTO market_data.k_alerts(symbol,bucket,open,high,low,close,amplitude_pct,direction,rule_id)
     SELECT $1, $2, 0, 0, 0, 0, $3, 1, 'daily_volume_pct'
     ON CONFLICT (symbol,bucket,rule_id) DO NOTHING
     RETURNING id;`,
    [symbol, bucket, pct]
  );
  res.json({ triggered: txs.rowCount > 0, pct, bucket });
});
```
- 如何验证：
  - 启动服务：`npm run start`。
  - `curl -X POST "http://localhost:3000/api/alerts/daily-volume-pct/scan?symbol=AMZN.BL&date=2025-10-07&days=5&thresholds=0.5,0.8,1.0"`。
  - `psql` 检查 `market_data.k_alerts` 是否新增 `rule_id='daily_volume_pct'` 行。
- DoD：
  - 到达阈值时返回 `triggered=true` 并成功插入一行；重复触发同分钟不会重复插入。

### 步骤 4：提醒页面展示
- 要做什么：在提醒列表展示该新规则为百分比文案。
- 需要修改的文件：`public/alerts.html` 渲染逻辑新增 `daily_volume_pct` 分支。
- 代码片段：
```js
const isDailyPct = alert.rule_id === 'daily_volume_pct';
if (isDailyPct) {
  const pctText = (parseFloat(alert.amplitude_pct) * 100).toFixed(0) + '%';
  amplitudeText = '当日量达均量 ' + pctText;
  amplitudeClass = 'amp-volume';
}
```
- 如何验证：
  - 浏览器访问：`http://localhost:3000/alerts`。
  - 预期：当有 `daily_volume_pct` 数据时，显示“当日量达均量 xx%”。
- DoD：
  - 列表正确展示新规则，样式与现有提醒一致；无该规则时页面正常。

### 步骤 5：配置参数（可选）
- 要做什么：支持 D 与阈值数组配置，MVP 可通过 URL 参数或简易后端配置接口。
- 需要修改的文件：
  - `public/alerts.html` 增加输入框或读取 URL 参数 `d`、`pct`。
  - `src/server.js` 增加 `/api/config/daily-volume-pct`（可选）。
- 代码片段（URL 读取示例）：
```js
const url = new URL(window.location);
const dParam = Number(url.searchParams.get('d') || 5);
const pctParam = (url.searchParams.get('pct') || '0.8').split(',').map(s => Number(s));
```
- 如何验证：
  - 浏览器：`http://localhost:3000/alerts?d=5&pct=0.5,0.8,1.0`。
  - 预期：渲染逻辑按参数生效。
- DoD：
  - 参数可读可用；非法参数回退默认值。

### 步骤 6：回测与稳定性
- 要做什么：对历史交易日进行手动触发扫描，核对触发点的准确性。
- 验证：
  - 多次 `curl -X POST` 在不同阈值与日期下测试；查询 DB 校验插入。
  - 若异常日影响均值，调整 D 或采用中位数策略（后续迭代）。
- DoD：
  - 典型活跃标的在 50%/80%/100% 阈值附近触发合理；未触发不插入。

### 完成与回滚
- 完成：`git add -A && git commit -m "feat: daily volume pct alert MVP"`。
- 回滚：`git reset --hard` 恢复到上一个稳定提交。
