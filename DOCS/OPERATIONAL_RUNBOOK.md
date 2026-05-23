# Operational Runbook

Purpose
- Provide quick steps for operators when incidents occur and how to use the kill-switch.

Kill-switch (immediate actions)
1. Check the current kill state file: `data/kill_switch.json`.
2. If kill is active, evaluate reason and recent logs:
   - Check `logs/*` and server stdout streams for `SystemKillSwitch` warnings.
3. To clear kill (human oversight required):
   - Edit `data/kill_switch.json` (not recommended) or use the provided admin CLI/API (TBD).

Emergency procedure (wrong-price / runaway losses)
1. Trigger immediate kill: set `system.kill` using admin API/CLI or by running a quick script:

```powershell
node ./scripts/toggle-kill.js --set --reason "emergency: excessive slippage"
```

2. Notify on-call (Slack/PagerDuty) with initial triage.
3. If required, and approved, perform controlled exits:
   - For liquid assets, use limit-close orders sized to reduce slippage.
   - For illiquid assets, consider staged exits or hedges.

Post-incident
1. Attach incident notes in `DOCS/INCIDENTS.md` with timestamp, cause, and remediation.
2. Revert to last-known-good configuration and redeploy.

Maintenance tasks
- Weekly: verify `data/kill_switch.json` exists and is readable by services.
- Weekly: run end-to-end shadow replay for top N symbols.
