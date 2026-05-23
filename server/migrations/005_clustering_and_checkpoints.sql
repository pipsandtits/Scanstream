-- Migration: add clustering results and model checkpoints

-- Clustering results (store cluster assignments / metadata)
CREATE TABLE IF NOT EXISTS clustering_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  algorithm TEXT,
  parameters JSONB DEFAULT '{}'::JSONB,
  clusters JSONB DEFAULT '{}'::JSONB,
  created_by TEXT REFERENCES "User"(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_clustering_algo ON clustering_results(algorithm);

-- Model checkpoints (lightweight records pointing to artifacts)
CREATE TABLE IF NOT EXISTS model_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID REFERENCES model_artifacts(id) ON DELETE SET NULL,
  model_name TEXT,
  version TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  description TEXT,
  metadata JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_model_checkpoints_model ON model_checkpoints(model_name);
