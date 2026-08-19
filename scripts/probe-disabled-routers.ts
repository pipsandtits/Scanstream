/**
 * Diagnostic for the route groups commented out in server/index.ts.
 *
 * Each candidate is imported and mounted on a throwaway Express app so the
 * actual failure (if any) is observed rather than guessed at. Run with:
 *   npx tsx scripts/probe-disabled-routers.ts
 */

import express from 'express';

const CANDIDATES: Array<{ mount: string; module: string; named?: string }> = [
  { mount: '/api/logs', module: '../server/routes/logs' },
  { mount: '/api/symbol-universe', module: '../server/routes/api/symbol-universe' },
  { mount: '/api/agents/physics', module: '../server/routes/physics-agents' },
  { mount: '/api/physics', module: '../server/routes/physics-validation' },
  { mount: '/api/agents/exit', module: '../server/routes/exit-agents' },
  { mount: '/api/scout', module: '../server/routes/scout-report-routes' },
  { mount: '/api/agents/interactions', module: '../server/routes/agent-interactions' },
  { mount: '/api/agents/signals', module: '../server/routes/agent-signal-insights' },
  { mount: '/api/agents/services-api', module: '../server/routes/agents' },
  { mount: '/api/optimize', module: '../server/routes/optimization' },
  { mount: '/api/strategies', module: '../server/routes/strategies' },
  { mount: '/api/model-performance', module: '../server/routes/model-performance' },
  { mount: '/api/backtest', module: '../server/routes/signal-backtesting' },
  { mount: '/api/backtest', module: '../server/routes/historical-backtest' },
  { mount: '/api/user', module: '../server/routes/user-settings' },
  { mount: '/api/health', module: '../server/routes/health' },
  { mount: '/api/analysis/multi-timeframe', module: '../server/routes/multi-timeframe-analysis' },
  { mount: '/api/backtest', module: '../server/routes/phase6-unified-backtest' },
  { mount: '/api/backtest', module: '../server/routes/capability-measurement' },
  { mount: '/api/backtest', module: '../server/routes/velocity-profile' },
  { mount: '/api/backtest', module: '../server/routes/adaptive-holding' },
  { mount: '/api/backtest', module: '../server/routes/agent-clustering' },
  { mount: '/api/signal-generation', module: '../server/routes/api/signal-generation' },
  { mount: '/api/execution', module: '../server/routes/trade-execution' },
];

function routeCount(router: any): number {
  return Array.isArray(router?.stack) ? router.stack.length : -1;
}

async function main() {
  for (const candidate of CANDIDATES) {
    const app = express();
    try {
      const mod: any = await import(candidate.module);
      const router = candidate.named ? mod[candidate.named] : (mod.default ?? mod.router);
      if (!router) {
        console.log(`MISSING_EXPORT  ${candidate.module}`);
        continue;
      }
      app.use(candidate.mount, router);
      console.log(`OK              ${candidate.mount} <- ${candidate.module} (${routeCount(router)} layers)`);
    } catch (err: any) {
      console.log(`FAIL            ${candidate.mount} <- ${candidate.module}: ${err?.message}`);
    }
  }
}

main();
