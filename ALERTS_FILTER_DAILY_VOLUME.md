# 提醒列表隐藏当日成交总量小于 5000 的股票 — 设计方案

## 目标与范围
- 目标：在提醒列表（/alerts 与 /api/alerts）中隐藏“当日成交总量 < 5000”的股票提醒数据。
- 范围：仅影响“当日”提醒数据的展示与入库策略，不改动历史数据的统计与展示。
- 不改动代码：本文件仅为设计方案，指导后续实现与验证。

## 术语与口径
- 当日：以 `Asia/Shanghai` 时区的自然日为准（0:00–24:00）。
- 成交总量：以来源数据的“当日累计成交量”字段为准，若无该字段，采用分钟或交易粒度的“成交量”汇总。
- 隐藏：提醒查询接口不返回满足“当日成交总量 < 5000”的标的；或在入库阶段直接不写入。

## 数据来源假设
- 可能的数据源：
  - `market_data.minute_bars(symbol, bucket, volume)` 或同等分钟K数据表（含 `volume`）。
  - `market_data.trades(symbol, ts, qty)` 或逐笔成交数据（以 `qty` 汇总代表成交量）。
- 现有提醒表：`market_data.k_alerts`（已建索引 `symbol, bucket` 与 `created_at`）。

## 过滤口径定义
- 以当日累计成交量（自当日 00:00 起至当前查询时刻）为口径；若来源存在盘前/盘后数据，需根据业务约定是否计入。
- 处理缺失：当日成交量为 `NULL` 或找不到数据时，视为“< 5000”，予以隐藏。

## 实现方案

### 方案 A：服务端查询过滤（推荐，快速见效）
- 在 `/api/alerts` 查询中加入“当日成交量”子查询/视图，按 `symbol` 聚合当日成交量并过滤：
  - 伪 SQL（分钟线数据示例）：
    ```sql
    WITH today AS (
      SELECT date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'UTC' AS start_utc,
             (date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) + interval '1 day') AT TIME ZONE 'UTC' AS end_utc
    ), vol AS (
      SELECT mb.symbol, SUM(mb.volume) AS vol
      FROM market_data.minute_bars mb, today t
      WHERE mb.bucket >= t.start_utc AND mb.bucket < t.end_utc
      GROUP BY mb.symbol
    )
    SELECT a.*
    FROM market_data.k_alerts a
    JOIN vol v ON v.symbol = a.symbol
    WHERE v.vol >= 5000
      AND a.bucket >= (SELECT start_utc FROM today);
    ```
- 优点：改动集中在接口层；无需改动入库逻辑；可快速上线验证。
- 注意：需确保分钟/逐笔表索引覆盖 `bucket` 与 `symbol`，避免聚合慢查询。

### 方案 B：数据库物化视图 + 接口过滤（稳定高效）
- 建立当日成交量物化视图 `market_data.daily_volume_today(symbol, vol)`：
  - 生成逻辑按分钟/逐笔数据聚合；每 1–5 分钟刷新。
  - 在 `/api/alerts` 中 `JOIN daily_volume_today` 进行过滤。
- 优点：接口查询变轻；可复用到其他接口；刷新策略可控。
- 注意：需部署定时刷新（例如 `cron` 或应用内任务）；盘中高频更新时并发与锁定策略需评估。

### 方案 C：入库阶段抑制（源头消除）
- 在提醒生成（扫描/监控）阶段，先判断“当日成交量 < 5000”则不写入 `k_alerts`。
- 优点：下游无需过滤；减少不必要数据写入与存储。
- 风险：若口径或阈值调整需回溯，已丢弃的数据不可恢复；不利于复核与审计。

## 配置与参数化
- 新增环境变量：`DAILY_VOLUME_MIN=5000`（默认 5000），用于统一控制阈值。
- 新增可选环境变量：`INCLUDE_PREMARKET=false`（是否计入盘前/盘后）。
- 时间口径：统一在 SQL 端使用 `Asia/Shanghai` 转换，避免前后端口径不一致。

## 索引与性能建议
- 分别为分钟/逐笔数据源建立或确认索引：
  - `minute_bars(symbol, bucket)` 或 `trades(symbol, ts)` 组合索引。
  - 若以 `symbol` 聚合为主，考虑 `symbol` 前缀索引 + 时间范围过滤。
- 视图/子查询结果量较大时，优先采用物化视图或按盘中时段缓存。

## 边界与异常处理
- 无成交量数据：当日未交易或数据缺失，按“隐藏”处理。
- 时间边界：确保以 `Asia/Shanghai` 的当日区间进行聚合，避免跨日误计。
- 盘前/盘后：业务决定是否计入；若不计入需在聚合中排除时间段。
- 复牌/停牌：停牌日应聚合为 0，自动隐藏。

## 验证与 DoD
- 验证步骤：
  - 构造或选取一只当日成交量 < 5000 的标的，确认其提醒不再出现在 `/api/alerts` 与 `/alerts` 页面。
  - 构造或选取一只当日成交量 ≥ 5000 的标的，提醒正常展示。
  - 切换阈值（如 `DAILY_VOLUME_MIN=10000`），再次验证隐藏/展示行为是否随配置变化。
- DoD：
  - 接口响应时间可控（在既有基线范围内）。
  - 过滤行为与口径一致（时区、是否含盘前/盘后）。
  - 不影响提醒生成与其他功能。

## 回滚策略
- 若引入过滤导致接口超时或数据异常：
  - 立即移除 `/api/alerts` 侧的 `JOIN/WHERE` 过滤逻辑或停用物化视图引用。
  - 降低刷新频率或改回缓存方案，直至定位问题。

## 后续迭代建议
- 将当日成交量作为字段随提醒返回（例如 `daily_volume`），前端可显示或另行过滤。
- 引入“多维过滤”：支持成交额、换手率、流通市值等综合维度。
- 提供调试开关：在 `/alerts` 增加“显示被隐藏条目（灰显）”以便核查。