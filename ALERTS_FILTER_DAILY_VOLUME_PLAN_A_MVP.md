# 方案A：接口查询侧过滤（MVP实施步骤）

目标：在提醒接口 `/api/alerts` 与提醒列表 `/alerts` 的数据源上，隐藏“当日成交总量 < 5000”的标的，不影响提醒入库与历史审计。

---

## 范围与原则
- 小步快跑：一次只实现一个功能，逐步验证。
- 最小改动：仅在接口查询层做过滤，不改前端、不改入库逻辑。
- 可配置：阈值通过环境变量控制，默认 5000。
- 保持审计：提醒仍入库，接口侧过滤仅影响展示。

## 不做清单（控制范围）
- 不做前端过滤器与UI变更（先复用现有列表页）。
- 不做数据库物化视图与缓存（后续性能优化再考虑）。
- 不做入库阶段抑制（避免数据不可回溯）。
- 不做盘前/盘后精细口径（统一按自然日，后续再细化）。

## 前置条件
- 数据库中存在分钟或逐笔成交数据源，包含 `symbol` 与时间列、量（`volume/qty`）。
- 服务器可正常启动：`npm run start`，访问 `http://localhost:8889/health` 返回 `{ ok: true }`。

---

## 迭代 0：基线确认
- 要做什么
  - 确认当前分支与工作树干净，服务可启动、接口正常返回。
- 如何验证
  - 命令：
    - `git status`
    - `npm run start`
    - `curl http://localhost:8889/health`
  - 浏览器：访问 `http://localhost:8889/alerts` 正常渲染。
- DoD
  - 工作树干净；服务与提醒列表页正常，无报错。

---

## 迭代 1：引入阈值配置（不改逻辑，仅配置）
- 要做什么
  - 约定使用环境变量 `DAILY_VOLUME_MIN` 控制最小当日成交量阈值，默认 `5000`。
- 如何验证
  - Windows 启动命令（终端）：
    - `set DAILY_VOLUME_MIN=5000 && npm run start`
  - 在服务日志中打印读取到的阈值（可选）。
- DoD
  - 服务可从环境读取到阈值；不影响现有接口行为。

---

## 迭代 2：在 `/api/alerts` 查询侧加入当日成交量过滤
- 要做什么
  - 修改 `src/server.js` 中 `/api/alerts` 的查询 SQL：
    - 计算“上海时区当日”的 UTC 时间窗。
    - 聚合当日每个 `symbol` 的成交总量。
    - 与提醒表 `k_alerts` 关联，根据 `DAILY_VOLUME_MIN` 过滤。
- 修改文件
  - `src/server.js`
- 代码片段（示例，替换现有 `/api/alerts` 查询）：
  ```js
  // 读取阈值（默认5000）
  const MIN_VOL = Number(process.env.DAILY_VOLUME_MIN ?? 5000);

  // 示例路由片段（保持原有limit/分页参数处理）
  app.get('/api/alerts', async (req, res) => {
    const limit = Number(req.query.limit ?? 50);

    const sql = `
      WITH today AS (
        SELECT
          -- 以上海时区的当日开始/结束，转换为UTC以匹配库中时间列
          (date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'UTC') AS start_utc,
          ((date_trunc('day', (now() AT TIME ZONE 'Asia/Shanghai')) + interval '1 day') AT TIME ZONE 'UTC') AS end_utc
      ), vol AS (
        SELECT mb.symbol, SUM(mb.volume) AS vol
        FROM market_data.minute_bars mb, today t
        WHERE mb.bucket >= t.start_utc AND mb.bucket < t.end_utc
        GROUP BY mb.symbol
      )
      SELECT a.*
      FROM market_data.k_alerts a
      JOIN today t ON true
      JOIN vol v ON v.symbol = a.symbol
      WHERE a.bucket >= t.start_utc
        AND v.vol >= $1
      ORDER BY a.created_at DESC
      LIMIT $2;
    `;

    try {
      const { rows } = await pool.query(sql, [MIN_VOL, limit]);
      res.json(rows);
    } catch (e) {
      console.error('alerts query failed:', e);
      res.status(500).json({ error: 'alerts query failed' });
    }
  });
  ```
  - 若数据源不是分钟线、而是逐笔成交（字段为 `qty` 与 `ts`）：将 `minute_bars`/`bucket` 替换为 `trades`/`ts`，并将 `SUM(mb.volume)` 改为 `SUM(tr.qty)`。
- 如何验证
  - 命令：
    - 启动：`set DAILY_VOLUME_MIN=5000 && npm run start`
    - `curl "http://localhost:8889/api/alerts?limit=50"`
  - 观察：接口返回的结果中不应出现当日成交量 < 5000 的标的；若某标的在当日没有任何成交数据，则因 `JOIN` 不命中而被隐藏。
- DoD
  - 接口数据已按阈值过滤；服务无错误日志；响应时间在基线可接受范围内。

---

## 迭代 3：缺失数据兜底与稳定性
- 要做什么
  - 明确缺失成交量数据的处理：无当日数据的标的视为 `< 5000`，继续隐藏。
  - 如需显式兜底，可改为 `LEFT JOIN vol` + `WHERE COALESCE(v.vol, 0) >= $1`（可选，当前 `JOIN` 已满足隐藏缺失）。
- 修改文件
  - `src/server.js`（若选择显式兜底）
- 代码片段（可选替换 JOIN 为 LEFT JOIN）：
  ```sql
  ...
  FROM market_data.k_alerts a
  JOIN today t ON true
  LEFT JOIN vol v ON v.symbol = a.symbol
  WHERE a.bucket >= t.start_utc
    AND COALESCE(v.vol, 0) >= $1
  ...
  ```
- 如何验证
  - 使用一只当日无交易/数据缺失的标的，确认其提醒不返回。
- DoD
  - 缺失数据的标的被隐藏；接口稳定，无异常。

---

## 迭代 4：前端页联动验证（无前端改动）
- 要做什么
  - 通过现有 `/alerts` 页面查看过滤效果，确保列表减少低量标的条目。
- 如何验证
  - 浏览器：访问 `http://localhost:8889/alerts`
  - 对比：与未过滤前的条目数量、具体标的，确认低量标的消失。
- DoD
  - 列表显示与接口结果一致，无前端错误。

---

## 迭代 5：索引与性能检查（建议）
- 要做什么
  - 为分钟/逐笔数据源确认或创建必要索引，避免当日聚合慢查询。
- 修改文件
  - 无（执行数据库DDL，建议写入 `src/sql/alerts.sql` 或新建 `src/sql/volume_idx.sql` 作为文档记录）。
- 代码片段（Postgres DDL 示例）：
  ```sql
  -- 分钟线：确保按 symbol + bucket 查询与聚合高效
  CREATE INDEX IF NOT EXISTS idx_minute_bars_symbol_bucket
    ON market_data.minute_bars(symbol, bucket);

  -- 逐笔成交：确保按 symbol + ts 范围聚合高效
  CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts
    ON market_data.trades(symbol, ts);
  ```
- 如何验证
  - `EXPLAIN`（或 `EXPLAIN ANALYZE` 在测试环境）查看聚合查询使用索引。
  - 接口响应时间稳定，无明显超时增长。
- DoD
  - 聚合查询路径合理；接口性能在预期范围内。

---

## Git 操作建议
- 每步前：确保干净状态
  - `git status`
  - 若有未预期改动：`git restore -S .` 或 `git reset --hard HEAD`
- 每步后：提交清晰、原子化的 commit
  - 示例信息：
    - 迭代1：`chore(config): read DAILY_VOLUME_MIN from env`
    - 迭代2：`feat(alerts): filter by today aggregated volume (>= MIN_VOL)`
    - 迭代3：`fix(alerts): hide missing-volume symbols via COALESCE`（如采用）
    - 迭代5：`docs(sql): add index suggestions for volume aggregation`
- 失败时：果断回滚
  - `git reset --hard HEAD~1`
  - 或使用标签/分支隔离尝试。

---

## 回滚策略
- 暂停过滤：将 `DAILY_VOLUME_MIN` 设为 `0` 或移除过滤子句，恢复原始数据。
- 出现性能问题：临时提高阈值、缩小 `limit`；或先移除过滤以定位问题。

---

## 终验（End-to-End）
- 要做什么
  - 以真实数据完成一整套过滤流程体验。
- 如何验证
  - 启动：`set DAILY_VOLUME_MIN=5000 && npm run start`
  - 接口：`curl "http://localhost:8889/api/alerts?limit=100"`
  - 页面：`http://localhost:8889/alerts`
  - 观察：低量标的提醒不出现；变更阈值（如 `10000`）过滤行为随之变化。
- DoD
  - 过滤行为正确、可配置；性能与稳定性符合预期；不影响提醒入库与其他功能。