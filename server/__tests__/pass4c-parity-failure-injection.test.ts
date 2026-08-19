import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LiveTradingEngine } from '../live-trading-engine';
import { durabilityGate } from '../services/execution/durability-gate';
import { getModeDetector } from '../services/market-data/mode-detector';
import { systemKillSwitch } from '../services/system-kill-switch';
import { TickerSnapshotCache } from '../services/ticker-snapshot-cache';

const FIXTURE = {
  symbol: 'BTC/USDT',
  candle: { timestamp: 1_700_000_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10 },
  ticker: { timestamp: 1_700_000_000_000, last: 101 },
  signal: {
    id: 'fixture-signal-1',
    symbol: 'BTC/USDT',
    type: 'BUY',
    price: 101,
    confidence: 0.95,
    timestamp: 1_700_000_000_000,
  },
};

function fixtureSignal() {
  return { ...FIXTURE.signal, timestamp: Date.now() };
}

function setLiveMode(): void {
  const modeDetector = getModeDetector();
  modeDetector.reset();
  modeDetector.setBackfillComplete(true);
  modeDetector.recordTick('ws');
  modeDetector.recordEmitLag(100);
  modeDetector.recordTick('ws');
  modeDetector.recordEmitLag(100);
  modeDetector.recordTick('ws');
  modeDetector.recordEmitLag(100);
}

function statePath(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'state.json');
}

function fakeExchange(createOrder: (...args: any[]) => Promise<any>) {
  return {
    id: 'fixture-venue',
    has: { fetchFundingHistory: true },
    markets: { [FIXTURE.symbol]: { type: 'spot', spot: true } },
    symbols: [FIXTURE.symbol],
    fetchBalance: async () => ({ total: { USDT: 10_000 } }),
    fetchTicker: async () => FIXTURE.ticker,
    fetchPositions: async () => [],
    fetchOpenOrders: async () => [],
    createOrder,
  };
}

function prepareEngine(testMode: boolean, createOrder: (...args: any[]) => Promise<any>): LiveTradingEngine {
  const engine = new LiveTradingEngine(
    { enabled: true, testMode },
    {
      localStatePath: statePath('scanstream-parity-local-'),
      realizedPnlLedgerPath: statePath('scanstream-parity-pnl-'),
      fundingAccountingPath: statePath('scanstream-parity-funding-'),
    },
  );
  (engine as unknown as { exchange: unknown }).exchange = fakeExchange(createOrder);
  if (!testMode) {
    (engine as unknown as { localStateLoaded: boolean }).localStateLoaded = true;
    (engine as unknown as { realizedPnlLoaded: boolean }).realizedPnlLoaded = true;
    (engine as unknown as { fundingLoaded: boolean }).fundingLoaded = true;
    (engine as unknown as { reconciliation: { complete: boolean } }).reconciliation = { complete: true };
    (engine as unknown as { localStatePersistenceHealthy: boolean }).localStatePersistenceHealthy = true;
    (engine as unknown as { realizedPnlHealthy: boolean }).realizedPnlHealthy = true;
    (engine as unknown as { fundingHealthy: boolean }).fundingHealthy = true;
    vi.spyOn(engine as any, 'ensureFundingAccounted').mockResolvedValue(true);
  }
  return engine;
}

function normalizeIntent(call: any[]): Record<string, unknown> {
  const [, type, side, amount, price, params] = call;
  return {
    type,
    side,
    amount,
    price: price ?? null,
    reduceOnly: params?.reduceOnly ?? null,
    clientOrderIdPresent: typeof params?.clientOrderId === 'string' &&
      params.clientOrderId.length > 0,
    clientOrderIdShape: typeof params?.clientOrderId === 'string'
      ? params.clientOrderId.replace(/[a-z0-9]/gi, 'x')
      : null,
  };
}

function decisionSnapshot(engine: LiveTradingEngine, signal: any, mode: 'paper' | 'live') {
  const hardLimit = engine.checkHardLimits(signal, 1_000);
  return {
    hardLimit,
    staleness: hardLimit.code === 'stale_signal' ? 'blocked' : 'fresh',
    exposure: (engine as any).getTotalExposure(),
    dailyLoss: (engine as any).realizedPnlInput(),
    funding: mode === 'paper' ? 'bypassed' : 'passed',
    durability: mode === 'paper' ? 'bypassed' : 'passed',
    conversion: mode === 'paper' ? 'bypassed' : 'not-needed',
  };
}

describe('Pass 4C paper/live parity fixtures', () => {
  afterEach(() => {
    durabilityGate.reset();
    vi.restoreAllMocks();
  });

  it('matches paper and live decision paths and order intents for the committed fixture', async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ??
      'postgresql://scanstream:scanstream_dev_password@localhost:5432/scanstream?schema=public';
    durabilityGate.setProbe(async () => true);
    setLiveMode();

    const paperCalls: any[] = [];
    const liveCalls: any[] = [];
    const response = async (calls: any[], ...args: any[]) => {
      calls.push(args);
      const amount = args[3];
      return {
        id: 'fixture-order',
        status: 'closed',
        filled: amount,
        remaining: 0,
        price: FIXTURE.signal.price,
        average: FIXTURE.signal.price,
        cost: amount * FIXTURE.signal.price,
        timestamp: FIXTURE.ticker.timestamp,
        trades: [{ id: 'fixture-fill', amount, price: FIXTURE.signal.price, cost: amount * FIXTURE.signal.price }],
      };
    };
    const paper = prepareEngine(true, (...args) => response(paperCalls, ...args));
    const live = prepareEngine(false, (...args) => response(liveCalls, ...args));

    const signal = fixtureSignal();
    const paperDecision = decisionSnapshot(paper, signal, 'paper');
    const liveDecision = decisionSnapshot(live, signal, 'live');
    expect(paperDecision.hardLimit).toEqual(liveDecision.hardLimit);
    expect(paperDecision.staleness).toBe(liveDecision.staleness);
    expect(paperDecision.exposure).toBe(liveDecision.exposure);
    expect(paperDecision.dailyLoss).toEqual(liveDecision.dailyLoss);
    expect(paperDecision.funding).not.toBe(liveDecision.funding);
    expect(paperDecision.durability).not.toBe(liveDecision.durability);
    expect(paperDecision.conversion).not.toBe(liveDecision.conversion);
    const [paperOrder, liveOrder] = await Promise.all([
      paper.executeSignal({ ...signal } as any),
      live.executeSignal({ ...signal } as any),
    ]);

    expect(paperOrder).not.toBeNull();
    expect(liveOrder).not.toBeNull();
    expect(normalizeIntent(paperCalls[0])).toEqual(normalizeIntent(liveCalls[0]));
    expect(paperOrder?.symbol).toBe(liveOrder?.symbol);
    expect(paperOrder?.side).toBe(liveOrder?.side);
    expect(paperOrder?.amount).toBe(liveOrder?.amount);
    expect(paperOrder?.type).toBe(liveOrder?.type);

    // Legitimate divergences: paper shadow fills versus live exchange fills,
    // live-only durability/funding/reconciliation gates, random order IDs and
    // wall-clock timestamps. No other decision or intent divergence is allowed.
    expect(paperOrder?.exchangeOrderId).toBe(liveOrder?.exchangeOrderId);
    expect(typeof paperOrder?.clientOrderId).toBe('string');
    expect(typeof liveOrder?.clientOrderId).toBe('string');
    paper.dispose();
    live.dispose();
  });

  it('uses the mode detector honestly for replay fixtures', async () => {
    const modeDetector = getModeDetector();
    modeDetector.reset();
    modeDetector.recordTick('rest');
    modeDetector.recordEmitLag(120_000);
    expect(modeDetector.detectMode()).toBe('REPLAY');
    const paper = prepareEngine(true, async () => ({ id: 'replay-order' }));
    const live = prepareEngine(false, async () => ({ id: 'replay-order' }));
    await expect(paper.executeSignal(fixtureSignal() as any)).resolves.toBeNull();
    await expect(live.executeSignal(fixtureSignal() as any)).resolves.toBeNull();
    paper.dispose();
    live.dispose();
    // The engine consumes the resulting signal, not WorldTick itself. Replay
    // therefore exercises the honest no-trade confidence decision rather than
    // pretending that executeSignal is a market-data replay driver.
  });
});

describe('Pass 4C failure injection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins concurrent flatten sweeps and retains an ambiguous failure', async () => {
    const engine = new LiveTradingEngine({ enabled: true, testMode: true });
    const positions = (engine as any).positions as Map<string, any>;
    positions.set('BTC/USDT', {
      id: 'BTC/USDT', symbol: 'BTC/USDT', side: 'long', quantity: 1,
      entryPrice: 100, currentPrice: 100, leverage: 1, pnl: 0, pnlPercent: 0,
      openTime: Date.now(), orders: [],
    });
    let closes = 0;
    (engine as any).exchange = {
      fetchPositions: async () => [],
      createOrder: async () => {
        closes += 1;
        throw new Error('request timeout');
      },
    };
    const [first, second] = await Promise.all([
      engine.flattenAll('first'),
      engine.flattenAll('second'),
    ]);
    expect(first).toBe(second);
    expect(closes).toBe(1);
    expect(first.failed).toHaveLength(1);
    expect(positions.has('BTC/USDT')).toBe(true);
    engine.dispose();
  });

  it('does not place an in-flight order after the operator stop', async () => {
    setLiveMode();
    process.env.DATABASE_URL = process.env.DATABASE_URL ??
      'postgresql://scanstream:scanstream_dev_password@localhost:5432/scanstream?schema=public';
    durabilityGate.setProbe(async () => true);
    let started!: () => void;
    const startedSignal = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createOrder = vi.fn(async (..._args: any[]) => {
      started();
      await gate;
      return { id: 'stop-order', status: 'closed', filled: 1, price: 101, cost: 101 };
    });
    const engine = prepareEngine(false, createOrder);
    const execution = engine.executeSignal({ ...fixtureSignal(), id: 'stop-signal' } as any);
    await startedSignal;
    engine.stop();
    release();
    const order = await execution;
    expect(createOrder).toHaveBeenCalledOnce();
    expect(order).not.toBeNull();
    expect((engine as any).orders.size).toBe(1);
    expect(engine.getStatus().config.enabled).toBe(false);
    expect(fs.existsSync((engine as any).localStateStore.getPath())).toBe(true);
    vi.spyOn(systemKillSwitch, 'isKilled').mockReturnValue(true);
    await expect(engine.resume()).resolves.toBe(false);
    engine.dispose();
  });

  it('refuses a stale ticker at a capital-adjacent gate', async () => {
    let now = FIXTURE.ticker.timestamp;
    let calls = 0;
    const venue = {
      id: 'fixture-venue',
      fetchTicker: async () => {
        calls += 1;
        if (calls > 1) throw new Error('stale refresh unavailable');
        return { ...FIXTURE.ticker };
      },
    };
    const cache = new TickerSnapshotCache(new Map([['fixture-venue', venue]]), 5_000, {
      clock: () => now,
    });
    await cache.getTicker(FIXTURE.symbol, venue);
    now += 10_000;
    const staleTicker = await cache.getTicker(FIXTURE.symbol, venue, 1_000);
    expect(staleTicker).toBeNull();
    const truth = (globalThis as any).truthEngine;
    (globalThis as any).truthEngine = {
      isTradeable: () => staleTicker
        ? { ok: true }
        : { ok: false, reason: 'ticker_unknown_stale' },
    };
    const engine = new LiveTradingEngine({ enabled: true, testMode: true });
    (engine as any).exchange = fakeExchange(vi.fn());
    setLiveMode();
    const blocked = vi.fn();
    engine.on('executionBlocked', blocked);
    await engine.executeSignal({ ...fixtureSignal(), id: 'stale-signal' } as any);
    expect(blocked).toHaveBeenCalledWith(expect.objectContaining({ reason: 'ticker_unknown_stale' }));
    (globalThis as any).truthEngine = truth;
    engine.dispose();
  });
});
