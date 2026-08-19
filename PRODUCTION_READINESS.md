# Scanstream Production Readiness — Hardening Pass 1

Scope: make the **current** system safe, correct, observable and recoverable for
live CEX operation. No new strategies, agents, indicators or product surface.

Verification environment: Node 22.12.0, pnpm 10.15.0, PostgreSQL not attached
(storage fell back to in-memory, which is itself one of the findings below).

---

## 1. Red-flag assessment (verified against code, not docs)

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `typescript@6.0.3`, `@types/node@25.9.1`, `zod@4.4.3` do not exist on npm | **Refuted** | `npm view` resolves all three; they are current releases |
| `prisma@7.8.0` unusable | **Confirmed (real P0)** | `prisma generate` failed: Prisma 7 removed `datasource.url` in schema and requires a driver adapter, while `prisma/schema.prisma` and `new PrismaClient()` in `server/db-storage.ts` are Prisma 6 style. The client could therefore never be generated, so **every** deployment silently ran on the in-memory fallback. Pinned `prisma`/`@prisma/client` to `6.19.3`, which matches the committed schema and client usage |
| Dual ORM confusion | **Partly confirmed, no migration needed** | `drizzle-orm` is imported **only** by `shared/schema.ts` (table + `drizzle-zod` insert-schema definitions used as types); server code imports it 0 times and there is no drizzle migration directory. Prisma is the sole runtime ORM (`server/db-storage.ts`). Authoritative path: **Prisma for persistence, Drizzle purely as schema/zod type source.** Documented rather than changed — removing Drizzle would touch 39 server type imports for no safety gain |
| Global state abuse | **Confirmed, not addressed in this pass** | 36 `(global as any)` service handoffs in `server/`. Refactoring to DI is a wide, behaviour-changing change with no capital-safety payoff; tracked below |
| O(n²) indicator recalculation | **Not reproduced in this pass** | Not measured; left as an open P2 item rather than asserted either way |
| Disabled routes in main | **Confirmed** | `server/index.ts` has a ~200-line `BINARY SEARCH: TEMPORARILY DISABLE ALL ROUTERS` comment block covering ~25 route groups. Left disabled deliberately: re-enabling them blind would reintroduce whatever crash the binary search was chasing. Each group needs individual triage |
| No tests / no CI | **Confirmed, fixed** | No runner was configured. Vitest is now wired up (`pnpm test`) with 82 passing tests, and `.github/workflows/ci.yml` runs install → prisma generate → tests → build |
| No LICENSE despite MIT claim | **Confirmed, fixed** | `LICENSE` (MIT) added to match README |
| Zero community / over-engineering | Not a code defect | No action |

---

## 2. Fixes in this pass

### P0 — capital and execution safety

- **Non-overridable hard-limit gate** (`server/services/risk/hard-limit-gate.ts`):
  synchronous pre-trade boundary covering kill switch, live circuit breaker,
  engine-enabled state, signal staleness, position size, total exposure,
  per-symbol exposure, open-position count and leverage. Configuration can only
  *tighten* limits — `HARD_LIMIT_CEILINGS` are compiled ceilings that env vars
  and API config cannot widen. Unknown/NaN exposure inputs fail closed.
- **Second gate after final sizing** in `live-trading-engine.ts`: sizing logic
  downstream of the first check can no longer grow an order past the limits.
- **Fail-closed safety controls**: portfolio-risk evaluation errors and
  TruthEngine (market-data quality) errors now block execution instead of
  logging and continuing.
- **Ambiguous order outcomes** (`server/services/execution/order-reconciler.ts`):
  timeouts/5xx/socket errors are classified as ambiguous; the engine reconciles
  by client order id before any retry, adopts an order that already exists, and
  **aborts on `unknown`**. `absent` is only returned when every available
  listing succeeded — a partial answer is not proof of absence.
- **Retry sizing bug**: retries used `Math.max(1, Math.floor(qty * 0.75))`,
  which *increases* size for sub-unit quantities (e.g. 0.4 BTC → 1 BTC). Now
  reduces geometrically and aborts below the market minimum.
- **Persistent, restart-safe emergency stops**: kill switch and live circuit
  breaker persist to `data/`; unreadable state fails closed (killed/active); a
  clear that cannot be persisted is rolled back and rejected. Clearing the
  breaker no longer auto-resumes trading — an explicit operator resume is
  required, and resume is refused while either control is active.
- **Flatten-all** is idempotent under concurrency (concurrent calls join one
  sweep), disables new execution first, closes each position independently,
  reports partial failures (`207` from the endpoint) and emits
  `flattenAllIncomplete` with the positions still open.
- **Operator authentication** on capital-moving routes
  (`server/middleware/require-trading-operator.ts`): timing-safe
  `TRADING_OPERATOR_TOKEN` check on `start`, `stop`, `config`,
  `close/:positionId`, `execute`, `flatten-all`; returns `503` when the token is
  not configured (fail closed, never open). Provided tokens are never logged.

### P1 — market-data correctness

- **Precision corruption**: the CCXT adapter applied `Math.floor()` to OHLC
  prices — BTC/ETH decimals were discarded and sub-dollar assets floored to 0
  (and then rejected or traded at a nonsense price). Replaced with
  `candle-normalizer.ts`, which floors **only** timestamps, preserves price and
  volume precision, parses numeric strings, and rejects rows that are malformed,
  non-finite, non-positive, negative-volume or geometrically impossible
  (`high < low`, `high < open/close`, `low > open/close`).
- **Silent timeframe substitution**: unsupported timeframe seconds used to round
  to a neighbouring supported value (a 90m request silently became 1h). Now an
  explicit lookup that throws.
- **Integrity-gate bypasses removed**: `ccxt-scanner` no longer persists frames
  directly when the gate throws, and `exchange-aggregator` no longer returns raw
  unvalidated frames "as-is". Both drop the batch and record a safety metric.
- **Temporal correctness**: the gate persisted a MarketFrame *before* checking
  for time regression, so incoherent candles could become canonical data. The
  regression check now runs before storage; `worldTime` (candle close/market
  time) and `emitTime` (wall clock) stay distinct; a World Tick is emitted only
  after storage succeeds, and is suppressed on storage failure.
- **Crash-on-partial-data on the signal path**: `order-flow-analyzer` threw
  `TypeError` on missing order-flow fields and `multi-timeframe-confirmation`
  threw on a signal without per-timeframe analysis — both reachable from
  `SignalPipeline.aggregateSignals`. Both now degrade instead of throwing.
- **Module-init crash**: `rl-guard.ts` dereferenced `RLConfig` unguarded and
  crashed on import under circular-import resolution.

### Observability / operations

- `server/services/observability/safety-metrics.ts`: counters for integrity
  bypasses blocked, candles rejected (by reason), executions blocked (by reason),
  order reconciliations, flatten-all runs and failures.
- `GET /api/health/readiness`: reports DB connectivity (explicitly flags the
  in-memory fallback as not durable), kill switch, circuit breaker and integrity
  state; `503` when not ready.
- `GET /api/live-trading/safety`: kill switch, breaker and engine config.
- The static `/api/health` handler in `routes.ts` that shadowed the real health
  router (always `UP`) was reduced to `/api/live` liveness; the duplicate
  `/api/live-trading` mount was removed.
- Request logging no longer serialises response bodies (trading/config endpoints
  return account and exchange settings).

---

## 3. Tests

`pnpm test` — 82 tests, 6 files, all passing:

- `candle-normalizer` — BTC/ETH precision, sub-cent assets, small movements,
  stop-loss/take-profit arithmetic, string parsing, malformed/impossible rows,
  timeframe mapping.
- `hard-limit-gate` — each block reason, ceiling clamping, env config, unknown
  exposure, fail-closed when a control throws.
- `order-reconciler` — ambiguity classification, exists/absent/unknown,
  per-exchange client-id shapes, unknown on partial failure, id uniqueness.
- `integrity-gate` — store-before-emit ordering, tick suppressed on persistence
  failure, regression rejected before storage, historical backfill exempt,
  invalid OHLC never stored, dedupe.
- `live-trading-safety` — start/resume refusal, hard-limit block, execution
  blocked during flatten, multi-symbol flatten, partial-failure isolation,
  concurrent flatten joins one sweep, exchange-refresh outage.

Two pre-existing suites (`phase-1-integration`, `unified-regime-system`) were
never runnable (Jest imports, wrong relative paths). Their imports are fixed so
they execute, but they assert an interface the implementation does not provide
(e.g. `AggregatedSignal.action`, different regime confidence scales). They are
**excluded from the gate with a comment, not deleted** — the drift is real and
should be reconciled by the owner of that spec; the tests were not edited to
pass. The legacy top-level `tests/` and `__tests__/` trees still import modules
that no longer exist and are not wired into the runner.

---

## 4. Remaining risks / not done

| Priority | Item |
| --- | --- |
| P0 | `DATABASE_URL` must be set and `prisma migrate deploy` run before live use — without it `db-storage` runs in memory and **all** trade/position history is lost on restart. Readiness now surfaces this, but nothing prevents starting |
| P0 | Fills, fees, funding, slippage and realized/unrealized PnL accounting are unaudited; only limits and order state were hardened |
| P0 | Startup recovery (adopting positions/orders that exist on the exchange after a crash) is not implemented |
| P1 | `TRADING_OPERATOR_TOKEN` is a single shared secret with no rotation, per-user identity or audit trail — an interim guard, not an authz design. Read-only status routes remain unauthenticated |
| P1 | ~25 route groups remain commented out in `server/index.ts`; unknown functional gaps |
| P1 | Safety metrics are process-local and reset on restart; no Prometheus/OTel exporter, no correlation IDs end-to-end |
| P1 | `typecheck` reports 362 pre-existing errors (mostly legacy `tests/` and Express 5 `req.params` typing). CI does not gate on it; the number was unchanged by this pass and none of the new files error |
| P2 | 36 `(global as any)` service handoffs; no DI |
| P2 | Indicator recomputation cost unmeasured; replay/paper/live parity unverified |
| P2 | Rich `/api/health` still contains hard-coded exchange counts and placeholder freshness values |

---

## 5. Deployment checklist

1. Node 22, pnpm 10.15.0, `pnpm install --frozen-lockfile`.
2. `DATABASE_URL` set; generate the client and apply the committed migration
   history to a fresh database:
   `pnpm run db:generate && pnpm run db:migrate:deploy`.
   If the database already contains the schema from `prisma db push` (or an
   equivalent pre-migration deployment), baseline that existing schema once
   instead of replaying the initial DDL:
   `pnpm exec prisma migrate resolve --applied 0_init`.
3. Confirm `GET /api/health/readiness` returns `ready: true` with
   `database.ok === true` **before** enabling live trading.
4. Set `TRADING_OPERATOR_TOKEN` (32+ random bytes). Without it all trading
   control endpoints answer `503`.
   Configure explicit funding lookback and recheck intervals in the engine
   integration. A complete venue response can prove coverage when its first
   page is short at the requested boundary; otherwise funding older than the
   bounded initial lookback requires the authenticated
   (`TRADING_OPERATOR_TOKEN`), audited baseline attestation endpoint below:
   `POST /api/live-trading/funding/attest`.
5. Set risk limits explicitly — defaults are deliberately small:
   `RISK_MAX_POSITION_USD`, `RISK_MAX_TOTAL_EXPOSURE_USD`,
   `RISK_MAX_SYMBOL_EXPOSURE_USD`, `RISK_MAX_OPEN_POSITIONS`,
   `RISK_MAX_LEVERAGE`, `RISK_MAX_SIGNAL_AGE_MS`. Values above
   `HARD_LIMIT_CEILINGS` are clamped, not honoured.
6. Ensure `data/` is on durable, writable storage. Live execution state,
   `realized-pnl-ledger.json`, `funding-accounting.json`, the kill switch,
   circuit breaker and safety events persist there and fail closed if unreadable.
   Ticker snapshots, price/candle snapshots, gateway caches, indicator caches
   and velocity caches are memory-only optimizations; they start empty after a
   restart and are never treated as durable execution or exposure state.
7. For perpetual/swap markets, configure a venue that declares either
   `fetchFundingHistory` or `fetchLedger` (with funding-type rows). The only
   deliberate escape hatch is `ALLOW_UNACCOUNTED_FUNDING=1`; setting it accepts
   unknown funding risk and must be an explicitly documented operator decision.
   Configure `PNL_CONVERSION_MAX_AGE_MS` when the venue requires a tighter
   freshness bound than the conservative one-minute default.
8. Start in `testMode`/paper, verify signals and `executionBlocked` events, then
   hand over to live with a small `RISK_MAX_TOTAL_EXPOSURE_USD`.

## 6. Monitoring (minimum)

- `readiness` != UP, and `database.ok === false` in particular → page.
- `safety.executionsBlocked` by reason; a spike in `truth_check_error`,
  `max_*` or `stale_signal` means data or sizing is wrong.
- `safety.candlesRejected` / `integrityBypassBlocked` > 0 → feed quality alarm.
- `safety.flattenAllFailures` > 0 → **open exposure with no automation**;
  intervene manually on the exchange.
- `orderReconciliations.unknown` > 0 → an order may exist that the system does
  not know about; reconcile by hand.
- `realized_pnl_unknown`, `realized_pnl_ledger_unreadable` or
  `realized_pnl_persistence_failed` → daily loss is not provable; keep live
  execution stopped and use the entry-specific operator resolution procedure
  below only after exchange records are reviewed.
- `conversion_unknown` → a fee or funding conversion could not be proven from
  a fresh same-venue ticker. Bounded retries may self-heal, but live execution
  remains stopped while daily PnL is unknown.
- A ticker or market-data cache read that exceeds its caller-supplied age bound
  is unknown and must not satisfy a capital-adjacent gate; investigate the
  venue feed rather than widening the bound.
- `funding_unaccounted`, `funding_state_unreadable` or `funding_unknown` →
  perpetual/swap funding is not provable; reconcile the venue history before
  clearing the block. If older coverage cannot be proven from the venue
  response, use the symbol-specific baseline attestation procedure below after
  reviewing exchange evidence. Treat `ALLOW_UNACCOUNTED_FUNDING=1` as an
  incident-level exception, not normal operation.

## 7. Rollback and incident recovery

- **Immediate stop:** `POST /api/live-trading/stop`, then
  `POST /api/live-trading/flatten-all` (idempotent; `207` means positions remain
  — the response lists them). Escalate to the kill switch to block all new
  orders across restarts.
- **Rollback:** redeploy the previous image. The persisted kill switch/breaker
  files are forward-compatible; if `data/` state is unreadable the system starts
  killed, which is the intended direction of failure.
- **Unknown realized PnL:** keep execution stopped, identify the exact entry
  from the durable ledger, and call
  `POST /api/live-trading/realized-pnl/{entryId}/resolve` with the shared
  operator token. Use `{ "resolution": "attested_value", "pnl": <number>,
  "reason": "<evidence>" }` only when exchange evidence supports the value.
  Otherwise use `{ "resolution": "excluded_unknown", "reason": "<evidence>" }`.
  Wildcards, bulk clearing, automatic expiry and editing the original ledger
  record are forbidden. The request is audited as `shared-operator-token`, and
  both durable records must show the resolution before execution resumes.
- **Unknown funding baseline:** keep contract execution stopped and review the
  venue's funding export for the exact symbol. If the bounded initial query
  cannot prove older coverage, call
  `POST /api/live-trading/funding/attest` with the shared operator token and
  `{ "symbol": "<exact symbol>", "reason": "<evidence>" }`. The symbol must be
  specific; wildcard or bulk clearing is forbidden. The attestation is
  durably recorded in funding state and audited as `shared-operator-token`; it
  clears only that symbol's initial baseline gap. Failed or truncated later
  queries create a new unknown and must be investigated again.
- **Stale or corrupt market-data cache:** caches are disposable and
  memory-only. Restarting clears them; a cache read must never be used to
  reconstruct positions or exposure. Reinitialize the venue and reload
  markets before accepting new market-data reads.
- **Operator stop during execution:** keep the stop/kill switch active until
  the in-flight order appears in durable local state and exchange
  reconciliation agrees. A stop blocks subsequent placements; it does not
  cancel or hide an order already accepted by the venue. Resume is refused
  while the kill switch is active and otherwise re-runs normal durability,
  funding and reconciliation preconditions.
- **After an incident:** compare exchange positions/orders against
  `/api/live-trading/status` before clearing the kill switch — there is no
  automatic startup reconciliation yet (see §4). Clear the breaker, then resume
  explicitly; resume is refused while either control is active.

---

## 8. Hardening Pass 2

Pass 2 targets the question "after a crash, timeout, partial fill, restart,
duplicate event or exchange failure, can Scanstream determine what actually
happened and refuse to trade until it knows?". Everything below is code plus
tests in this branch; the phases listed as outstanding are *not* done.

### 8.1 Durable state is now a hard precondition for live execution

`server/services/execution/durability-gate.ts` is checked before live start,
before resume and immediately before every live order. Without `DATABASE_URL`,
or when a probe of the database fails, live paths fail closed
(`executionBlocked` with `durable_state_unavailable`) and a durable
`durability_failure` event is recorded. `testMode`/paper deliberately still runs
on the in-memory store. Failed durable writes invalidate the cached probe, so a
database lost *after* startup stops execution rather than being discovered later.

This closes the first P0 in §4: the gap was previously only *reported* by
readiness, never enforced. Readiness alone is still not a safety control.

### 8.2 Fill, fee and slippage accounting

`server/services/execution/fill-accounting.ts` accumulates fills per order:
duplicate fill IDs are idempotent, partial and late fills accumulate, average
execution price is cost-weighted, remaining quantity is explicit, maker and taker
volume are separated, and fees are kept **per currency**. Non-quote fees are
returned as `unconvertedFees` rather than converted with an invented rate.
Slippage is computed from requested versus achieved price and is `null` when
unknown. Cancelled-but-partially-filled orders keep their exposure.

Funding is **not** implemented and is not simulated anywhere.

### 8.3 Positions and risk

Positions are keyed by symbol, so repeated refreshes cannot duplicate exposure.
Exposure uses notional (`|qty| * price`) rather than margin alone. An exchange
response that is incomplete, unusable or failed never silently erases local
exposure — only an explicit flat position removes it.

### 8.4 Startup reconciliation barrier

`server/services/execution/startup-reconciler.ts` queries balances, positions and
open orders, diffs them against local state, and returns a report. Live start and
live order creation are refused unless the report is `complete`. Unknown exchange
positions are adopted; unknown open orders, locally-open orders missing from the
exchange, and any query failure block trading. Reconciliation is idempotent.
Conservative by design: an order missing from the open-order response is
*unknown*, never inferred as filled or cancelled.

### 8.5 Operator audit trail and durable safety events

`server/services/observability/safety-event-log.ts` appends JSONL to
`data/safety-events.jsonl` (8 MB rotation, one previous generation) so blocked
executions, rejected candles, unknown order states, flatten-all outcomes, kill
switch/breaker transitions, reconciliation results and durability failures
survive restart. `server/middleware/audit-operator-action.ts` records each
capital-moving request with previous state, resulting state, outcome, reason and
request ID. The operator token is never persisted; the identity is recorded as
`shared-operator-token`. Read them via
`GET /api/live-trading/safety-events` (operator auth).

### 8.6 Disabled route groups — classified, not blindly re-enabled

Root cause found: `server/rl-guard.ts` built its singleton at module scope and
read `RLConfig` from `rl-system-integration` in the constructor. Those modules
form an import cycle, so the read hit a temporal dead zone and threw
`Cannot access 'RLConfig' before initialization`; optional chaining does not
protect against a TDZ. Every router transitively importing that chain crashed at
import, which is what the "BINARY SEARCH: TEMPORARILY DISABLE ALL ROUTERS"
comment was bisecting. Config is now resolved lazily on first use.

`npx tsx scripts/probe-disabled-routers.ts` mounts each formerly disabled router
in isolation and prints the real failure. After the fix, all of them import and
mount cleanly:

| Route group | Classification |
| --- | --- |
| `/api/health` | **Safe — restored** (read-only; readiness was unreachable, so no operator could verify durable storage). Covered by `server/routes/__tests__/health-routes.test.ts` |
| `/api/logs` | **Obsolete** — `server/routes/logs.ts` does not exist; logs are served by `/api/health/logs` |
| physics, exit agents, scout, agent interactions/signals/services, optimization, strategies, model performance, backtesting, velocity, adaptive holding, clustering, phase 5/6, symbol universe, user settings, multi-timeframe, signal generation | **Requires tests before restore** — imports fine, no route-level coverage exists, and several call heavy analytical services on request |
| `/api/execution` (trade execution) | **Requires fix before restore** — capital-adjacent surface with no `requireTradingOperator` guard; must not be exposed as-is |

Only `/api/health` was restored. Nothing was deleted.

### 8.7 Health endpoint no longer publishes fabricated data

`/api/health` previously reported `connectedExchanges: 6` and a synthetic
`dataFreshness` of "0 ms old, not stale" without contacting anything, and
`/api/health/exchanges` returned a hardcoded active/geo-restricted list. Those
now report `unknown`/`null` with an explicit note. The liveness (`/api/health`
in `routes.ts`), readiness (`/api/health/readiness`) and live-trading gate
distinctions are unchanged.

### 8.8 Still outstanding (Pass 3)

| Priority | Item |
| --- | --- |
| P0 | **Closed in Hardening Pass 3 Phase A:** local positions/orders are atomically persisted under `data/`, loaded before live exchange queries, and included in the startup reconciliation barrier |
| P0 | **Closed in Hardening Pass 3 Phase B:** fill-aware close orders and durable realized PnL/daily-loss accounting are covered in §9.2 |
| P0 | **Closed in Hardening Pass 3 Phase B:** funding accounting and the unknown-funding gate are covered in §9.3; venue support remains a Pass 4 item |
| P1 | **Closed in Hardening Pass 3 Phase A:** `resume()` awaits startup and reports failure when durability, local state, initialization or reconciliation refuses the start |
| P1 | **Closed in Pass 4B:** cache key uniqueness, TTL, invalidation, stampede and memory-only restart semantics; no persisted live cache was found, so persisted-cache corruption is not applicable |
| P1 | **Closed in Pass 4C:** fixture-driven paper/live decision and order-intent parity, with explicit divergence assertions and replay-mode no-trade coverage |
| P1 | **Closed in Pass 4C:** concurrent flatten, operator stop during an in-flight order, and stale-cache refusal failure-injection cases |
| P1 | Route groups classified above still need per-group tests, and `/api/execution` needs operator auth |
| P2 | Legacy `tests/` suites and the 362-error typecheck baseline are still unclassified; `(global as any)` handoffs and indicator cost remain unmeasured |

Scanstream is **not** production-ready for live capital on this branch. The
direction of failure is now defensive — it refuses to trade when it cannot prove
state — but route coverage, legacy typecheck classification, venue-specific
validation and the remaining Pass 4 items in §9.5 remain open.

## 9. Hardening Pass 3

Pass 3 closes the restart-state and asynchronous-resume failures identified in
§8.8, then carries fill-aware close accounting through daily loss and funding
gates. It does not claim that venue-specific accounting or the wider
production-readiness programme is complete.

### 9.1 Phase A — durable local execution state

The Phase A defect was that `this.orders` and `this.positions` were memory-only.
After a process restart, startup reconciliation received empty local views and
could pass vacuously: a locally open order missing from the exchange response or
a locally known position absent from the exchange could not block trading.

`durable-local-state.ts` now stores the local order and symbol-keyed position
view under `data/live-execution-state.json` with schema-version metadata,
written-at metadata, temp-file plus fsync plus rename persistence, and
injectable test seams. Live startup loads it before any exchange query.
`absent`, `ok` and `unreadable` are distinct outcomes; unreadable state and
failed writes block live execution and create durable safety events. Client order
IDs are persisted so ambiguous orders can be matched after restart.
`resume()` awaits startup, durability and reconciliation instead of reporting
success before asynchronous work finishes. Paper/test mode remains intentionally
less strict.

The review fixes in this phase also ensure a confirmed exchange order is still
returned and emitted when its local persistence fails, unchanged order polls do
not rewrite the state file, and exchange reconciliation updates the fill ledger
instead of bypassing it.

### 9.2 Phase B — fills, realized PnL and daily loss

The remaining defect was that closing a position discarded the exchange response,
deleted exposure on partial or ambiguous outcomes, and sent mark-price PnL to
the RL callback. Close orders now carry client IDs, use reduce-only parameters
when the loaded market is contract-based, retain their own fill account and
fees, and reconcile ambiguous placement before any decision. Unknown outcomes
retain the position and block execution. Confirmed partial fills reduce
quantity; only a confirmed full fill removes the position.

`realized-pnl-ledger.ts` computes long and short close PnL from entry cost basis
and actual exit fills. Quote fees are subtracted. Non-quote fees remain
unconverted until the same-venue conversion path proves a fresh direct or
inverse market price. Conversion accepts only a positive finite ticker price
with an explicit timestamp inside `PNL_CONVERSION_MAX_AGE_MS` (one minute by
default), and never uses a stale, timestamp-less, cross-venue, or estimated
rate. Each successful fee or funding conversion is an immutable append-only
ledger record containing the source amount, quote amount, rate, market,
direction, ticker timestamp and original entry reference; failed conversion
keeps the original entry unknown.
The ledger is append-only by event ID, atomically persisted under
`data/realized-pnl-ledger.json`, loaded before live exchange access, and treated
as unknown if corrupt or unreadable. Daily loss uses ledger PnL and the more
conservative of balance-derived and ledger-derived results; unknown daily PnL
blocks live execution. The RL callback receives realized PnL or explicit null.
Unknown entries can be resolved only one at a time through the authenticated,
audited operator endpoint in §7. Numeric attestations and explicit
unknown-and-excluded decisions are durable and immutable; unresolved entries
continue to make the daily summary unknown. Both balance and ledger daily
windows use UTC calendar dates.

### 9.3 Phase B — funding

`funding-accounting.ts` queries CCXT `fetchFundingHistory` for swap/perpetual
markets and falls back to funding-type entries from `fetchLedger` when the
venue declares that capability. It persists payment IDs idempotently under
`data/funding-accounting.json`, and feeds quote-currency payments into the
realized ledger as a separate funding category with its source recorded.
Unsupported sources, failed queries and unusable responses are unknown, not
zero; a venue declaring neither source produces the explicit
`funding_source_unsupported` refusal for contract markets. Spot markets do not
require funding accounting. `ALLOW_UNACCOUNTED_FUNDING=1` is the sole
deliberate escape hatch;
it is recorded as an operator-visible safety event and must not be treated as a
normal operating mode. The first reconciliation uses an explicit bounded
initial lookback. Coverage becomes known without attestation only when the
venue response proves the requested window (for example, a short first page
at the boundary); a symbol whose older history remains unprovable stays
unknown until an operator-attested baseline is recorded through
`POST /api/live-trading/funding/attest`. The attestation requires one exact
symbol and a reason, is durable and audited, and cannot clear another
symbol's gap. The default initial window is 24 hours and is bounded to seven
days; the default minimum recheck interval is one hour. Known answers are
cached only within the recheck interval. Unknown answers are never reused,
and failed or truncated later queries return to unknown.
Subsequent queries page until a short response, advance the cursor only after
complete pagination, and reuse only a durable known answer within the minimum
recheck interval; unknown answers are never cached.

### 9.4 Pass 4B — cache hardening

`TickerSnapshotCache` is explicitly venue-scoped: keys contain the venue and
symbol, and values record the venue source. Calls without an explicit venue
return unknown rather than selecting whichever exchange answers first. Reads
accept a caller-provided maximum age and never return an expired value. The
cache retains single-flight requests per venue/symbol, bounds concurrent
upstream fetches, does not store failed fetches, and applies a short per-key
failure backoff. Per-key, per-venue and global invalidation are available and
are invoked on venue initialization/reload, venue switching and kill-switch
activation.

The ticker cache, `PriceCache`, gateway `CacheManager`, scanner indicator and
signal caches, and velocity caches are process-memory optimizations. They start
empty at boot; none is a source of truth for exposure or durable local
execution state. No cache file or database persistence is used by these paths,
so there is no persisted cache to restore after corruption. The gateway cache
manager records TTL as a duration from insertion and supports an explicit
read-age bound. Historical/VFMD files under `data/cache/` are offline
backtest/training artifacts, not live execution inputs.

### 9.4.1 Deliberately unimplemented

This pass does not invent exchange rates, use cross-venue prices, or triangulate
through an unrelated asset. It does not add Prisma models, restore disabled
route groups, or add operator authentication to `/api/execution`. The remaining
work is tracked below rather than hidden by this pass.

### 9.5 Pass 4

| Priority | Item |
| --- | --- |
| P0 | **Closed in Pass 4A:** same-venue direct/inverse conversion for non-quote fees and funding; stale or unavailable prices remain unknown |
| P0 | **Closed in Pass 4A:** funding source fallback through declared `fetchLedger` funding entries; venues declaring neither source refuse explicitly |
| P1 | **Closed in Pass 4B:** venue-scoped keys, explicit age bounds, invalidation, concurrency limits, single-flight, failure backoff and memory-only restart semantics. No persisted live cache was found, so persisted-cache corruption is not applicable |
| P1 | **Closed in Pass 4C:** fixture-driven replay/paper/live decision and order-intent parity plus the named failure-injection cases |
| P1 | Per-route tests for the classified disabled groups and operator authentication for `/api/execution` |
| P2 | Legacy 362-error typecheck baseline classification, `(global as any)` handoffs and indicator cost measurement |

The parity fixture intentionally records the legitimate paper/live differences:
live-only durability, funding and conversion gates; generated client-order IDs;
paper shadow-fill behavior versus venue fills; and wall-clock timestamps. Any
other intent-field or gate divergence fails the fixture. The mode detector's
`REPLAY` path is exercised as a no-trade decision oracle; the engine consumes
signals rather than `WorldTick` directly, so this is not a claim that the
full historical market-data pipeline is an in-process replay driver. `MIXED`
mode (REST backfill plus live WebSocket updates) is not reproducibly generated
by this fixture and remains an operational validation item.

Scanstream remains **not production-ready for live capital**. The hardening
direction is fail-closed, but route coverage, legacy typecheck classification,
venue-specific operational validation and the unexercised `MIXED` pipeline
remain required.
