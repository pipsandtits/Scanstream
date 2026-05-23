# Deployment & Canary Rollout Runbook

Purpose: safe, observable deployment and gradual promotion of new artifacts (images / packages).

Preconditions
- CI produces immutable artifact (container image tag or tarball) with SHA.
- Automated tests (unit, integration, smoke) pass in CI.
- Monitoring and alerting (Prometheus + Grafana) are reachable.
- DB migration reviewed and backward-compatible if required.

Steps
1. Publish artifact
   - Push image to registry and note SHA/tag.

2. Deploy to staging

```bash
# Example (k8s): update staging deployment image
kubectl -n staging set image deployment/scanstream scanstream=registry/org/scanstream:<SHA>
```

3. Run staging smoke tests
   - Health: `curl -fsS http://staging.example.com/health` should return 200
   - Metrics: `curl -fsS http://staging.example.com/metrics` should return Prometheus text
   - Run end-to-end small-case: run `pnpm build` and `node ./scripts/smoke-tests.js --env=staging` (or CI job)

4. Canary rollout (production)
   - Start with small percentage of replicas (10%):

```bash
# Update canary deployment (example helm/k8s)
kubectl -n prod set image deployment/scanstream scanstream=registry/org/scanstream:<SHA>
# then reduce replicas on canary or use service splitting (istio/traefik) to route 10%
```

5. Observe for 10–30 minutes
   - Check: `/health`, `/metrics`, key business metrics (P&L, fills, slippage), error rates, latency
   - Watch RL metrics (episodes, rewards), execution metrics (slippage, fills), and `executionBlocked` events

6. Gradually increase traffic
   - 10% -> 30% -> 60% -> 100% with 5–15 minute observation windows

7. Post-deploy checks (after 100%)
   - Run smoke local validation scripts and API tests
   - Confirm model versions & provenance for new trades

Notes on DB migrations
- Prefer expand-then-contract migrations.
- Run `npx prisma migrate dev --name <descr>` in CI or `npx prisma migrate deploy` in production if migrations are safe.
- If migration requires downtime, schedule a maintenance window and communicate.

Rollout decisions
- Abort if any critical alerts or regression thresholds breach (set in monitoring alerts): response time, error rate, P&L drift, or abnormal execution events.
- If aborting, follow rollback runbook.
