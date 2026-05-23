# Shadow → Live Transition Guide

Purpose
- Steps and criteria to move from full shadow to small-capital live trading.

Phases
- Shadow mode (signals + simulated fills)
  - Run 4–8 weeks or until minimum trade count achieved (200+ trades per strategy/symbol aggregate).
  - Record precision, recall, PF, Sharpe, realized slippage distribution.
  - No real orders placed.

- Seed live (pilot)
  - Start with tiny capital (0.1%–0.5% per trade cap).
  - Duration: at least 200 live trades or 2 weeks, whichever is longer.
  - Monitor kill-switch, P&L, drawdown and slippage closely.

- Ramp
  - If criteria met, increase to 1% per trade, continue monitoring and validate metrics.

Success criteria (examples)
- Profit Factor > 1.25 (realistic costs)
- Sharpe > 1.0 (annualized)
- TruthEngine coverage ≥95% for traded symbols
- No critical alerts for 7 consecutive days

Rollback
- Flip `system.kill` and revert to previous release image. Post-mortem required before resuming.
