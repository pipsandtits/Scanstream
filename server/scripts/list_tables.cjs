const { Client } = require('pg');
(async () => {
  const db = process.env.DATABASE_URL;
  if (!db) { console.error('DATABASE_URL not set'); process.exit(2); }
  const c = new Client({ connectionString: db });
  await c.connect();
  const r = await c.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  console.log(r.rows.map(r => `${r.schemaname}.${r.tablename}`).join('\n'));
  await c.end();
})();
