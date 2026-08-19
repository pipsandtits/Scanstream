/**
 * Hard Limit Gate — non-overridable pre-trade risk boundary.
 *
 * Every execution path (live engine, manual /execute, agents, strategies) must
 * pass through `evaluatePreTrade()` before an order reaches an exchange.
 *
 * Design rules:
 *  - Fail closed: any internal error blocks the trade (`gate_error`).
 *  - Non-overridable: env vars may only *tighten* a limit, never loosen it past
 *    the compiled ceilings below.
 *  - Pure and synchronous: no I/O, so it cannot hang or be skipped by a timeout.
 */

import { systemKillSwitch } from '../system-kill-switch';
import { liveCircuitBreaker } from '../live-circuit-breaker';

export interface HardLimits {
  /** Max notional USD for a single position. */
  maxPositionSizeUsd: number;
  /** Max total notional USD across all open positions. */
  maxTotalExposureUsd: number;
  /** Max notional USD per symbol across all open positions. */
  maxSymbolExposureUsd: number;
  /** Max number of concurrently open positions. */
  maxOpenPositions: number;
  /** Max leverage multiplier. */
  maxLeverage: number;
  /** Signals older than this are rejected. */
  maxSignalAgeMs: number;
}

/** Absolute ceilings. Configuration may lower these values but never raise them. */
export const HARD_LIMIT_CEILINGS: Readonly<HardLimits> = Object.freeze({
  maxPositionSizeUsd: 100_000,
  maxTotalExposureUsd: 500_000,
  maxSymbolExposureUsd: 100_000,
  maxOpenPositions: 25,
  maxLeverage: 20,
  maxSignalAgeMs: 5 * 60_000,
});

export const DEFAULT_HARD_LIMITS: Readonly<HardLimits> = Object.freeze({
  maxPositionSizeUsd: 1_000,
  maxTotalExposureUsd: 5_000,
  maxSymbolExposureUsd: 2_000,
  maxOpenPositions: 5,
  maxLeverage: 5,
  maxSignalAgeMs: 60_000,
});

export type BlockCode =
  | 'kill_switch_active'
  | 'circuit_breaker_active'
  | 'engine_disabled'
  | 'invalid_price'
  | 'invalid_size'
  | 'invalid_leverage'
  | 'stale_signal'
  | 'max_position_size'
  | 'max_total_exposure'
  | 'max_symbol_exposure'
  | 'max_open_positions'
  | 'max_leverage'
  | 'gate_error';

export interface PreTradeRequest {
  symbol: string;
  /** Signal price used for sizing. Must be finite and > 0. */
  price: number;
  /** Signal creation time (ms epoch). */
  signalTimestamp?: number | Date | null;
  /** Requested notional in USD. */
  requestedSizeUsd: number;
  /** Notional USD already open across all symbols (excluding this request). */
  currentExposureUsd: number;
  /** Notional USD already open for this symbol (excluding this request). */
  symbolExposureUsd?: number;
  /** Number of currently open positions. */
  openPositions: number;
  /** Leverage that will be applied. */
  leverage?: number;
  /** Whether the caller's engine is enabled. */
  engineEnabled?: boolean;
  /** Injectable clock for tests. */
  now?: number;
}

export interface GateDecision {
  allowed: boolean;
  code?: BlockCode;
  reason?: string;
  limits: HardLimits;
}

function clampToCeiling(value: number | undefined, ceiling: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, ceiling);
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve effective limits: defaults, overridden by config/env, clamped to the
 * compiled ceilings so no caller can widen a hard limit.
 */
export function resolveHardLimits(overrides?: Partial<HardLimits>): HardLimits {
  const fromEnv: Partial<HardLimits> = {
    maxPositionSizeUsd: envNumber('RISK_MAX_POSITION_USD'),
    maxTotalExposureUsd: envNumber('RISK_MAX_TOTAL_EXPOSURE_USD'),
    maxSymbolExposureUsd: envNumber('RISK_MAX_SYMBOL_EXPOSURE_USD'),
    maxOpenPositions: envNumber('RISK_MAX_OPEN_POSITIONS'),
    maxLeverage: envNumber('RISK_MAX_LEVERAGE'),
    maxSignalAgeMs: envNumber('RISK_MAX_SIGNAL_AGE_MS'),
  };

  const merged = { ...DEFAULT_HARD_LIMITS, ...prune(fromEnv), ...prune(overrides) };

  return {
    maxPositionSizeUsd: clampToCeiling(merged.maxPositionSizeUsd, HARD_LIMIT_CEILINGS.maxPositionSizeUsd, DEFAULT_HARD_LIMITS.maxPositionSizeUsd),
    maxTotalExposureUsd: clampToCeiling(merged.maxTotalExposureUsd, HARD_LIMIT_CEILINGS.maxTotalExposureUsd, DEFAULT_HARD_LIMITS.maxTotalExposureUsd),
    maxSymbolExposureUsd: clampToCeiling(merged.maxSymbolExposureUsd, HARD_LIMIT_CEILINGS.maxSymbolExposureUsd, DEFAULT_HARD_LIMITS.maxSymbolExposureUsd),
    maxOpenPositions: Math.floor(clampToCeiling(merged.maxOpenPositions, HARD_LIMIT_CEILINGS.maxOpenPositions, DEFAULT_HARD_LIMITS.maxOpenPositions)),
    maxLeverage: clampToCeiling(merged.maxLeverage, HARD_LIMIT_CEILINGS.maxLeverage, DEFAULT_HARD_LIMITS.maxLeverage),
    maxSignalAgeMs: clampToCeiling(merged.maxSignalAgeMs, HARD_LIMIT_CEILINGS.maxSignalAgeMs, DEFAULT_HARD_LIMITS.maxSignalAgeMs),
  };
}

/** Drop unset keys so they do not overwrite lower-precedence values. */
function prune(obj?: Partial<HardLimits>): Partial<HardLimits> {
  if (!obj) return {};
  const out: Partial<HardLimits> = {};
  const keys: Array<keyof HardLimits> = [
    'maxPositionSizeUsd',
    'maxTotalExposureUsd',
    'maxSymbolExposureUsd',
    'maxOpenPositions',
    'maxLeverage',
    'maxSignalAgeMs',
  ];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function toMillis(ts: number | Date | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  return null;
}

/**
 * Evaluate all hard limits. Never throws: internal failures block the trade.
 */
export function evaluatePreTrade(req: PreTradeRequest, overrides?: Partial<HardLimits>): GateDecision {
  let limits: HardLimits = { ...DEFAULT_HARD_LIMITS };
  try {
    limits = resolveHardLimits(overrides);

    const block = (code: BlockCode, reason: string): GateDecision => ({ allowed: false, code, reason, limits });

    if (systemKillSwitch.isKilled()) {
      const state = systemKillSwitch.getState();
      return block('kill_switch_active', `system kill-switch active: ${state.reason || 'unspecified'}`);
    }

    if (liveCircuitBreaker.isActive()) {
      const state = liveCircuitBreaker.getState();
      return block('circuit_breaker_active', `live circuit breaker active: ${state.reason || 'unspecified'}`);
    }

    if (req.engineEnabled === false) {
      return block('engine_disabled', 'execution engine is not enabled');
    }

    if (typeof req.price !== 'number' || !Number.isFinite(req.price) || req.price <= 0) {
      return block('invalid_price', `non-usable price: ${String(req.price)}`);
    }

    if (typeof req.requestedSizeUsd !== 'number' || !Number.isFinite(req.requestedSizeUsd) || req.requestedSizeUsd <= 0) {
      return block('invalid_size', `non-usable size: ${String(req.requestedSizeUsd)}`);
    }

    const currentExposure = Number.isFinite(req.currentExposureUsd) ? req.currentExposureUsd : NaN;
    if (!Number.isFinite(currentExposure) || currentExposure < 0) {
      return block('invalid_size', `unknown current exposure: ${String(req.currentExposureUsd)}`);
    }

    const leverage = req.leverage === undefined ? 1 : req.leverage;
    if (!Number.isFinite(leverage) || leverage <= 0) {
      return block('invalid_leverage', `non-usable leverage: ${String(req.leverage)}`);
    }
    if (leverage > limits.maxLeverage) {
      return block('max_leverage', `leverage ${leverage} > max ${limits.maxLeverage}`);
    }

    const signalTs = toMillis(req.signalTimestamp);
    if (signalTs !== null) {
      const now = req.now ?? Date.now();
      const age = now - signalTs;
      if (age > limits.maxSignalAgeMs) {
        return block('stale_signal', `signal age ${age}ms > max ${limits.maxSignalAgeMs}ms`);
      }
    }

    if (req.requestedSizeUsd > limits.maxPositionSizeUsd) {
      return block('max_position_size', `size ${req.requestedSizeUsd} > max ${limits.maxPositionSizeUsd}`);
    }

    if (currentExposure + req.requestedSizeUsd > limits.maxTotalExposureUsd) {
      return block(
        'max_total_exposure',
        `exposure ${currentExposure} + ${req.requestedSizeUsd} > max ${limits.maxTotalExposureUsd}`
      );
    }

    const symbolExposure = req.symbolExposureUsd ?? 0;
    if (!Number.isFinite(symbolExposure) || symbolExposure < 0) {
      return block('invalid_size', `unknown symbol exposure: ${String(req.symbolExposureUsd)}`);
    }
    if (symbolExposure + req.requestedSizeUsd > limits.maxSymbolExposureUsd) {
      return block(
        'max_symbol_exposure',
        `${req.symbol} exposure ${symbolExposure} + ${req.requestedSizeUsd} > max ${limits.maxSymbolExposureUsd}`
      );
    }

    if (!Number.isFinite(req.openPositions) || req.openPositions < 0) {
      return block('gate_error', `unknown open position count: ${String(req.openPositions)}`);
    }
    if (req.openPositions >= limits.maxOpenPositions) {
      return block('max_open_positions', `open positions ${req.openPositions} >= max ${limits.maxOpenPositions}`);
    }

    return { allowed: true, limits };
  } catch (err: any) {
    return {
      allowed: false,
      code: 'gate_error',
      reason: `hard limit gate failed closed: ${err?.message || String(err)}`,
      limits,
    };
  }
}

export default evaluatePreTrade;
