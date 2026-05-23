# Monitoring & Alerts

Stack recommendation
- Metrics: Prometheus
- Dashboards: Grafana (alerting rules wired to Slack/PagerDuty)
- Logs: Loki or ELK

Core metrics to expose
- TruthEngine: `truth_price_staleness_seconds`, `truth_confidence` (per symbol)
- Execution: `fill_rate`, `realized_slippage_percent`, `execution_latency_ms`
- Risk: `portfolio_drawdown_percent`, `daily_loss_percent`, `open_exposure_percent`
- System: `kill_switch_active` (0/1), `missing_candle_rate`

Suggested alert thresholds (tune to environment)
- `truth_price_staleness_seconds > 60` → PagerDuty
- `daily_loss_percent > 3` → Slack warning; `> 8` → auto kill
- `kill_switch_active == 1` → pagerduty + ops
- `fill_rate < 60%` for 10m → ops

Dashboards
- Overview: P&L, drawdown, exposure, kill-switch status
- Per-symbol: truth vs execution price, recent signals
- Infra: queue/backlog length, worker errors
