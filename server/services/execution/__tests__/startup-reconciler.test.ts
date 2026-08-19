import { describe, it, expect } from 'vitest';
import { reconcileAtStartup, type ReconcilerExchange } from '../startup-reconciler';

function exchange(over: Partial<ReconcilerExchange> = {}): ReconcilerExchange {
  return {
    fetchBalance: async () => ({ total: { USDT: 10_000 } }),
    fetchPositions: async () => [],
    fetchOpenOrders: async () => [],
    ...over,
  };
}

function position(over: Record<string, unknown> = {}) {
  return {
    symbol: 'BTC/USDT',
    contracts: 0.5,
    side: 'long',
    entryPrice: 60_000,
    markPrice: 60_500,
    leverage: 5,
    initialMargin: 6_050,
    unrealizedPnl: 250,
    ...over,
  };
}

function openOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'x1',
    clientOrderId: 'ss-abc',
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: 1,
    filled: 0,
    status: 'open',
    ...over,
  };
}

const kinds = (r: Awaited<ReturnType<typeof reconcileAtStartup>>) => r.discrepancies.map((d) => d.kind);

describe('startup reconciliation', () => {
  it('completes when exchange and local state agree and both are empty', async () => {
    const report = await reconcileAtStartup({ exchange: exchange(), localOrders: [], localPositions: [] });
    expect(report.complete).toBe(true);
    expect(report.discrepancies).toEqual([]);
  });

  it('completes when a known position matches the exchange', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchPositions: async () => [position()] }),
      localOrders: [],
      localPositions: [{ id: 'BTC/USDT', symbol: 'BTC/USDT', quantity: 0.5 }],
    });

    expect(report.complete).toBe(true);
    expect(report.positions).toHaveLength(1);
    expect(report.positions[0].knownLocally).toBe(true);
  });

  it('adopts an exchange position we did not know about without blocking', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchPositions: async () => [position()] }),
      localOrders: [],
      localPositions: [],
    });

    expect(kinds(report)).toContain('position_unknown_locally');
    expect(report.positions[0].knownLocally).toBe(false);
    expect(report.complete).toBe(true);
  });

  it('blocks when a local position is absent from the exchange response', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange(),
      localOrders: [],
      localPositions: [{ id: 'p1', symbol: 'ETH/USDT', quantity: 2 }],
    });

    expect(report.complete).toBe(false);
    expect(kinds(report)).toContain('position_missing_on_exchange');
  });

  it('blocks on an open exchange order we have no record of', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchOpenOrders: async () => [openOrder()] }),
      localOrders: [],
      localPositions: [],
    });

    expect(report.complete).toBe(false);
    expect(kinds(report)).toContain('order_unknown_locally');
  });

  it('blocks when an order we think is open is no longer open on the exchange', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange(),
      localOrders: [
        { id: 'o1', exchangeOrderId: 'x1', symbol: 'BTC/USDT', amount: 1, filled: 0, status: 'open' },
      ],
      localPositions: [],
    });

    expect(report.complete).toBe(false);
    expect(kinds(report)).toContain('order_terminal_on_exchange');
  });

  it('adopts a partial fill that happened while the process was down', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchOpenOrders: async () => [openOrder({ filled: 0.4 })] }),
      localOrders: [
        { id: 'o1', exchangeOrderId: 'x1', symbol: 'BTC/USDT', amount: 1, filled: 0, status: 'open' },
      ],
      localPositions: [],
    });

    expect(kinds(report)).toContain('order_partially_filled');
    expect(report.orders[0].filled).toBe(0.4);
    expect(report.orders[0].remaining).toBeCloseTo(0.6, 12);
    expect(report.complete).toBe(true);
  });

  it('matches an order by client order id when the exchange id was never persisted', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchOpenOrders: async () => [openOrder()] }),
      localOrders: [
        {
          id: 'o1',
          exchangeOrderId: null,
          clientOrderId: 'ss-abc',
          symbol: 'BTC/USDT',
          amount: 1,
          filled: 0,
          status: 'open',
        },
      ],
      localPositions: [],
    });

    expect(report.complete).toBe(true);
    expect(report.orders[0].knownLocally).toBe(true);
  });

  it('fails closed when a balance query fails', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({
        fetchBalance: async () => {
          throw new Error('nonce too low');
        },
      }),
      localOrders: [],
      localPositions: [],
    });

    expect(report.complete).toBe(false);
    expect(report.balancesAvailable).toBe(false);
    expect(kinds(report)).toContain('query_failed');
  });

  it('fails closed when the position query times out', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({
        fetchPositions: async () => {
          throw new Error('ETIMEDOUT');
        },
      }),
      localOrders: [],
      localPositions: [],
    });

    expect(report.complete).toBe(false);
    expect(report.blockedReason).toContain('query_failed');
  });

  it('fails closed on a partial/unusable exchange response', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchOpenOrders: async () => ({ error: 'maintenance' }) as any }),
      localOrders: [],
      localPositions: [],
    });

    expect(report.complete).toBe(false);
    expect(kinds(report)).toContain('unusable_response');
  });

  it('fails closed on entries missing identifiers rather than skipping them silently', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({
        fetchPositions: async () => [{ contracts: 1 }],
        fetchOpenOrders: async () => [{ symbol: 'BTC/USDT', amount: 1 }],
      }),
      localOrders: [],
      localPositions: [],
    });

    expect(report.complete).toBe(false);
    expect(kinds(report).filter((k) => k === 'unusable_response')).toHaveLength(2);
  });

  it('fails closed when there is no exchange connection at all', async () => {
    const report = await reconcileAtStartup({ exchange: null, localOrders: [], localPositions: [] });
    expect(report.complete).toBe(false);
    expect(report.blockedReason).toBe('exchange_unavailable');
  });

  it('is idempotent: running twice yields the same reconciled state', async () => {
    const input = {
      exchange: exchange({
        fetchPositions: async () => [position()],
        fetchOpenOrders: async () => [openOrder({ filled: 0.2 })],
      }),
      localOrders: [
        { id: 'o1', exchangeOrderId: 'x1', symbol: 'BTC/USDT', amount: 1, filled: 0.2, status: 'open' },
      ],
      localPositions: [{ id: 'BTC/USDT', symbol: 'BTC/USDT', quantity: 0.5 }],
      now: () => 1_000,
    };

    const first = await reconcileAtStartup(input);
    const second = await reconcileAtStartup(input);

    expect(second).toEqual(first);
    expect(second.positions).toHaveLength(1);
    expect(second.orders).toHaveLength(1);
  });

  it('ignores flat position entries instead of counting them as exposure', async () => {
    const report = await reconcileAtStartup({
      exchange: exchange({ fetchPositions: async () => [position({ contracts: 0 })] }),
      localOrders: [],
      localPositions: [],
    });

    expect(report.positions).toEqual([]);
    expect(report.complete).toBe(true);
  });
});
