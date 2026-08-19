/**
 * In-process counters for the safety-critical path.
 *
 * Deliberately dependency-free so the health endpoint can report subsystem
 * degradation even when the Prometheus client is unavailable.
 *
 * Counters are lost on restart, which is exactly when they matter most, so the
 * safety-critical events behind them are also appended to the durable safety
 * event log.
 */

import { safetyEventLog } from './safety-event-log';

export interface SafetyMetricsSnapshot {
  integrityBypassBlocked: number;
  candlesRejected: number;
  candleRejectReasons: Record<string, number>;
  executionsBlocked: number;
  executionBlockReasons: Record<string, number>;
  orderReconciliations: Record<string, number>;
  flattenAllRuns: number;
  flattenAllFailures: number;
  lastIntegrityBypassAt: number | null;
  lastExecutionBlockAt: number | null;
}

const state: SafetyMetricsSnapshot = {
  integrityBypassBlocked: 0,
  candlesRejected: 0,
  candleRejectReasons: {},
  executionsBlocked: 0,
  executionBlockReasons: {},
  orderReconciliations: {},
  flattenAllRuns: 0,
  flattenAllFailures: 0,
  lastIntegrityBypassAt: null,
  lastExecutionBlockAt: null,
};

function bump(bucket: Record<string, number>, key: string, by = 1): void {
  bucket[key] = (bucket[key] || 0) + by;
}

export function recordIntegrityBypassBlocked(symbol: string, timeframe: string, frameCount: number): void {
  state.integrityBypassBlocked += 1;
  state.lastIntegrityBypassAt = Date.now();
  bump(state.candleRejectReasons, `integrity_gate_failure:${timeframe}`, frameCount);
  safetyEventLog.record({
    type: 'integrity_bypass_blocked',
    detail: `${symbol} ${timeframe}`,
    data: { symbol, timeframe, frameCount },
  });
}

export function recordCandlesRejected(reasons: string[]): void {
  state.candlesRejected += reasons.length;
  for (const reason of reasons) bump(state.candleRejectReasons, reason);
  if (reasons.length > 0) {
    safetyEventLog.record({
      type: 'candle_rejected',
      detail: `${reasons.length} candle(s) rejected`,
      data: { reasons },
    });
  }
}

export function recordExecutionBlocked(code: string): void {
  state.executionsBlocked += 1;
  state.lastExecutionBlockAt = Date.now();
  bump(state.executionBlockReasons, code || 'unknown');
  safetyEventLog.record({ type: 'execution_blocked', detail: code || 'unknown' });
}

export function recordOrderReconciliation(resultState: string): void {
  bump(state.orderReconciliations, resultState);
  if (resultState === 'unknown') {
    safetyEventLog.record({ type: 'order_state_unknown', detail: resultState });
  }
}

export function recordFlattenAll(failed: number): void {
  state.flattenAllRuns += 1;
  if (failed > 0) state.flattenAllFailures += failed;
  safetyEventLog.record({
    type: failed > 0 ? 'flatten_failed' : 'flatten_all',
    detail: failed > 0 ? `${failed} position(s) failed to close` : 'all positions closed',
    data: { failed },
  });
}

export function getSafetyMetrics(): SafetyMetricsSnapshot {
  return {
    ...state,
    candleRejectReasons: { ...state.candleRejectReasons },
    executionBlockReasons: { ...state.executionBlockReasons },
    orderReconciliations: { ...state.orderReconciliations },
  };
}

/** Test helper. */
export function resetSafetyMetrics(): void {
  state.integrityBypassBlocked = 0;
  state.candlesRejected = 0;
  state.candleRejectReasons = {};
  state.executionsBlocked = 0;
  state.executionBlockReasons = {};
  state.orderReconciliations = {};
  state.flattenAllRuns = 0;
  state.flattenAllFailures = 0;
  state.lastIntegrityBypassAt = null;
  state.lastExecutionBlockAt = null;
}
