import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  evaluatePreTrade,
  resolveHardLimits,
  HARD_LIMIT_CEILINGS,
  DEFAULT_HARD_LIMITS,
} from '../hard-limit-gate';
import { systemKillSwitch } from '../../system-kill-switch';
import { liveCircuitBreaker } from '../../live-circuit-breaker';

const NOW = 1_700_000_000_000;

function request(overrides: Partial<Parameters<typeof evaluatePreTrade>[0]> = {}) {
  return {
    symbol: 'BTC/USDT',
    price: 67_000,
    signalTimestamp: NOW,
    requestedSizeUsd: 500,
    currentExposureUsd: 0,
    symbolExposureUsd: 0,
    openPositions: 0,
    leverage: 3,
    engineEnabled: true,
    now: NOW,
    ...overrides,
  };
}

describe('hard limit gate', () => {
  const envKeys = [
    'RISK_MAX_POSITION_USD',
    'RISK_MAX_TOTAL_EXPOSURE_USD',
    'RISK_MAX_SYMBOL_EXPOSURE_USD',
    'RISK_MAX_OPEN_POSITIONS',
    'RISK_MAX_LEVERAGE',
    'RISK_MAX_SIGNAL_AGE_MS',
  ];

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    vi.spyOn(systemKillSwitch, 'isKilled').mockReturnValue(false);
    vi.spyOn(liveCircuitBreaker, 'isActive').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a compliant trade', () => {
    expect(evaluatePreTrade(request()).allowed).toBe(true);
  });

  it('blocks when the kill switch is active', () => {
    vi.spyOn(systemKillSwitch, 'isKilled').mockReturnValue(true);
    const decision = evaluatePreTrade(request());
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('kill_switch_active');
  });

  it('blocks when the live circuit breaker is active', () => {
    vi.spyOn(liveCircuitBreaker, 'isActive').mockReturnValue(true);
    expect(evaluatePreTrade(request()).code).toBe('circuit_breaker_active');
  });

  it('blocks when the engine is disabled', () => {
    expect(evaluatePreTrade(request({ engineEnabled: false })).code).toBe('engine_disabled');
  });

  it('blocks stale signals', () => {
    const decision = evaluatePreTrade(request({ signalTimestamp: NOW - 120_000 }));
    expect(decision.code).toBe('stale_signal');
  });

  it('blocks unusable prices and sizes', () => {
    expect(evaluatePreTrade(request({ price: 0 })).code).toBe('invalid_price');
    expect(evaluatePreTrade(request({ price: NaN })).code).toBe('invalid_price');
    expect(evaluatePreTrade(request({ requestedSizeUsd: 0 })).code).toBe('invalid_size');
    expect(evaluatePreTrade(request({ requestedSizeUsd: Infinity })).code).toBe('invalid_size');
  });

  it('blocks when exposure inputs are unknown rather than assuming zero', () => {
    expect(evaluatePreTrade(request({ currentExposureUsd: NaN })).code).toBe('invalid_size');
    expect(evaluatePreTrade(request({ symbolExposureUsd: NaN })).code).toBe('invalid_size');
    expect(evaluatePreTrade(request({ openPositions: NaN })).code).toBe('gate_error');
  });

  it('enforces max position size', () => {
    expect(evaluatePreTrade(request({ requestedSizeUsd: 5_000 })).code).toBe('max_position_size');
  });

  it('enforces total exposure including the new order', () => {
    const decision = evaluatePreTrade(request({ currentExposureUsd: 4_800, requestedSizeUsd: 500 }));
    expect(decision.code).toBe('max_total_exposure');
  });

  it('enforces per-symbol exposure', () => {
    const decision = evaluatePreTrade(
      request({ symbolExposureUsd: 1_900, requestedSizeUsd: 500 }),
      { maxTotalExposureUsd: 100_000 }
    );
    expect(decision.code).toBe('max_symbol_exposure');
  });

  it('enforces max open positions', () => {
    expect(evaluatePreTrade(request({ openPositions: 5 })).code).toBe('max_open_positions');
  });

  it('enforces max leverage', () => {
    expect(evaluatePreTrade(request({ leverage: 50 })).code).toBe('max_leverage');
    expect(evaluatePreTrade(request({ leverage: 0 })).code).toBe('invalid_leverage');
  });

  it('never lets configuration widen a limit past the compiled ceiling', () => {
    const limits = resolveHardLimits({
      maxPositionSizeUsd: 10_000_000,
      maxTotalExposureUsd: 10_000_000,
      maxOpenPositions: 1_000,
      maxLeverage: 500,
    });
    expect(limits.maxPositionSizeUsd).toBe(HARD_LIMIT_CEILINGS.maxPositionSizeUsd);
    expect(limits.maxTotalExposureUsd).toBe(HARD_LIMIT_CEILINGS.maxTotalExposureUsd);
    expect(limits.maxOpenPositions).toBe(HARD_LIMIT_CEILINGS.maxOpenPositions);
    expect(limits.maxLeverage).toBe(HARD_LIMIT_CEILINGS.maxLeverage);
  });

  it('lets configuration tighten a limit', () => {
    expect(resolveHardLimits({ maxPositionSizeUsd: 100 }).maxPositionSizeUsd).toBe(100);
  });

  it('ignores junk configuration and falls back to defaults', () => {
    process.env.RISK_MAX_POSITION_USD = 'not-a-number';
    expect(resolveHardLimits().maxPositionSizeUsd).toBe(DEFAULT_HARD_LIMITS.maxPositionSizeUsd);
    process.env.RISK_MAX_POSITION_USD = '-50';
    expect(resolveHardLimits().maxPositionSizeUsd).toBe(DEFAULT_HARD_LIMITS.maxPositionSizeUsd);
  });

  it('reads tightened limits from the environment', () => {
    process.env.RISK_MAX_OPEN_POSITIONS = '2';
    expect(evaluatePreTrade(request({ openPositions: 2 })).code).toBe('max_open_positions');
  });

  it('fails closed when a safety control throws', () => {
    vi.spyOn(systemKillSwitch, 'isKilled').mockImplementation(() => {
      throw new Error('state unreadable');
    });
    const decision = evaluatePreTrade(request());
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('gate_error');
  });
});
