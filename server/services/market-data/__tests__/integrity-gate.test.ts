import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const createMarketFrame = vi.fn(async (frame: any) => ({ ...frame, id: 'frame-1' }));

vi.mock('../../../storage', () => ({
  storage: {
    createMarketFrame: (frame: any) => createMarketFrame(frame),
  },
}));

import { IntegrityGate, getLiveEpoch } from '../integrity-gate';
import { CandleIntegrityFactory } from '../candle-integrity-layer';
import type { Candle } from '../../../types/market-data';

const TF = 60; // 1m
let symbolSeq = 0;
let SYMBOL = 'BTC/USDT';

/** Minute-aligned timestamp in the live window. */
function ts(minutesFromNow: number): number {
  const base = Math.floor(Date.now() / 60_000) * 60_000;
  return base + minutesFromNow * 60_000;
}

function candle(overrides: Partial<Candle> & { ts: number }): Candle {
  return {
    open: 67_000.25,
    high: 67_100.5,
    low: 66_900.1,
    close: 67_050.75,
    volume: 12.5,
    isFinal: true,
    source: 'live',
    ...overrides,
  } as Candle;
}

describe('IntegrityGate storage/emission ordering', () => {
  let gate: IntegrityGate;

  beforeEach(() => {
    createMarketFrame.mockClear();
    createMarketFrame.mockImplementation(async (frame: any) => ({ ...frame, id: 'frame-1' }));
    CandleIntegrityFactory.reset();
    getLiveEpoch().reset();
    // Per-test symbol keeps the LiveEpoch/integrity-layer state isolated.
    SYMBOL = `T${symbolSeq++}/USDT`;
    gate = new IntegrityGate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores before emitting and keeps worldTime distinct from emitTime', async () => {
    const order: string[] = [];
    createMarketFrame.mockImplementation(async (frame: any) => {
      order.push('store');
      return { ...frame, id: 'frame-1' };
    });
    gate.on('world.tick', () => order.push('tick'));

    const c = candle({ ts: ts(-5) });
    const result = await gate.storeValidatedCandles(SYMBOL, TF, [c]);

    expect(result.stored).toHaveLength(1);
    expect(result.ticks).toHaveLength(1);
    expect(order).toEqual(['store', 'tick']);

    const tick = result.ticks[0];
    // worldTime is market time (candle close), emitTime is wall-clock.
    expect(tick.worldTime).toBe(c.ts + TF * 1000);
    expect(tick.emitTime).toBeGreaterThanOrEqual(tick.worldTime);
    expect(tick.marketFrameId).toBe('frame-1');
  });

  it('suppresses the world tick when persistence fails', async () => {
    createMarketFrame.mockImplementation(async () => {
      throw new Error('db down');
    });
    const ticks: unknown[] = [];
    const errors: unknown[] = [];
    gate.on('world.tick', (t) => ticks.push(t));
    gate.on('storage.error', (e) => errors.push(e));

    const result = await gate.storeValidatedCandles(SYMBOL, TF, [candle({ ts: ts(-5) })]);

    expect(result.stored).toHaveLength(0);
    expect(result.ticks).toHaveLength(0);
    expect(ticks).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('rejects a time regression before it can be stored', async () => {
    const epoch = getLiveEpoch();
    epoch.initializeLiveStart();

    // Establish forward progress first.
    await gate.storeValidatedCandles(SYMBOL, TF, [candle({ ts: ts(2) })]);
    expect(createMarketFrame).toHaveBeenCalledTimes(1);
    createMarketFrame.mockClear();

    // Then feed an older live candle: it must never reach storage.
    const ticks: unknown[] = [];
    gate.on('world.tick', (t) => ticks.push(t));
    const result = await gate.storeValidatedCandles(SYMBOL, TF, [candle({ ts: ts(1) })]);

    expect(createMarketFrame).not.toHaveBeenCalled();
    expect(result.stored).toHaveLength(0);
    expect(ticks).toHaveLength(0);
  });

  it('does not apply live regression checks to historical backfill', async () => {
    const epoch = getLiveEpoch();
    epoch.initializeLiveStart();

    await gate.storeValidatedCandles(SYMBOL, TF, [candle({ ts: ts(2) })]);
    createMarketFrame.mockClear();

    const result = await gate.storeValidatedCandles(SYMBOL, TF, [
      candle({ ts: ts(-30), source: 'historical' }),
    ]);

    expect(result.stored).toHaveLength(1);
    expect(createMarketFrame).toHaveBeenCalledTimes(1);
  });

  it('never stores a candle rejected by OHLC validation', async () => {
    const broken = candle({ ts: ts(-5) });
    (broken as any).high = 1; // high below low/open/close

    const result = await gate.storeValidatedCandles(SYMBOL, TF, [broken]);

    expect(result.stored).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(createMarketFrame).not.toHaveBeenCalled();
  });

  it('deduplicates candles sharing a timestamp', async () => {
    const t = ts(-5);
    const result = await gate.storeValidatedCandles(SYMBOL, TF, [
      candle({ ts: t }),
      candle({ ts: t }),
    ]);
    expect(result.stored).toHaveLength(1);
    expect(createMarketFrame).toHaveBeenCalledTimes(1);
  });
});
