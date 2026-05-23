#!/usr/bin/env node
// Replay or post bars from a JSONL feed, with an optional price shock injection.
// Usage examples:
// 1) Create shocked feed file:
//    node inject_shock.js --in data/test-feeds/btc_normal.jsonl --out data/test-feeds/btc_shock.jsonl --shock-index 100 --multiplier 0.5
// 2) Replay to an HTTP ingestion endpoint (POST each bar):
//    node inject_shock.js --in data/test-feeds/btc_shock.jsonl --post http://localhost:3000/api/push-bar --delay 100

const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = process.argv[i+1] && !process.argv[i+1].startsWith('--') ? process.argv[++i] : true;
    args[key] = val;
  }
  return args;
}

async function readJsonl(file) {
  const data = await fs.promises.readFile(file, 'utf8');
  return data.trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
}

async function writeJsonl(file, bars) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, bars.map(b => JSON.stringify(b)).join('\n') + '\n', 'utf8');
}

async function postBar(postUrl, bar) {
  const u = url.parse(postUrl);
  const data = JSON.stringify(bar);
  const opts = { hostname: u.hostname, port: u.port, path: u.path, method: 'POST', headers: {'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(data) } };
  const lib = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, res => {
      let body = '';
      res.on('data', d=> body += d);
      res.on('end', ()=> resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const args = parseArgs();
  const input = args.in;
  if (!input) { console.error('Missing --in feed file'); process.exit(2); }
  const bars = await readJsonl(input);

  const shockIndex = args['shock-index'] !== undefined ? parseInt(args['shock-index'], 10) : null;
  const multiplier = args.multiplier !== undefined ? parseFloat(args.multiplier) : 0.5;
  const out = args.out;
  const post = args.post;
  const delay = args.delay ? parseInt(args.delay,10) : 0;

  if (shockIndex !== null && shockIndex >= 0 && shockIndex < bars.length) {
    const b = bars[shockIndex];
    const origOpen = b.open, origHigh = b.high, origLow = b.low, origClose = b.close;
    b.open = origOpen * multiplier;
    b.high = origHigh * multiplier;
    b.low = origLow * multiplier;
    b.close = origClose * multiplier;
    b.shockInjected = { index: shockIndex, multiplier, original: { open: origOpen, high: origHigh, low: origLow, close: origClose } };
    console.log('Injected shock at index', shockIndex, 'multiplier', multiplier);
  }

  if (out) {
    await writeJsonl(out, bars);
    console.log('Wrote', out);
  }

  if (post) {
    for (let i = 0; i < bars.length; i++) {
      const res = await postBar(post, bars[i]);
      console.log('Posted', i, 'status', res.status);
      if (delay) await new Promise(r => setTimeout(r, delay));
    }
    console.log('Finished posting to', post);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
