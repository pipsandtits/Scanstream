-- Migration: add model weights, checkpoints, RL Q-tables and experiences

-- Model weights / artifacts metadata (store metadata + optional binary blob or external URI)
CREATE TABLE IF NOT EXISTS model_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name TEXT NOT NULL,
  version TEXT,
  created_by TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  storage_uri TEXT, -- preferred: external storage (S3/FS)
  blob BYTEA, -- optional: store small weight blobs
  metadata JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_model_artifacts_name ON model_artifacts(model_name);

-- Simple Q-table storage (one row per state-action pair)
CREATE TABLE IF NOT EXISTS rl_q_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT,
  regime TEXT,
  state_key TEXT NOT NULL,
  action_key TEXT NOT NULL,
  q_value DOUBLE PRECISION NOT NULL,
  metadata JSONB DEFAULT '{}'::JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rl_q ON rl_q_table(domain, regime, state_key, action_key);
CREATE INDEX IF NOT EXISTS idx_rl_q_state ON rl_q_table(state_key);

-- RL experiences / replay buffer (append-only)
CREATE TABLE IF NOT EXISTS rl_experiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT,
  regime TEXT,
  state JSONB,
  action JSONB,
  reward DOUBLE PRECISION,
  next_state JSONB,
  done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_rl_experiences_domain ON rl_experiences(domain);
