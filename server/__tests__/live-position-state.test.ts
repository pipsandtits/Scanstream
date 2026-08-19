import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LiveTradingEngine } from '../live-trading-engine';

/**
 * Position state is what every hard risk limit is computed from, so it must not
 * duplicate, must not silently forget exposure, and must reflect the exchange.
 */

function attach(engine: LiveTradingEngine, fetchPositions: () => any): void {
  (engine as unknown as { exchange: unknown }).exchange = { fetchPositions };
}

async function refresh(engine: LiveTradingEngine): Promise<void> {
  await (engine as unknown as { updatePositions(): Promise<void> }).updatePositions();
}

function positions(engine: LiveTradingEngine): any[] {
  return Array.from((engine as unknown as { positions: Map<string, any> }).positions.values());
}

function totalExposure(engine: LiveTradingEngine): number {
  return (engine as unknown as { getTotalExposure(): number }).getTotalExposure();
}

function exchangePosition(over: Record<string, unknown> = {}) {
  return {
    symbol: 'BTC/USDT',
    contracts: 0.5,
    side: 'long',
    entryPrice: 60_000,
    markPrice: 60_500,
    leverage: 10,
    initialMargin: 3_025,
    unrealizedPnl: 250,
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe('authoritative position state', () => {
  let engine: LiveTradingEngine;

  beforeEach(() => {
    engine = new LiveTradingEngine({ enabled: true, testMode: true });
  });

  afterEach(() => {
    engine.dispose();
    vi.restoreAllMocks();
  });

  it('keeps one position per symbol across repeated refreshes', async () => {
    let timestamp = 1_700_000_000_000;
    attach(engine, async () => [exchangePosition({ timestamp: (timestamp += 5_000) })]);

    await refresh(engine);
    await refresh(engine);
    await refresh(engine);

    expect(positions(engine)).toHaveLength(1);
  });

  it('measures exposure as notional rather than margin', async () => {
    attach(engine, async () => [exchangePosition()]);
    await refresh(engine);

    // 0.5 @ 60,500 = 30,250 notional, not the 3,025 of posted margin.
    expect(totalExposure(engine)).toBeCloseTo(30_250, 6);
  });

  it('drops a position the exchange explicitly reports as flat', async () => {
    let flat = false;
    const closedExternally = vi.fn();
    engine.on('positionClosedExternally', closedExternally);
    attach(engine, async () => [flat ? exchangePosition({ contracts: 0 }) : exchangePosition()]);

    await refresh(engine);
    expect(positions(engine)).toHaveLength(1);

    flat = true;
    await refresh(engine);

    expect(positions(engine)).toHaveLength(0);
    expect(closedExternally).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USDT' }));
  });

  it('does not treat a position merely missing from the response as closed', async () => {
    let complete = true;
    const unconfirmed = vi.fn();
    engine.on('positionUnconfirmed', unconfirmed);
    attach(engine, async () => (complete ? [exchangePosition()] : []));

    await refresh(engine);
    complete = false;
    await refresh(engine);

    expect(positions(engine)).toHaveLength(1);
    expect(totalExposure(engine)).toBeGreaterThan(0);
    expect(unconfirmed).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTC/USDT' }));
  });

  it('keeps the local view and reports failure when the exchange query fails', async () => {
    const failed = vi.fn();
    engine.on('positionRefreshFailed', failed);
    attach(engine, async () => [exchangePosition()]);
    await refresh(engine);

    attach(engine, async () => {
      throw new Error('exchange down');
    });
    await refresh(engine);

    expect(positions(engine)).toHaveLength(1);
    expect(failed).toHaveBeenCalled();
  });

  it('ignores an unusable response instead of assuming flat', async () => {
    attach(engine, async () => [exchangePosition()]);
    await refresh(engine);

    attach(engine, async () => null);
    await refresh(engine);

    expect(positions(engine)).toHaveLength(1);
  });

  it('preserves locally known stop-loss and open time across refreshes', async () => {
    attach(engine, async () => [exchangePosition()]);
    await refresh(engine);

    const position = positions(engine)[0];
    position.stopLoss = 58_000;
    const openTime = position.openTime;

    attach(engine, async () => [exchangePosition({ timestamp: 1_700_000_999_999, markPrice: 61_000 })]);
    await refresh(engine);

    const updated = positions(engine)[0];
    expect(updated.stopLoss).toBe(58_000);
    expect(updated.openTime).toBe(openTime);
    expect(updated.currentPrice).toBe(61_000);
  });

  it('counts per-symbol exposure separately from total exposure', async () => {
    attach(engine, async () => [
      exchangePosition(),
      exchangePosition({ symbol: 'ETH/USDT', contracts: 10, entryPrice: 3_000, markPrice: 3_100, initialMargin: 3_100 }),
    ]);
    await refresh(engine);

    const symbolExposure = (engine as unknown as { getSymbolExposure(s: string): number }).getSymbolExposure(
      'ETH/USDT'
    );
    expect(symbolExposure).toBeCloseTo(31_000, 6);
    expect(totalExposure(engine)).toBeCloseTo(61_250, 6);
  });
});
