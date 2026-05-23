# Deployment & Rollback

Containers
- Prefer Docker images and orchestrate with docker-compose or k8s for production.

Canary / Blue-Green
- Use canary deploys: route small % of traffic to new image, monitor key metrics (fill rate, slippage, kill-switch), then promote.
- Keep previous image/tag available to rollback quickly.

Release steps (simple)
1. Build images and tag with semantic version.
2. Push images to registry.
3. Update deployment manifest and apply (or update docker-compose files).
4. Monitor health checks for 10–30 minutes.
5. Promote or rollback depending on metrics.

Emergency rollback
- Flip `system.kill`.
- Roll back to previous image tag and verify `kill_switch` cleared and metrics stabilized before resuming.
