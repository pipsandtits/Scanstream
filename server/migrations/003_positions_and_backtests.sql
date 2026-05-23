-- Migration: add positions and backtest run tables
-- Created by migration generator

-- Positions table (open and historical positions)
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  portfolio_id TEXT REFERENCES "Portfolio"(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  exchange TEXT,
  side TEXT, -- LONG/SHORT
  size DOUBLE PRECISION,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  entry_timestamp TIMESTAMP,
  exit_timestamp TIMESTAMP,
  pnl DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open', -- open/closed/cancelled
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

-- Backtest runs summary
CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP,
  parameters JSONB DEFAULT '{}'::JSONB,
  summary JSONB DEFAULT '{}'::JSONB,
  created_by TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_started ON backtest_runs(started_at);

-- Backtest positions (per-run detail)
CREATE TABLE IF NOT EXISTS backtest_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_run_id UUID REFERENCES backtest_runs(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  entry_index INTEGER,
  exit_index INTEGER,
  pnl DOUBLE PRECISION,
  metadata JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_backtest_positions_run ON backtest_positions(backtest_run_id);
