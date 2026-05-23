# Backtesting & Evaluation Protocol

Overview
- Use walk-forward evaluation and realistic execution assumptions.

Key rules
- Walk-forward: e.g., 6-month train / 1-month test rolling windows.
- Include realistic fees, maker/taker, and slippage. Model slippage distribution by symbol and apply per-order sampling during replay.
- Account for order latency and partial fills when simulating execution.

Regime stratification
- Tag history into regimes (trend, chop, low-vol, high-vol) and report metrics per regime.

Metrics to report
- Profit Factor, Sharpe (annualized), max drawdown, win rate, avg trade P&L, avg trade length.
- Per-symbol and consolidated confusion matrices for signals.

Reproducibility
- Version datasets and models; save run configs to `backtests/` with timestamped folders.
