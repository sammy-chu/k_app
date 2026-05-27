-- 为 k_volume_alerts 添加 rule_id 列，支持多维告警（放量/缩量/连续放量）
BEGIN;

ALTER TABLE k_volume_alerts ADD COLUMN IF NOT EXISTS rule_id TEXT NOT NULL DEFAULT 'volume_surge';

-- 将 UNIQUE 约束从 (symbol, bucket) 改为 (symbol, bucket, rule_id)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_vol_alerts_symbol_bucket') THEN
    ALTER TABLE k_volume_alerts DROP CONSTRAINT uq_vol_alerts_symbol_bucket;
    ALTER TABLE k_volume_alerts ADD CONSTRAINT uq_vol_alerts_symbol_bucket_rule
      UNIQUE (symbol, bucket, rule_id);
  END IF;
END $$;

COMMIT;
