# Stress Testing & Edge Cases Runbook

Purpose: scenarios and tests to validate system safety under extreme market / infra events.

Core scenarios

1. Flash crash simulation
- Goal: ensure stops, circuit breakers, and kill-switch behave correctly.
- Method: replay historical flash-crash bars or inject synthetic price moves into paper engine.

2. Extreme volatility & low liquidity
- Goal: validate slippage models, order failures, and exposure limits.
- Method: increase spread and reduce available depth in simulated exchange; run multi-symbol stress for 30–60 minutes.

3. Weekend reopen / gap testing
- Goal: verify gap handling and margin protections.
- Method: simulate multi-hour/days gap by replaying non-contiguous bars and ensure exposure caps trigger.

4. Exchange outage & partial responses
- Goal: confirm system fallbacks & safe behavior when an exchange returns errors or inconsistent balances.
- Method: stub/torpedo exchange client to return 5xx and delayed responses; assert no new live orders executed.

5. High-frequency alert flood / metrics outage
- Goal: measure alert-fatigue controls and safe defaults when metrics unavailable.
- Method: disable Prometheus or flood alerts and ensure throttling rules and on-call paging backoffs work.

Basic test harness (manual)

1. Start `PaperTradingEngine` locally with verbose logging.
2. Create a script that pushes synthetic frames to DB or in-memory feed for a symbol, then produce a shock:

```js
// pseudo-code: injectShock.js
const { paperEngine } = require('../server/paper-trading-engine');
const symbol = 'BTC/USDT';
// push normal frames for N bars
for (let i=0;i<50;i++) pushFrame(symbol, price * (1 + randomNoise()));
// inject crash
pushFrame(symbol, price * 0.5);
```

3. Observe: stop-losses trigger, `executionBlocked` events log if limits exceeded, and RL feedback loop behaves as expected.

Automation suggestions
- Add CI job that replays a set of historical stress windows (e.g., 2018-11, 2020-03, 2021-05) through paper engine and asserts no safety invariant violated (e.g., leverage cap, daily loss limit).
- Integrate chaos testing (kubectl kill, network delay) against a staging cluster.

Acceptance criteria
- Engine pauses or reduces exposure automatically during flash crash within configured seconds.
- No uncontrolled leverage increases or runaway positions during stress tests.
- Alerts trigger once, with throttling to avoid noisy paging.
