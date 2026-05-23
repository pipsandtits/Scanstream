import { Router } from 'express';
import type { Request, Response } from 'express';
import { rlMetricsRegister } from '../rl-metrics';
import { metricsRegister } from '../metrics-execution';
import scannerMetrics from '../services/scanner/scanner-metrics';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    // Collect metrics from available registries and concatenate
    const parts: string[] = [];

    if (rlMetricsRegister && typeof rlMetricsRegister.metrics === 'function') {
      try { parts.push(await rlMetricsRegister.metrics()); } catch (e) { /* ignore */ }
    }

    if (metricsRegister && typeof metricsRegister.metrics === 'function') {
      try { parts.push(await metricsRegister.metrics()); } catch (e) { /* ignore */ }
    }

    try {
      const r = scannerMetrics.getRegistry();
      if (r && typeof r.metrics === 'function') {
        try { parts.push(await r.metrics()); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // ignore
    }

    // If nothing collected, return 204
    if (parts.length === 0) {
      return res.status(204).send('');
    }

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(parts.join('\n'));
  } catch (error: any) {
    console.error('[Metrics] Error collecting metrics', error);
    res.status(500).json({ success: false, error: error?.message ?? String(error) });
  }
});

export default router;
