-- Migration: 006_add_high_value_indexes.sql
-- Purpose: add high-value indexes recommended by the query optimization audit
-- The statements use guarded DO blocks so they safely create indexes even if
-- table naming conventions differ (PascalCase vs snake_case).

-- 1) MarketFrame composite index: (symbol, timeframe, timestamp DESC)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'MarketFrame') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_sym_tf_ts ON "MarketFrame"(symbol, timeframe, timestamp DESC)';
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'marketframe') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_sym_tf_ts ON marketframe(symbol, timeframe, timestamp DESC)';
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'market_frame') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_sym_tf_ts ON market_frame(symbol, timeframe, timestamp DESC)';
  END IF;
END
$$;

-- 2) Signal composite index: (symbol, timestamp DESC)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'Signal') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_signal_sym_ts ON "Signal"(symbol, timestamp DESC)';
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'signal') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_signal_sym_ts ON signal(symbol, timestamp DESC)';
  END IF;
END
$$;

-- 3) GIN indexes for JSONB columns on MarketFrame (indicators, price)
DO $$
BEGIN
  -- indicators
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name IN ('MarketFrame','marketframe','market_frame') AND column_name = 'indicators') THEN
    -- try several table name variants
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'MarketFrame') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_indicators_gin ON "MarketFrame" USING GIN (indicators)';
    ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'marketframe') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_indicators_gin ON marketframe USING GIN (indicators)';
    ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'market_frame') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_indicators_gin ON market_frame USING GIN (indicators)';
    END IF;
  END IF;

  -- price
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name IN ('MarketFrame','marketframe','market_frame') AND column_name = 'price') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'MarketFrame') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_price_gin ON "MarketFrame" USING GIN (price)';
    ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'marketframe') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_price_gin ON marketframe USING GIN (price)';
    ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'market_frame') THEN
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_marketframe_price_gin ON market_frame USING GIN (price)';
    END IF;
  END IF;
END
$$;

-- 4) model_checkpoints composite index: (model_name, created_at DESC)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'model_checkpoints') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_model_checkpoints_model_createdat ON model_checkpoints(model_name, created_at DESC)';
  END IF;
END
$$;

-- End of migration
