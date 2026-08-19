/**
 * Backend Health Check Endpoint
 * 
 * Monitors system health, exchange connections, and data freshness
 */

import express, { type Request, type Response } from 'express';
import { getErrorLogger } from '../services/error-logger';
import { getPerformanceTracker } from '../services/model-performance-tracker';
import { getBacktester } from '../services/signal-backtester';
import { systemKillSwitch } from '../services/system-kill-switch';
import { liveCircuitBreaker } from '../services/live-circuit-breaker';
import { getSafetyMetrics } from '../services/observability/safety-metrics';
import { db } from '../db-storage';

const router = express.Router();
const errorLogger = getErrorLogger();
const performanceTracker = getPerformanceTracker();
const backtester = getBacktester();

/**
 * GET /api/health
 * 
 * Comprehensive health status of the entire backend system
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const startTime = Date.now();

    // Get error summary
    const errorSummary = errorLogger.getErrorSummary();

    // Get model performance
    const modelMetrics = performanceTracker.calculateMetrics();

    // Get backtest stats
    const backtestStats = backtester.getStats();

    // Data freshness is not tracked by this router. It reports `null` rather
    // than a fabricated "fresh" value, which would let an operator believe
    // market data is current when nothing has verified that.
    const dataFreshness = null;

    // Determine overall health status
    const errorRateLastHour = errorSummary.totalErrors < 10 ? 'healthy' : 'degraded';
    const modelReady = modelMetrics.totalPredictions >= 50;
    const backtestReady = backtestStats.totalSignals >= 20;

    const status = {
      healthy: errorRateLastHour === 'healthy' && modelReady,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      responseTime: Date.now() - startTime
    };

    // Detailed health information
    const healthReport = {
      status,
      system: {
        uptime: process.uptime(),
        memoryUsage: {
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          external: Math.round(process.memoryUsage().external / 1024 / 1024)
        },
        responseTimeMs: Date.now() - startTime
      },
      exchanges: {
        status: 'unknown',
        connectedExchanges: null,
        dataFreshness,
        detail: 'exchange connectivity is not probed by this endpoint',
      },
      models: {
        ready: modelReady,
        totalPredictions: modelMetrics.totalPredictions,
        accuracy: (modelMetrics.accuracy || 0).toFixed(2),
        averageConfidence: (modelMetrics.avgConfidence || 0).toFixed(2),
        status: modelReady ? 'ready' : 'warming-up'
      },
      backtesting: {
        ready: backtestReady,
        totalSignals: backtestStats.totalSignals,
        winRate: (backtestStats.winRate || 0).toFixed(2),
        averageROI: (backtestStats.averageROI || 0).toFixed(2),
        status: backtestReady ? 'ready' : 'insufficient-data'
      },
      errors: {
        totalLast24h: errorSummary.totalErrors,
        byService: errorSummary.errorsByService,
        byExchange: errorSummary.errorsByExchange,
        trend: errorSummary.totalErrors < 5 ? 'improving' : 'stable'
      },
      logs: {
        total: errorLogger.getLogs().length,
        recent: errorSummary.recentErrors.length,
        status: errorSummary.totalErrors > 20 ? 'warning' : 'ok'
      }
    };

    res.json({
      success: true,
      health: healthReport,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/health/detailed
 * 
 * Comprehensive system diagnostics
 */
router.get('/detailed', (req: Request, res: Response) => {
  try {
    const errorSummary = errorLogger.getErrorSummary();
    const recentLogs = errorLogger.getLogs({ limit: 50 });
    const modelMetrics = performanceTracker.calculateMetrics();
    const backtestStats = backtester.getStats();

    res.json({
      success: true,
      diagnostics: {
        system: {
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          timestamp: Date.now()
        },
        errors: errorSummary,
        recentLogs,
        modelPerformance: modelMetrics,
        backtestPerformance: backtestStats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Detailed health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/health/exchanges
 * 
 * Exchange connectivity status
 */
router.get('/exchanges', (req: Request, res: Response) => {
  try {
    // Per-exchange status was previously a hardcoded list claiming exchanges
    // were "active" without ever contacting them. Only the error counts here
    // are observed, so status is reported as unknown.
    const errorSummary = errorLogger.getErrorSummary();
    const exchanges = ['binance', 'coinbase', 'kraken', 'kucoinfutures', 'okx', 'bybit'];

    const exchangeHealth = exchanges.map(name => ({
      name,
      status: 'unknown',
      errors: errorSummary.errorsByExchange[name] || 0,
      lastCheck: null,
    }));

    res.json({
      success: true,
      exchanges: exchangeHealth,
      summary: {
        probed: false,
        errors: exchangeHealth.reduce((sum, e) => sum + e.errors, 0),
        detail: 'connectivity is not probed here; see /api/health/readiness for live-trading gates',
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Exchange health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/health/logs
 * 
 * Recent system logs
 */
router.get('/logs', (req: Request, res: Response) => {
  try {
    const { level, service, exchange, limit = '50' } = req.query;

    const logs = errorLogger.getLogs({
      level: level as any,
      service: service as string | undefined,
      exchange: exchange as string | undefined,
      limit: parseInt(limit as string)
    });

    res.json({
      success: true,
      logs,
      count: logs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch logs',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /api/health/prune-logs
 * 
 * Clean up old logs
 */
router.post('/prune-logs', (req: Request, res: Response) => {
  try {
    errorLogger.pruneOldLogs();

    res.json({
      success: true,
      message: 'Logs pruned successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to prune logs',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/health/readiness
 *
 * Deployment/probe-facing readiness. Unlike the informational endpoints above,
 * this returns 503 when a subsystem that live trading depends on is unhealthy,
 * so an orchestrator or operator dashboard sees real failures.
 */
router.get('/readiness', (_req: Request, res: Response) => {
  const databaseConnected = (() => {
    try {
      return db.isDatabaseConnected();
    } catch {
      return false;
    }
  })();

  const killSwitch = systemKillSwitch.getState();
  const circuitBreaker = liveCircuitBreaker.getState();
  const safety = getSafetyMetrics();

  const checks = {
    database: { ok: databaseConnected, detail: databaseConnected ? 'connected' : 'in-memory fallback active (writes are not durable)' },
    killSwitch: { ok: !killSwitch.killed, detail: killSwitch.reason || null },
    circuitBreaker: { ok: !circuitBreaker.active, detail: circuitBreaker.reason || null },
    integrityGate: {
      ok: safety.integrityBypassBlocked === 0,
      detail: safety.integrityBypassBlocked > 0
        ? `${safety.integrityBypassBlocked} frame batches dropped by integrity gate failures`
        : null,
    },
  };

  // The kill switch and circuit breaker are *intended* states, not process
  // faults: they degrade rather than fail the probe. Losing durable storage or
  // dropping data at the integrity gate is a genuine fault.
  const ready = checks.database.ok && checks.integrityGate.ok;
  const degraded = !checks.killSwitch.ok || !checks.circuitBreaker.ok;

  res.status(ready ? 200 : 503).json({
    status: !ready ? 'DOWN' : degraded ? 'DEGRADED' : 'UP',
    ready,
    checks,
    safety,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
