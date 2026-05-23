-- Migration: add DecisionEvent model and correlationId to TradeProvenance

ALTER TABLE "TradeProvenance" ADD COLUMN IF NOT EXISTS "correlationId" text;

CREATE TABLE IF NOT EXISTS "DecisionEvent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "correlationId" text,
  "phase" text NOT NULL,
  "domain" text,
  "actionPayload" jsonb,
  "metrics" jsonb,
  "agentIds" text[],
  "moduleVersion" text,
  "marketFrameId" text,
  "timestamp" timestamptz DEFAULT now(),
  "extra" jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS "DecisionEvent_correlationId_idx" ON "DecisionEvent" ("correlationId");
CREATE INDEX IF NOT EXISTS "DecisionEvent_timestamp_idx" ON "DecisionEvent" ("timestamp");
