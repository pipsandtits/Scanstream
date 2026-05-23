Stress-tests tools

This folder contains small, self-contained utilities to generate synthetic OHLC feeds and inject shocks for repeatable stress testing.

Scripts

- `generate_feed.js` — Generates synthetic OHLC bars and writes JSONL. Example:

  ```bash
  node tools/stress-tests/generate_feed.js --symbol BTC/USDT --bars 500 --start 30000 --vol 0.02 --out data/test-feeds/btc_normal.jsonl
  ```

- `inject_shock.js` — Reads JSONL feed and injects a price shock at a chosen bar index. Can write a shocked feed or POST bars to an ingestion endpoint one-by-one.

  Create a shocked feed file:
  ```bash
  node tools/stress-tests/inject_shock.js --in data/test-feeds/btc_normal.jsonl --out data/test-feeds/btc_shock.jsonl --shock-index 100 --multiplier 0.5
  ```

  Replay and POST each bar to a local ingestion endpoint (adjust `--delay` ms between posts):
  ```bash
  node tools/stress-tests/inject_shock.js --in data/test-feeds/btc_shock.jsonl --post http://localhost:3000/api/push-bar --delay 100
  ```

Notes & integration
- These scripts are intentionally lightweight and dependency-free so they run with any Node installation.
- The `--post` option expects an HTTP endpoint that accepts a single bar JSON per POST (application/json). If your project exposes a local ingestion API or accepts websockets, adapt the `postBar` logic in `inject_shock.js`.
- To integrate with `PaperTradingEngine` or replay into your system, either point `--post` at your ingestion endpoint or adapt the scripts to write into the storage the engine reads from (DB, Kafka, Redis).

Suggested CI job (optional)
- Add a job that generates a feed, injects a shock, replays it to a staging ingestion endpoint, and asserts that no safety invariant is violated (e.g., dailyLossLimit not exceeded). This will require a small test harness in `e2e/` to validate invariants after replay.
