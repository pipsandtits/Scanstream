// Node script to apply SQL migration files (server + prisma) using pg.
// Expects DATABASE_URL in the environment. Applies files in deterministic order.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function collectSqlFiles(root) {
  const files = [];

  // Preferred order: apply Prisma migrations first, then server migrations
  // prisma migrations: each migration folder may contain migration.sql
  const prismaDir = path.join(root, 'prisma', 'migrations');
  if (fs.existsSync(prismaDir)) {
    for (const entry of fs.readdirSync(prismaDir).sort()) {
      const p = path.join(prismaDir, entry);
      try {
        const stat = fs.statSync(p);
        if (stat.isFile() && entry.endsWith('.sql')) {
          files.push(p);
        } else if (stat.isDirectory()) {
          const candidate = path.join(p, 'migration.sql');
          if (fs.existsSync(candidate)) files.push(candidate);
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // server migrations (applied after Prisma schema objects exist)
  const serverDir = path.join(root, 'server', 'migrations');
  if (fs.existsSync(serverDir)) {
    for (const f of fs.readdirSync(serverDir).sort()) {
      if (f.endsWith('.sql')) files.push(path.join(serverDir, f));
    }
  }

  return files;
}

async function applyFiles(files, client) {
  for (const file of files) {
    console.log('\n=== Applying', file, '===');
    // read file as buffer and attempt to detect UTF-16/UTF-8 encoding
    const buf = fs.readFileSync(file);
    let sql = null;
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      // UTF-16 LE BOM
      sql = buf.toString('utf16le');
    } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      // UTF-16 BE BOM
      // Node.js does not support utf16be directly; swap bytes then decode
      const swapped = Buffer.allocUnsafe(buf.length - 2);
      for (let i = 2; i < buf.length; i += 2) {
        swapped[i - 2] = buf[i + 1] || 0;
        swapped[i - 1] = buf[i] || 0;
      }
      sql = swapped.toString('utf16le');
    } else if (buf.includes(0x00)) {
      // Likely UTF-16LE without BOM
      sql = buf.toString('utf16le');
    } else {
      sql = buf.toString('utf8');
    }
    // Robust split: ignore semicolons inside single/double quotes and dollar-quoted strings
    function splitSqlStatements(src) {
      const stmts = [];
      let cur = '';
      let i = 0;
      let inSingle = false;
      let inDouble = false;
      let dollarTag = null; // e.g. $func$
      while (i < src.length) {
        const ch = src[i];

        // handle line comments --
        if (!inSingle && !inDouble && !dollarTag && src[i] === '-' && src[i+1] === '-') {
          // copy until end of line
          const nl = src.indexOf('\n', i+2);
          if (nl === -1) { cur += src.slice(i); break; }
          cur += src.slice(i, nl+1);
          i = nl + 1;
          continue;
        }

        // handle block comments /* */
        if (!inSingle && !inDouble && !dollarTag && src[i] === '/' && src[i+1] === '*') {
          const end = src.indexOf('*/', i+2);
          if (end === -1) { cur += src.slice(i); break; }
          cur += src.slice(i, end+2);
          i = end + 2;
          continue;
        }

        // handle dollar-quoted string start
        if (!inSingle && !inDouble && !dollarTag && src[i] === '$') {
          // find tag like $tag$
          const m = src.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
          if (m) {
            dollarTag = m[0];
            cur += dollarTag;
            i += dollarTag.length;
            continue;
          }
        }

        // handle dollar-quote end
        if (dollarTag) {
          if (src.slice(i, i + dollarTag.length) === dollarTag) {
            cur += dollarTag;
            i += dollarTag.length;
            dollarTag = null;
            continue;
          } else {
            cur += ch;
            i++;
            continue;
          }
        }

        // handle single/double quotes
        if (!inDouble && ch === "'") {
          inSingle = !inSingle;
          cur += ch; i++; continue;
        }
        if (!inSingle && ch === '"') {
          inDouble = !inDouble;
          cur += ch; i++; continue;
        }

        // semicolon outside quotes => statement boundary
        if (!inSingle && !inDouble && ch === ';') {
          const t = cur.trim();
          if (t.length > 0) stmts.push(t);
          cur = '';
          i++;
          continue;
        }

        // normal char
        cur += ch;
        i++;
      }
      if (cur.trim().length > 0) stmts.push(cur.trim());
      return stmts;
    }

    const statements = splitSqlStatements(sql);

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        await client.query(stmt);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (/already exists/i.test(msg) || /duplicate column/i.test(msg) || err.code === '42P07') {
          console.warn('Warning (skipped):', msg.split('\n')[0]);
          continue;
        }
        console.error('Error applying', file, 'statement', i + 1);
        console.error(msg);
        throw err;
      }
    }
    console.log('Applied', file);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set in environment. Export it and retry.');
    process.exit(2);
  }

  const root = process.cwd();
  const files = collectSqlFiles(root);
  if (files.length === 0) {
    console.log('No SQL migration files found.');
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await applyFiles(files, client);

    const res = await client.query("SELECT schemaname, tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;");
    console.log('\nPublic tables:');
    for (const row of res.rows) console.log(row.schemaname + '.' + row.tablename);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
