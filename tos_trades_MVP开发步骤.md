# tos_trades 功能开发步骤（MVP - 优化版）

## 1. 方案评估与优化

### 核心优化点
- **Schema 版本化**：将建表 DDL 保存为独立 SQL 文件，便于 Git 追踪与部署。
- **安全性增强**：在 API 层增加日期格式（`YYYY-MM-DD`）的正则校验，防止 SQL 注入或格式错误。
- **性能/实时性平衡**：
  - **历史/区间统计**：走日汇总表（`tos_daily_volume`），查询速度提升 100x。
  - **当日实时**：走明细表（`tos_trades`），保证秒级实时性。
- **可维护性**：明确了定时任务的配置方式与交易日识别逻辑。

## 2. MVP 原则与控制

- **范围控制（不做清单）**：
  - 不做多市场日历与跨时区自动转换（统一用数据中的时间）。
  - 不做实时流式处理（使用定时轮询）。
  - 不做复杂权限系统。
- **开发原则**：
  - **小步快跑**：一次只做一个步骤，DoD 达成后再进行下一步。
  - **Git 策略**：每个功能从 `git status` 干净状态开始；失败时 `git restore .` 重置。

## 3. 开发步骤详解

### 步骤 1：初始化日成交量汇总表

#### 要做什么
- 创建存放 SQL 的目录（如果不存在）。
- 编写建表 SQL 文件。
- 执行 SQL 初始化数据库。

#### 需要修改/创建的文件
- 创建 `src/sql/schema/002_tos_daily_volume.sql`

#### 代码片段

**src/sql/schema/002_tos_daily_volume.sql**
```sql
-- 开启事务
BEGIN;

-- 创建日成交量汇总表
CREATE TABLE IF NOT EXISTS market_data.tos_daily_volume (
  symbol TEXT NOT NULL,
  trade_date DATE NOT NULL,
  daily_volume NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, trade_date)
);

-- 创建日期索引（加速区间查询）
CREATE INDEX IF NOT EXISTS idx_tos_daily_volume_date
ON market_data.tos_daily_volume (trade_date);

COMMIT;
```

#### 如何验证
- 执行导入：使用数据库工具或 `psql` 执行该文件。
- 验证命令：
  ```bash
  # 假设使用 psql (需替换实际连接串)
  # psql "$DATABASE_URL" -f src/sql/schema/002_tos_daily_volume.sql
  
  # 或者在 Node.js 中临时运行:
  # node -e "require('./src/db').pool.query(require('fs').readFileSync('./src/sql/schema/002_tos_daily_volume.sql', 'utf8')).then(() => console.log('Done'))"
  ```
- 检查表是否存在：`SELECT to_regclass('market_data.tos_daily_volume');`

#### DoD
- 数据库中存在 `tos_daily_volume` 表。
- `src/sql/schema` 目录下有对应的 SQL 文件并已提交 Git。

#### Git
- `git add src/sql/schema/002_tos_daily_volume.sql`
- `git commit -m "feat: add tos_daily_volume table schema"`

---

### 步骤 2：实现增量刷新 API (ETL)

#### 要做什么
- 实现按日期区间刷新汇总表的 API。
- 增加日期格式校验。

#### 需要修改的文件
- `src/server.js`

#### 代码片段

**src/server.js**
```js
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
    await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    
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
                 END) BETWEEN $1::date AND $2::date
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
```

#### 如何验证
- 触发刷新：`curl -X POST "http://localhost:8889/api/volume/daily-refresh?start=2025-10-01&end=2025-10-08"`
- 验证数据：`SELECT * FROM market_data.tos_daily_volume LIMIT 5;`

#### DoD
- API 返回 200 OK。
- 汇总表中出现对应日期的数据。
- 错误参数（如 `start=abc`）返回 400。

---

### 步骤 3：配置定时刷新任务

#### 要做什么
- 建立自动化刷新机制，确保汇总表数据即时性。

#### 实施方案 (Linux Cron 示例)

```bash
# 1. 打开 cron 编辑
crontab -e

# 2. 添加任务 (每 5 分钟刷新当天)
*/5 * * * * curl -s -X POST "http://localhost:8889/api/volume/daily-refresh?start=$(date +\%F)\&end=$(date +\%F)" >> /tmp/cron_volume_refresh.log 2>&1

# 3. 添加任务 (每天凌晨 1 点刷新昨天和今天，进行回补)
0 1 * * * curl -s -X POST "http://localhost:8889/api/volume/daily-refresh?start=$(date -d 'yesterday' +\%F)\&end=$(date +\%F)"
```

#### DoD
- 无需代码提交，需在部署环境验证 Cron 运行日志。

---

### 步骤 4：区间成交量汇总 API (基于汇总表)

#### 要做什么
- 从 `tos_daily_volume` 查询数据，提供汇总与 CSV 导出。

#### 需要修改的文件
- `src/server.js`

#### 代码片段

**src/server.js**
```js
app.get('/api/volume/summary', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const order = String(req.query.order || 'total').trim();
  const format = String(req.query.format || 'json').trim();

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'invalid_date_format' });
  }

  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  
  // 1. 动态排序字段
  const orderBy = order === 'avg' ? 'avg_volume' : 'total_volume';
  
  // 2. 查询汇总表 (性能极快)
  const sql = `
    SELECT symbol,
           SUM(daily_volume) AS total_volume,
           ROUND(AVG(daily_volume), 2) AS avg_volume
    FROM tos_daily_volume
    WHERE trade_date >= $1::date AND trade_date < $2::date
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
```

#### 如何验证
- JSON: `curl "http://localhost:8889/api/volume/summary?start=2025-10-01&end=2025-10-08"`
- CSV: 浏览器访问 `...&format=csv`

#### DoD
- 响应速度 < 200ms（即使数据量很大）。
- CSV 包含完整数据。

---

### 步骤 5：平均日成交量与今日累积 API

#### 要做什么
- 实现历史均量（查汇总表）和今日累积（查明细表）的查询接口。

#### 需要修改的文件
- `src/server.js`

#### 代码片段

**src/server.js**
```js
// 历史均量 (查汇总表)
app.get('/api/volume/avg-daily', async (req, res) => {
  const symbol = String(req.query.symbol || '').trim();
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  
  if (!symbol || !isValidDate(start) || !isValidDate(end)) return res.status(400).json({ error: 'invalid_params' });
  
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  
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
  
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
  
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
```

#### 如何验证
- 历史均量: `curl "http://localhost:8889/api/volume/avg-daily?symbol=AAPL.NQ&start=2025-10-01&end=2025-10-05"`
- 今日实时: `curl "http://localhost:8889/api/volume/cumulative?symbol=AAPL.NQ&date=$(date +%F)"`

#### DoD
- 历史均量与汇总表计算一致。
- 今日累积随新交易实时增加。

---

### 步骤 6：阈值扫描与提醒写入

#### 要做什么
- 组合上述逻辑：`今日累积 / 历史均量 >= 阈值` ? 写入提醒。

#### 需要修改的文件
- `src/server.js`

#### 代码片段

**src/server.js**
```js
app.post('/api/alerts/daily-volume-pct/scan', async (req, res) => {
  const { symbol, date, start, end, threshold } = req.query;
  
  if (!symbol || !isValidDate(date) || !isValidDate(start) || !isValidDate(end) || !threshold) {
    return res.status(400).json({ error: 'params_missing_or_invalid' });
  }
  
  await pool.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));

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
  
  // 4. 写入提醒 (幂等)
  const insertSql = `
    INSERT INTO k_alerts(symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id)
    VALUES ($1, $2, 0, 0, 0, 0, $3, 1, 'daily_volume_pct')
    ON CONFLICT (symbol, bucket, rule_id) DO NOTHING
    RETURNING id;`;
    
  const tx = await pool.query(insertSql, [symbol, cumRes.rows[0].now_bucket, pct]);
  res.json({ triggered: tx.rowCount > 0, pct, bucket: cumRes.rows[0].now_bucket });
});
```

#### 如何验证
- 模拟触发：设置一个很低的 `threshold` (e.g., 0.0001) 确保触发。
- 检查数据库：`SELECT * FROM market_data.k_alerts WHERE rule_id = 'daily_volume_pct' ORDER BY created_at DESC LIMIT 1;`

#### DoD
- 只有满足条件时才写入。
- 重复调用不会产生重复记录（基于 bucket 分钟级去重）。

---

### 步骤 7：前端展示适配

#### 要做什么
- 在提醒列表页正确展示 `daily_volume_pct` 类型的提醒文案。

#### 需要修改的文件
- `public/alerts.html`

#### 代码片段

**public/alerts.html**
```javascript
// 在 renderAlerts 或类似的渲染循环中
function formatAlertText(alert) {
  const val = parseFloat(alert.amplitude_pct);
  
  if (alert.rule_id === 'daily_volume_pct') {
    return `当日量达均量 ${(val * 100).toFixed(0)}%`;
  }
  
  // 默认展示振幅
  return `振幅 ${(val * 100).toFixed(2)}%`;
}

// 调用示例
// const text = formatAlertText(alertItem);
// element.innerText = text;
```

#### 如何验证
- 打开页面 `http://localhost:8889/alerts`。
- 确认新产生的提醒显示为“当日量达均量 150%”等格式。

#### DoD
- 现有振幅提醒显示正常。
- 新成交量提醒显示正常。
