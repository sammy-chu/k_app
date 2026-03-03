# tos_trades 方案

## 表结构字段

- id：主键ID
- symbol：交易品种，如 AAPL.NQ, 0700.HK
- trade_time：成交时间（市场时间）
- market_time：市场时间
- price：成交价格，精度到 0.0001
- size：成交数量
- condition：成交条件代码
- tick：价格变动方向：U=上涨, D=下跌, E=平盘
- mmid：做市商ID，如 NSDQ, ARCA
- received_at：接收时间戳，微秒精度
- created_at：创建时间戳

## 需求一：区间成交量汇总、均值、排序与导出

### 核心计算

- 按 symbol 分组，统计区间内 sum(size) 与 avg(size)
- 以 trade_time 或 market_time 作为时间字段，建议使用 trade_time

### SQL 示例

```sql
SELECT
  symbol,
  SUM(size) AS total_volume,
  AVG(size) AS avg_volume
FROM tos_trades
WHERE trade_time >= :start_date
  AND trade_time < :end_date_plus_1day
GROUP BY symbol
ORDER BY total_volume DESC;
```

### 导出方式

- 数据库导出：如 COPY / SELECT INTO OUTFILE 输出 CSV
- 应用层导出：查询后写出 CSV / Excel

### 性能建议

- 建索引：`(trade_time, symbol)` 或 `(symbol, trade_time)`
- 大数据量场景：建立日维度聚合表，加速统计

## 需求二：阈值提醒

### 计算流程

1. 计算历史区间内每日成交量

```sql
SELECT
  symbol,
  DATE(trade_time) AS trading_date,
  SUM(size) AS daily_volume
FROM tos_trades
WHERE trade_time >= :hist_start
  AND trade_time < :hist_end_plus_1day
GROUP BY symbol, DATE(trade_time);
```

2. 计算平均日成交量（对每日成交量再求平均）
3. 统计今日累计成交量

```sql
SELECT
  symbol,
  SUM(size) AS today_volume
FROM tos_trades
WHERE trade_time >= :today_start
  AND trade_time < :today_end
GROUP BY symbol;
```

4. 触发条件

- today_volume >= avg_daily_volume * threshold

### 提醒方式

- 定时任务：分钟级汇总后对比阈值并提醒
- 流式处理：实时累计与阈值判断

### 注意点

- 交易日与自然日区分
- trade_time 与 market_time 时区一致
- 阈值可配置为倍率或百分比

## 补充建议

- size 使用整数或高精度数值类型
- 统计窗口需明确：自然日、交易日、或自定义区间
