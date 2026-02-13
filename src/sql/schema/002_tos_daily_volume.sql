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
