const { Client } = require('pg');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set in environment.');
    process.exit(2);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const sql = `
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    CREATE TABLE IF NOT EXISTS "TradeProvenance" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "tradeId" text,
      "engine" text NOT NULL,
      "symbol" text NOT NULL,
      "correlationId" text,
      "signalId" text,
      "signal" jsonb,
      "consensus" jsonb,
      "agentDecision" jsonb,
      "execution" jsonb,
      "extra" jsonb DEFAULT '{}'::jsonb,
      "createdAt" timestamptz DEFAULT now()
    );
  `;

  try {
    await client.query(sql);
    console.log('Ensured TradeProvenance table exists');
  } catch (err) {
    console.error('Error creating TradeProvenance:', err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
