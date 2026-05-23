# Incident Response Runbook (Trading System)

Scope: actions to take when system behaves incorrectly (logic bugs, model regressions, exchange outages, flash crashes).

Severity levels
- P0: trading at risk of large financial loss or systemic failure.
- P1: degraded service with potential losses or missing critical metrics.
- P2: non-critical issues.

Immediate steps (first 15 minutes)
1. Triage & assign owner
   - Open incident channel (Slack/MS Teams) and assign an owner.

2. Contain
   - Pause trading via `systemKillSwitch` (operator tool) or scale down execution replicas.
   - If immediate closure is required and allowed, enable force-close option (KILL_FORCE_CLOSE=1) and follow safe close procedure.

3. Snapshot state
   - Export open positions, pending orders, recent signals, model versions, last deployments, and provenance records.
   - Save Prometheus metrics snapshot and any alert logs.

4. Root cause analysis (quick)
   - Check recent deploys and model promotions in the last 60 min.
   - Check exchange connectivity and balances.
   - Review error logs and stack traces.

5. Mitigate
   - If caused by new deploy, perform rollback per `rollback.md`.
   - If caused by model change, revert to previous model and disable auto-promotion.
   - If caused by exchange outage, switch to paper mode or remove problematic exchange from routing.

6. Recover
   - Gradually re-enable trading behind canary and closely monitor metrics.

7. Post-incident
   - Write a postmortem within 48 hours with timeline, root cause, impact, and action items.
   - Add tests and automation to prevent recurrence.

Quick commands

```bash
# Pause production trading (k8s scale down exec workers)
kubectl -n prod scale deployment/scanstream-executor --replicas=0

# Re-enable after fix
kubectl -n prod scale deployment/scanstream-executor --replicas=3

# Rollback deployment (see rollback.md)
kubectl -n prod set image deployment/scanstream scanstream=registry/org/scanstream:<GOOD_SHA>
```

Notes
- Always capture trade provenance and logs before performing destructive actions.
- Communicate with stakeholders (ops, quant, risk) immediately for P0 incidents.
