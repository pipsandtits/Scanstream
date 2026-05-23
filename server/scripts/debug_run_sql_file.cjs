const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const file = process.argv[2] || 'prisma/migrations/add_rpg_agents.sql';
  const db = process.env.DATABASE_URL;
  if (!db) { console.error('DATABASE_URL not set'); process.exit(2); }
  const buf = fs.readFileSync(file);
  let sql;
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) sql = buf.toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) { swapped[i-2] = buf[i+1] || 0; swapped[i-1] = buf[i] || 0; }
    sql = swapped.toString('utf16le');
  } else if (buf.includes(0x00)) sql = buf.toString('utf16le'); else sql = buf.toString('utf8');

  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  console.log('Found', statements.length, 'statements');

  const client = new Client({ connectionString: db });
  await client.connect();
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    console.log('\n--- Statement', i+1, '---');
    console.log(stmt.slice(0,400));
    try {
      await client.query(stmt);
      console.log('OK');
    } catch (err) {
      console.error('FAILED at statement', i+1, 'error:', err.message || err);
      await client.end();
      process.exit(1);
    }
  }
  console.log('\nAll statements executed');
  await client.end();
})();
