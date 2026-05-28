# 成交量提醒重构方案：分离存储至独立数据表

## 1. 现状分析

目前成交量提醒（`daily_volume_pct`）与价格波动提醒共用 `k_alerts` 表。这种设计存在以下问题：
*   **字段冗余与语义不符**：`k_alerts` 表包含 `open`, `high`, `low`, `close` 等价格字段，对于成交量提醒，这些字段被强制置为 `0`，造成存储浪费。
*   **字段复用造成的混淆**：成交量的“量比”被迫存储在 `amplitude_pct`（振幅百分比）字段中，语义不明确。
*   **扩展性受限**：未来如果需要记录成交量的具体数值（如当日累积量、历史均量），现有表结构难以支持。

## 2. 数据库设计 (Database Schema)

我们将创建一个新的专用表 `k_volume_alerts`。

```sql
CREATE TABLE IF NOT EXISTS k_volume_alerts (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    bucket TIMESTAMP NOT NULL,        -- 时间桶（通常为触发时的分钟）
    volume_ratio NUMERIC NOT NULL,    -- 量比 (例如 1.5 代表 150%)
    current_cum_vol NUMERIC,          -- 触发时的当日累积成交量
    avg_daily_vol NUMERIC,            -- 对比用的历史均量
    created_at TIMESTAMPTZ DEFAULT now(),
    
    -- 唯一约束，防止同一分钟重复报警
    CONSTRAINT uq_vol_alerts_symbol_bucket UNIQUE (symbol, bucket)
);
```

## 3. 代码修改计划

### 3.1 后端修改 (`src/server.js`)

需要修改两个主要部分：扫描写入逻辑和查询接口。

#### A. 修改扫描/写入接口 (`POST /api/alerts/daily-volume-pct/scan`)

**当前逻辑**：
```javascript
INSERT INTO k_alerts(symbol, bucket, open, high, low, close, amplitude_pct, direction, rule_id)
VALUES ($1, $2, 0, 0, 0, 0, $3, 1, 'daily_volume_pct')
...
```

**新逻辑**：
*   不再写入 `k_alerts`。
*   改为写入 `k_volume_alerts`。
*   需要将计算出的 `cum` (累积量) 和 `avg` (均量) 也一并写入，提供更多上下文。

```javascript
// 伪代码
const insertSql = `
  INSERT INTO k_volume_alerts(symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (symbol, bucket) DO NOTHING
  RETURNING id;`;
await pool.query(insertSql, [symbol, bucket, pct, cum, avg]);
```

#### B. 新增查询接口 (`GET /api/volume-alerts-data`)

**当前逻辑**：
前端复用 `GET /api/alerts` 接口，通过 `rule_id` 过滤。

**新逻辑**：
创建一个专门的接口来读取新表的数据。

```javascript
app.get('/api/volume-alerts-data', async (req, res) => {
  // ... 参数处理 (limit, since)
  const sql = `
    SELECT symbol, bucket, volume_ratio, current_cum_vol, avg_daily_vol, created_at
    FROM k_volume_alerts
    ORDER BY created_at DESC
    LIMIT $1
  `;
  // ... 执行查询并返回
});
```

### 3.2 前端修改 (`public/volume-alerts.html`)

需要更新数据获取和渲染逻辑以匹配新 API 和新字段。

1.  **API 调用 URL**：
    *   从 `/api/alerts?limit=50&rule_id=daily_volume_pct`
    *   改为 `/api/volume-alerts-data?limit=50`

2.  **渲染逻辑 (`renderAlerts`)**：
    *   字段映射调整：
        *   `alert.amplitude_pct` -> `alert.volume_ratio`
    *   展示增强（可选）：
        *   利用新增的 `current_cum_vol` 和 `avg_daily_vol`，可以在鼠标悬停或详情中显示“当前量/均量”的具体数值。

## 4. 实施步骤

1.  **数据库变更**：在数据库中执行 `CREATE TABLE` 语句。
2.  **后端开发**：
    *   实现 `GET /api/volume-alerts-data`。
    *   修改 `POST /api/alerts/daily-volume-pct/scan` 写入新表。
3.  **前端开发**：更新 `public/volume-alerts.html` 适配新接口。
4.  **验证**：
    *   手动触发一次扫描，确认数据写入新表。
    *   刷新前端页面，确认能正常显示新表的数据。
