#!/usr/bin/env node
// Simple synthetic OHLC bar generator — writes JSONL to specified output
// Usage: node generate_feed.js --symbol BTC/USDT --bars 500 --start 30000 --vol 0.01 --out data/test-feeds/btc_normal.jsonl

const fs = require('fs');
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

function randNormal(mu=0, sigma=1) {
  let u = 0, v = 0;
  while(u === 0) u = Math.random();
  while(v === 0) v = Math.random();
  return mu + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

async function main() {
  const args = parseArgs();
  const symbol = args.symbol || 'TEST/USDT';
  const bars = parseInt(args.bars || '500', 10);
  let price = parseFloat(args.start || '1000');
  const vol = parseFloat(args.vol || '0.01');
  const out = args.out || `data/test-feeds/${symbol.replace('/', '_')}_feed.jsonl`;

  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const stream = fs.createWriteStream(out, { flags: 'w' });

  const now = Date.now();
  for (let i = 0; i < bars; i++) {
    const dt = 60 * 1000; // 1-minute bars
    const t = new Date(now + i * dt).toISOString();

    // simulate log returns
    const ret = randNormal(0, vol);
    const open = price;
    const close = Math.max(0.0001, open * Math.exp(ret));
    const high = Math.max(open, close) * (1 + Math.abs(randNormal(0, vol/2)));
    const low = Math.min(open, close) * (1 - Math.abs(randNormal(0, vol/2)));
    const bar = { symbol, t, open, high, low, close, volume: Math.round(1000 * (1 + Math.abs(randNormal(0,1)))) };

    stream.write(JSON.stringify(bar) + '\n');
    price = close;
  }

  stream.end();
  console.log('Wrote', out);
}

main().catch(err => { console.error(err); process.exit(1); });
