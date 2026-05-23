# Rollback Runbook

Trigger: failed canary, critical regression, or severe outages after deployment.

Goals: quickly restore last known-good artifact and ensure system stability.

1. Identify last healthy artifact
- Use your artifact registry to find previous image SHA/tag (CI release notes or image tags).

2. Immediate mitigation (minutes)
- Pause auto-execution if severe trading issues observed:
  - Trigger `systemKillSwitch` (operator UI or admin API) to pause engines and optionally force-close positions.
  - If no UI, scale down or pause job that performs execution.

3. Rollback artifact (example: k8s)

```bash
# Rollback to previous revision
kubectl -n prod rollout undo deployment/scanstream --to-revision=<REV>

# OR explicitly set image to previous SHA
kubectl -n prod set image deployment/scanstream scanstream=registry/org/scanstream:<PREV_SHA>
```

4. If rollback involves DB schema incompatibility
- If DB changes already applied and incompatible, restore DB from snapshot (if available) or run compensating script. Prefer backups.

5. Verification
- Wait for pods to become Ready. `kubectl -n prod get pods -l app=scanstream`
- Health checks: `curl -fsS https://prod.example.com/health`
- Metrics: check `/metrics` and Grafana dashboards for return to baseline.
- Confirm trading engines are paused/resumed as needed and no new trades gone uncontrolled.

6. Post-rollback actions
- Record incident with timeline and reason in issue tracker.
- Create postmortem: root cause, corrective actions (tests, feature flags), and follow-up tasks.
