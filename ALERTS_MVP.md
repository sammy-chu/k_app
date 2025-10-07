# 全市场 K 线提醒 MVP 开发步骤

目标：对数据库中全部股票进行分钟级波动监控，当某分钟蜡烛振幅超过 1% 时触发提醒；提醒入库并在前端页面展示。不绘制所有股票的 K 线图。

## 范围与原则

- 一次只实现一个功能；每步可独立验证。
- MVP：仅当日分钟数据、单规则（振幅≥1%）、简单列表展示。
- 善用 Git：每步从干净状态开始；失败即回滚。
- 不做清单（控制范围）：
  - 不做 WebSocket 推送（先用轮询）。
  - 不做分页/过滤器（先显示最新 N 条）。
  - 不做“已读/确认”流程。
  - 不做每标的自定义阈值（单全局阈值）。
  - 不做复杂 UI（表格排序/跨页等）。
  - 不做物化视图或分区（后续优化再加）。

---

## 迭代 0：准备与基线

- 要做什么
  - 确认工作树干净、服务运行正常。
- 如何验证
  - 命令：`git status`
  - 启动：`npm run start` 后访问 `http://localhost:3000/health`，预期 `{ ok: true }`。
- DoD
  - 当前分支工作树干净且服务正常提供静态页与健康检查。

---

## 迭代 1：新增提醒表 `k_alerts`

- 要做什么
  - 在数据库中创建提醒表，用于持久化分钟波动提醒。
- 修改与新增文件
  - 新增 `src/sql/alerts.sql`（集中管理建表 SQL）。
- 代码片段
  - `src/sql/alerts.sql`
    ```sql
    -- Schema: market_data（与现有搜索路径一致）
    -- 创建提醒表：存储每分钟的波动提醒
    CREATE TABLE IF NOT EXISTS market_data.k_alerts (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      bucket TIMESTAMPTZ NOT NULL,   -- 该分钟起始时间
      open NUMERIC NOT NULL,
      high NUMERIC NOT NULL,
      low NUMERIC NOT NULL,
      close NUMERIC NOT NULL,
      amplitude_pct NUMERIC NOT NULL, -- (high - low) / open
      direction INT NOT NULL,         -- sign(close - open)：-1/0/1
      rule_id TEXT NOT NULL DEFAULT 'amplitude_1pct',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (symbol, bucket, rule_id)
    );

    CREATE INDEX IF NOT EXISTS idx_k_alerts_created_at ON market_data.k_alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_k_alerts_symbol_bucket ON market_data.k_alerts(symbol, bucket);
    ```
- 如何验证
  - 在数据库控制台或 `psql` 执行该 SQL。
  - 查询：`SELECT COUNT(*) FROM market_data.k_alerts;` 应成功返回 0 或已有值。
- DoD
  - 表与索引成功创建，唯一约束生效。

---

## 迭代 2：后端监控任务（扫描当前/上一分钟并入库提醒）

- 要做什么
  - 在后端添加一个定时任务（每 5 秒）扫描“当前分钟”和“上一分钟”的成交，按 `symbol,bucket` 聚合出 O/H/L/C，计算振幅并写入 `k_alerts`（超过 1% 时 upsert）。
- 修改文件
  - 更新 `src/server.js`：添加监控任务函数与启动逻辑。
- 代码片段
  - `src/server.js`（片段，插入在现有 `app.listen` 之前）
    ```js
    const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || 0.01);

    async function scanAndInsertAlerts() {
      try {
        await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

        // 扫描当前分钟与上一分钟，聚合 O/H/L/C 并触发提醒
        const sql = `
          WITH params AS (
            SELECT date_trunc('minute', now()) AS cur_bucket,
                   date_trunc('minute', now()) - INTERVAL '1 minute' AS prev_bucket,
                   CURRENT_DATE::text AS target_date
          ),
          minute_trades AS (
            SELECT t.symbol,
                   CASE 
                     WHEN t.trade_time ~ '^\\d{4}-\\d{2}-\\d{2}' THEN t.trade_time::timestamp
                     ELSE (p.target_date || ' ' || t.trade_time)::timestamp
                   END AS ts,
                   t.price::numeric AS price,
                   CASE 
                     WHEN t.trade_time ~ '^\\d{4}-\\d{2}-\\d{2}' THEN date_trunc('minute', t.trade_time::timestamp)
                     ELSE date_trunc('minute', (p.target_date || ' ' || t.trade_time)::timestamp)
                   END AS bucket
            FROM tos_trades t
            JOIN params p ON TRUE
            WHERE t.price IS NOT NULL AND t.price::numeric > 0
              AND (
                CASE 
                  WHEN t.trade_time ~ '^\\d{4}-\\d{2}-\\d{2}' THEN date_trunc('minute', t.trade_time::timestamp)
                  ELSE date_trunc('minute', (p.target_date || ' ' || t.trade_time)::timestamp)
                END
              ) IN ((SELECT cur_bucket FROM params), (SELECT prev_bucket FROM params))
          ),
          agg AS (
            SELECT symbol, bucket,
                   MAX(price) AS high,
                   MIN(price) AS low
            FROM minute_trades
            GROUP BY symbol, bucket
          ),
          open_close AS (
            SELECT a.symbol, a.bucket,
                   (SELECT mt.price FROM minute_trades mt WHERE mt.symbol = a.symbol AND mt.bucket = a.bucket ORDER BY mt.ts ASC LIMIT 1) AS open,
                   (SELECT mt.price FROM minute_trades mt WHERE mt.symbol = a.symbol AND mt.bucket = a.bucket ORDER BY mt.ts DESC LIMIT 1) AS close,
                   a.high, a.low
            FROM agg a
          ),
          alerts AS (
            SELECT symbol, bucket, open, high, low, close,
                   CASE WHEN open > 0 THEN (high - low) / open ELSE 0 END AS amplitude_pct,
                   CASE WHEN close > open THEN 1 WHEN close < open THEN -1 ELSE 0 END AS direction
            FROM open_close
            WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
          )
          INSERT INTO k_alerts(symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at)
          SELECT symbol, bucket, open, high, low, close, amplitude_pct, direction, 'amplitude_1pct', now()
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

    // 在静态服务与监听之前启动监控（或在 listen 之后皆可）
    startAlertMonitor();
    ```
- 如何验证
  - 启动服务：`npm run start`。
  - 观察控制台日志有 `Inserted alerts: N`。
  - 数据库查询：`SELECT * FROM market_data.k_alerts ORDER BY created_at DESC LIMIT 5;` 能看到最新提醒。
- DoD
  - 每 5 秒后台扫描当前/上一分钟，超过 1% 的标的提醒被入库，去重生效。

---

## 迭代 3：后端提醒查询接口 `/api/alerts`

- 要做什么
  - 提供简单的 REST 接口，前端可拉取最近提醒列表。
- 修改文件
  - 更新 `src/server.js`：新增路由。
- 代码片段
  - `src/server.js`（添加在其他路由附近）
    ```js
    app.get('/api/alerts', async (req, res) => {
      try {
        await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
        const since = req.query.since || null;
        const limit = Math.min(Number(req.query.limit || 50), 200);

        const sql = `
          SELECT symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id, created_at
          FROM k_alerts
          WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
          ORDER BY created_at DESC
          LIMIT $2
        `;
        const { rows } = await pool.query(sql, [since, limit]);
        res.json(rows);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'internal_error' });
      }
    });
    ```
- 如何验证
  - `curl "http://localhost:3000/api/alerts?limit=10"`
  - 预期返回 JSON 数组，字段包含 `symbol/bucket/open/high/low/close/amplitude_pct/direction/rule_id/created_at`。
- DoD
  - 接口在合理时间内返回最近提醒；支持 `limit` 与 `since`。

---

## 迭代 4：前端提醒列表展示与轮询

- 要做什么
  - 在 `public/index.html` 中新增提醒列表区域，前端每 5–10 秒拉取 `/api/alerts` 并渲染。
- 修改文件
  - 更新 `public/index.html`：新增列表 DOM 与 JS。
- 代码片段
  - `public/index.html`（片段，添加在已有布局下方或侧边）
    ```html
    <div id="alerts-panel" style="margin-top: 12px;">
      <h3 style="color:#ddd;">提醒列表（最近）</h3>
      <ul id="alerts-list" style="list-style:none;padding-left:0;color:#ddd;"></ul>
    </div>

    <script>
      function formatBeijingTime(isoTs) {
        const date = new Date(isoTs);
        return date.toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        });
      }

      function renderAlerts(rows) {
        const list = document.getElementById('alerts-list');
        list.innerHTML = rows.map(r => {
          const dir = r.direction > 0 ? '↑' : (r.direction < 0 ? '↓' : '→');
          const pct = (Number(r.amplitude_pct) * 100).toFixed(2);
          const timeStr = formatBeijingTime(r.bucket);
          return `<li style="padding:6px 0;border-bottom:1px solid #333;">
            <strong>${r.symbol}</strong>
            <span style="margin-left:8px;">${timeStr}</span>
            <span style="margin-left:8px;">振幅 ${pct}% ${dir}</span>
            <span style="margin-left:8px;">O:${r.open} C:${r.close}</span>
          </li>`;
        }).join('');
      }

      async function loadAlerts() {
        try {
          const res = await fetch('/api/alerts?limit=50');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const rows = await res.json();
          if (Array.isArray(rows)) renderAlerts(rows);
        } catch (e) {
          console.error('loadAlerts error:', e);
        }
      }

      // 初次加载与轮询
      loadAlerts();
      setInterval(loadAlerts, 10000);
    </script>
    ```
- 如何验证
  - 浏览器访问 `http://localhost:3000/`，观察提醒列表每 10 秒刷新。
  - 控制台无错误；提醒项目显示符号、时间（北京时间）、振幅、方向与 O/C。
- DoD
  - 前端能稳定展示最新提醒列表；刷新不卡顿；时间显示为北京时区。

---

## 迭代 5：阈值配置与运维提示（轻量）

- 要做什么
  - 支持通过环境变量调整提醒阈值；文档化索引建议。
- 修改文件
  - 已在 `src/server.js` 读取 `ALERT_THRESHOLD_PCT`，此处仅说明使用。
- 如何验证
  - 设置环境变量后重启服务：
    - PowerShell：``$env:ALERT_THRESHOLD_PCT="0.015"; npm run start``
  - 观察提醒减少（阈值 1.5%）。
- DoD
  - 阈值可配置并生效；服务运行稳定。

---

## Git 使用建议（每步）

- 每步开始：
  - `git status` 确认干净；如不干净先 `git add -A && git commit -m "WIP"` 或 `git restore .`。
- 本步完成后：
  - `git add -A`
  - `git commit -m "迭代 X：<简述功能>"`
- 失败或偏离预期：
  - `git reset --hard HEAD` 回到本步开始前的干净状态（确保已提交前一步）。

---

## 验证总清单（DoD 汇总）

- 后端
  - 定时任务每 5 秒扫描当前/上一分钟，超过阈值入库；日志可见新提醒数量。
  - `/api/alerts` 返回最近提醒，字段齐全。
- 前端
  - 首页新增提醒列表，按北京时间展示，定时刷新，不卡顿。
- 配置
  - 阈值可通过环境变量调整，默认 1%。
- 数据库
  - `k_alerts` 表存在，唯一约束防重复；索引存在；可查询最近记录。

---

## 回滚与故障处理

- 如服务端监控导致负载过高或查询超时：
  - 暂停监控：注释 `startAlertMonitor()` 后重启。
  - 或将扫描频率从 5 秒改为 10–15 秒。
- 如提醒过多或误报：
  - 临时提高阈值：`ALERT_THRESHOLD_PCT=0.02`（2%）。
  - 后续再细化规则与数据清洗。

---

## 后续迭代建议（非本次范围）

- WebSocket 推送，前端更实时。
- 前端过滤条件与分页展示。
- 规则引擎（开收涨跌≥阈值、对前收变化≥阈值、量能异常）。
- 物化视图或分区表，提升当日聚合性能。
- 指标防抖与盘前盘后特殊处理。