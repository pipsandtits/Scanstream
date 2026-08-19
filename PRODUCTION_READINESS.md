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
| Global state abuse | **Partially addressed in Pass 4E** | Capital-adjacent `truthEngine` handoffs now use the typed shared-service registry; non-capital bridges, analytics globals and legacy service publication remain inventoried below. A full DI refactor is intentionally out of scope |
| O(n²) indicator recalculation | **Measured in Pass 4E** | The committed fixed-fixture benchmark reports per-indicator median cost below; it is measurement evidence, not a CI performance gate |
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
| P1 | `typecheck` reports a 362-error legacy baseline; one safe `server/routes` narrowing is now fixed, leaving 361 errors. CI does not gate on it; the remaining errors are classified below |
| P2 | Capital-adjacent `truthEngine` handoffs are typed through a registry; remaining non-capital global handoffs are inventoried below and full DI remains open |
| P2 | Indicator cost is measured over a committed fixture; full market-data replay/MIXED parity remains unverified |
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
in isolation and prints the real failure. After the import-cycle fix, all
remaining candidates import and mount cleanly, but import success is not route
safety evidence:

| Route group | Classification |
| --- | --- |
| `/api/health` | **Safe — restored** (read-only; readiness was unreachable, so no operator could verify durable storage). Covered by `server/routes/__tests__/health-routes.test.ts` |
| `/api/logs` | **Obsolete — deleted** — `server/routes/logs.ts` does not exist; logs are served by `/api/health/logs` |
| `/api/agents/services-api` | **Covered — restored** — route-level tests cover status/config contracts and handled unknown/disabled ability requests |
| `/api/execution` (trade execution) | **Covered — restored with operator guard** — `POST /decision`, `POST /record-outcome`, and `POST /reset` require `requireTradingOperator` and audited actions; read-only `GET /status` remains public |
| `/api/model-performance` | **Covered — restored** — metrics/history/status/validation/prune contracts and bounded ensemble input/error handling are tested |
| physics, exit agents, scout, agent interactions/signals, optimization, strategies, backtesting, velocity, adaptive holding, clustering, phase 5/6, symbol universe, user settings, multi-timeframe, signal generation | **Covered/restoration still open** — import probes pass, but route-level contract/error coverage is not complete; several routes call heavy analytical services and state-changing routes need separate safety review |

The restored set is intentionally small: `/api/health`,
`/api/agents/services-api`, `/api/model-performance`, and guarded
`/api/execution`. The obsolete `/api/logs` registration was deleted.

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
| P1 | **Partially closed in Pass 4C:** fixture-driven paper/live gate observations and order-intent parity; full market-data replay and MIXED-mode parity remain unexercised |
| P1 | **Partially closed in Pass 4C:** concurrent flatten, operator stop during an in-flight order, and stale TruthEngine refusal are covered; the ticker cache has no capital-adjacent consumer, so cache-specific gate wiring remains unproven |
| P1 | **Partially closed in Pass 4D:** `/api/agents/services-api`, `/api/model-performance`, and guarded `/api/execution` are covered and restored; every other classified group remains disabled pending complete route-level coverage and safety review |
| P2 | **Partially closed in Pass 4E:** the 362-error baseline is classified below; safe registry and measurement work is complete, while legacy type errors and non-capital global handoffs remain open |

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
| P1 | **Partially closed in Pass 4C:** fixture-driven paper/live gate observations and order-intent parity, plus a REPLAY confidence-scorer oracle; the full historical pipeline and MIXED mode are not reproducible in-process |
| P1 | **Partially closed in Pass 4D:** route-level contracts and operator audit coverage restored `/api/agents/services-api` and `/api/execution`; all other disabled groups remain disabled pending per-route coverage |
| P2 | **Partially closed in Pass 4E:** 362-error classification is committed; capital-adjacent `truthEngine` handoffs use a typed registry; indicator costs are measured. Legacy errors, non-capital globals and full DI remain open |

#### Pass 4E typecheck classification

The fresh Pass 4E baseline is 362 errors. Counts are semantic rather than
duplicates of TypeScript error codes; an error is assigned to the first
applicable cause in this table.

| Cause | Total | `server/routes` | other `server/` | `tests/` | `client/` | Assessment |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Express 5 `req.params`/path values remain `string \| string[]` | 97 | 95 | 2 | 0 | 0 | Typing gap, but each route needs a correctly typed parameter contract; blanket coercion could hide malformed requests |
| Implicit-any callback or handler parameters | 65 | 37 | 2 | 0 | 26 | Typing gaps where the surrounding API shape is known; scattered legacy callbacks need local domain types |
| Missing module or path | 8 | 0 | 2 | 5 | 1 | Five legacy `tests/` imports target removed/moved modules; no unambiguous replacement was found, so files remain as findings |
| Missing name/import or dead symbol | 53 | 0 | 11 | 0 | 42 | Requires distinguishing a removed feature from a missing import before changing behavior |
| Null/undefined flow not narrowed | 14 | 12 | 2 | 0 | 0 | Several gateway singleton checks are safety-sensitive and require an explicit unavailable-service response |
| Domain/API/type-shape mismatch, including possible latent defects | 125 | 28 | 23 | 0 | 74 | Not treated as cosmetic: wrong model fields, method names, interface implementations and argument shapes require owner review |
| **Total** | **362** | **172** | **40** | **5** | **145** | Baseline |

The raw TypeScript-code counts are TS2345 85, TS2339 83, TS7006 65,
TS2304 53, TS18047 13, TS2349 11, TS2554 11, TS2307 8, TS2538 7,
TS2367 6, TS2322 5, TS2552 4, TS2769 3, TS2353 2, and one each of
TS2459, TS2664, TS18048, TS2420, TS2739 and TS2341.

One safe legacy error was reduced without changing behavior: the disabled
`server/routes/user-settings.ts` auth middleware now uses the existing
`AuthRequest` domain type, removing its `req.user` property error. No error was
reduced by suppression, `any`, an unsafe double cast, signature widening, or
test deletion. The safe reduction count is 1: `server/routes` is 171 and the
post-change total is 361; `other server/` remains 40, `tests/` remains 5, and
`client/` remains 145. The registry and benchmark changes do not alter the
other legacy errors. In particular, the five missing test
modules are reported rather than papered over:

| File | Missing import |
| --- | --- |
| `tests/test-backtest.ts` | `./server/services/historical-backtester.js` |
| `tests/test-physics-validation-standalone.ts` | `./server/services/vfmd/types` |
| `tests/test-rtm-force-decay.ts` | `./server/services/physics-based-rtm-engine` |
| `tests/test-validation-improvements.ts` | `./server/services/rpg-agents/VFMDPhysicsAgent` |
| `tests/test-validation-improvements.ts` | `./server/services/vfmd/types` |

#### Pass 4E typed shared-service registry

`server/services/shared-service-registry.ts` declares the typed
`SharedServiceMap` and `getSharedService`/`setSharedService` operations.
Missing services return `undefined`; callers must retain their existing
fail-closed or optional behavior. The capital-adjacent `truthEngine` handoff
was converted at:

- `server/services/clustering/cluster-validator.ts`
- `server/services/gateway/exchange-aggregator.ts`
- `server/live-trading-engine.ts`
- `server/paper-trading-engine.ts`
- `server/rl-position-agent.ts`
- `server/index.ts`
- `server/__tests__/pass4c-parity-failure-injection.test.ts`

The registry intentionally does not perform a dependency-injection refactor.
Remaining global handoffs are unchanged and inventoried here:

- `server/live-trading-engine.ts`: `rlPositionAgent` (three reads)
- `server/routes/scout-report-routes.ts`: `scoutReportService`
- `server/services/websocket-signals.ts`: `__wss_bridge`, `__bridgeBroadcast`
- `server/services/coingecko.ts`: market-cap/volume aggregate globals
- `server/websocket-bridge.ts`: bridge initialization, websocket instances,
  broadcast and client-count globals
- `server/index.ts`: `scoutReportService`, `executionEngine`,
  `crossExchangeAggregator`, `discoveryAgent`, `arbitrageAgent`,
  `portfolioAgent`, `marketDataFetcher`, `signalPipeline`, and
  `scannerScheduler` publication/cleanup

These remaining handoffs are non-capital shared infrastructure, analytics,
or legacy lifecycle publication. They remain a separate migration decision;
they were not widened or silently replaced with an untyped registry entry.

#### Pass 4E indicator computation measurement

`scripts/measure-indicator-cost.ts` runs the production
`OptimizedMomentumScanner.computeScore` path and measures each dependency-free
indicator over a committed deterministic 256-frame `FIXTURE/USDT` 1-minute
fixture. It uses five warmups and 40 samples, reporting the median per
indicator. On this machine (Linux x86_64, two Intel Xeon Platinum 8559C
vCPUs, Node v22.12.0), the scanner path computed 22 indicators in
`1.0389 ms`; `ichimoku` and `volumeProfile` were explicitly deferred by the
aggressive profile.

| Indicator | Median ms | Relative |
| --- | ---: | ---: |
| `adx` | 0.0892 | 19.04% |
| `vwap` | 0.0358 | 7.65% |
| `tsi` | 0.0508 | 10.84% |
| `macd` | 0.0503 | 10.72% |
| `parabolicSAR` | 0.0305 | 6.52% |
| `atr` | 0.0292 | 6.22% |
| `keltnerChannels` | 0.0256 | 5.45% |
| `elderRay` | 0.0176 | 3.75% |
| `aroon` | 0.0166 | 3.54% |
| `sma` | 0.0117 | 2.49% |
| `obv` | 0.0117 | 2.50% |
| `cmf` | 0.0109 | 2.33% |
| `stochastic` | 0.0078 | 1.66% |
| `slope` | 0.0079 | 1.68% |
| `mfi` | 0.0070 | 1.50% |
| `bollingerBands` | 0.0068 | 1.45% |
| `williamsR` | 0.0063 | 1.35% |
| `vwma` | 0.0050 | 1.06% |
| `cci` | 0.0049 | 1.05% |
| `fibLevels` | 0.0024 | 0.52% |
| `ema` | 0.0012 | 0.25% |
| **Summed per-indicator medians** | **0.4687** | **100%** |

The summed per-indicator medians are below the `1.0389 ms` scanner-path
measurement, so the table is consistent with the production path rather than
claiming that one component costs more than the complete computation. The
script also asserts that every measured indicator produces at least one finite
numeric output on the fixture. Its `computations` calls were checked against
the indicator signatures in `server/services/scanner/indicators.ts`; in
particular, `vwap` uses `(close, volume)` and no longer receives the OHLC
arrays. The benchmark is evidence for relative cost, not a CI performance
gate.

`pnpm run typecheck` does not include `scripts/`: `tsconfig.json` includes
`client`, `shared`, `server`, `tests` and `tools`, while its exclusions omit
the measurement script. A standalone script-inclusive check initially found
three errors in the script's optional `diagnostics` access; those are now
fixed with an explicit production-result guard. The corrected standalone
check still finds six pre-existing errors outside the script:
four missing symbols in `server/rl-metrics.ts` and one private
`SignalClassifier.sharedInstance` access, plus the existing nullable
`exchange.symbols` access in `server/services/live-velocity-calculator.ts`.
The repository-wide baseline intentionally remains scoped by `tsconfig.json`
and is unchanged by those unrelated errors.

The parity fixture intentionally records the legitimate paper/live differences:
live-only durability, funding and conversion gates; generated client-order IDs;
paper shadow-fidelity post-processing versus live exchange-reported fills; and
wall-clock timestamps. Any other observed gate or intent-field divergence fails
the fixture. Funding and durability observations come from the real engine
calls; this spot fixture observes funding as `not_required`, and conversion is
not exercised because there is no non-quote fee or funding payment. The
successful reconciliation, exposure, daily-loss and final sizing gates do not
emit individual success events; the fixture observes their non-blocking path
and the resulting order amount rather than fabricating per-gate "passed"
labels.
mode-detector `REPLAY` path is verified through the confidence scorer's
explicit no-trade result, but `executeSignal` currently returns without an
`executionBlocked` event for that branch. The engine consumes signals rather
than `WorldTick` directly, so the full historical market-data pipeline and
`MIXED` mode (REST backfill plus live WebSocket updates) remain operational
validation items.

The stale-data failure fixture uses the production `TruthEngine.isTradeable`
path and observes its `stale:<age>` refusal. `TickerSnapshotCache` remains a
memory-only optimization with no capital-adjacent consumer in the current
engine, so no test claims that the cache itself gates execution.

Scanstream remains **not production-ready for live capital**. The hardening
direction is fail-closed, but route coverage, legacy typecheck classification,
venue-specific operational validation and the unexercised `MIXED` pipeline
remain required.
