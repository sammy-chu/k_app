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