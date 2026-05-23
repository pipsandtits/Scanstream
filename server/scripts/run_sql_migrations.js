const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function collectSqlFiles() {
  const root = process.cwd();
  const files = [];

  // server migrations
  const serverDir = path.join(root, 'server', 'migrations');
  if (fs.existsSync(serverDir)) {
    for (const f of fs.readdirSync(serverDir).sort()) {
      if (f.endsWith('.sql')) files.push(path.join(serverDir, f));
    }
  }

  // prisma migrations: top-level .sql files
  const prismaDir = path.join(root, 'prisma', 'migrations');
  if (fs.existsSync(prismaDir)) {
    for (const f of fs.readdirSync(prismaDir).sort()) {
      const p = path.join(prismaDir, f);
      if (fs.statSync(p).isFile() && f.endsWith('.sql')) {
        files.push(p);
      }
      if (fs.statSync(p).isDirectory()) {
        const candidate = path.join(p, 'migration.sql');
        if (fs.existsSync(candidate)) files.push(candidate);
      }
    }
  }

  return files;
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set in environment.');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const files = collectSqlFiles();
  if (files.length === 0) {
    console.log('No SQL migration files found.');
    await client.end();
    return;
  }

  for (const file of files) {
    console.log('\n=== Applying', file, '===');
    const sql = fs.readFileSync(file, 'utf8');
    try {
      await client.query(sql);
      console.log('Applied', file);
    } catch (err) {
      console.error('Error applying', file);
      console.error(err.message || err);
      await client.end();
      process.exit(2);
    }
  }

  // list public tables
  const res = await client.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
  console.log('\nPublic tables:');
  for (const row of res.rows) console.log(row.schemaname + '.' + row.tablename);

  await client.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
