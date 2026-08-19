import { describe, it, expect } from 'vitest';
import {
  reconcileByClientOrderId,
  isAmbiguousError,
  buildClientOrderId,
} from '../order-reconciler';

const CID = 'ss-abc123';

describe('isAmbiguousError', () => {
  it('treats network/timeout/5xx failures as ambiguous', () => {
    expect(isAmbiguousError(new Error('Request timeout'))).toBe(true);
    expect(isAmbiguousError(new Error('socket hang up'))).toBe(true);
    expect(isAmbiguousError({ code: 'ECONNRESET', message: 'reset' })).toBe(true);
    expect(isAmbiguousError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isAmbiguousError(new Error('Service Unavailable'))).toBe(true);
  });

  it('treats deterministic rejections as unambiguous', () => {
    expect(isAmbiguousError(new Error('Insufficient balance'))).toBe(false);
    expect(isAmbiguousError(new Error('Invalid symbol'))).toBe(false);
    expect(isAmbiguousError(null)).toBe(false);
  });
});

describe('reconcileByClientOrderId', () => {
  it('finds an order that reached the exchange', async () => {
    const exchange = {
      fetchOpenOrders: async () => [{ id: '1', clientOrderId: CID, status: 'open' }],
      fetchClosedOrders: async () => [],
      fetchMyTrades: async () => [],
    };
    const result = await reconcileByClientOrderId(exchange, 'BTC/USDT', CID);
    expect(result.state).toBe('exists');
    expect(result.order.id).toBe('1');
  });

  it('matches exchange-specific client id fields', async () => {
    const shapes = [
      { info: { clientOid: CID } },
      { info: { origClientOrderId: CID } },
      { info: { client_order_id: CID } },
    ];
    for (const row of shapes) {
      const exchange = {
        fetchOpenOrders: async () => [row],
        fetchClosedOrders: async () => [],
        fetchMyTrades: async () => [],
      };
      const result = await reconcileByClientOrderId(exchange, 'BTC/USDT', CID);
      expect(result.state).toBe('exists');
    }
  });

  it('reports absent only when every available lookup answered', async () => {
    const exchange = {
      fetchOpenOrders: async () => [],
      fetchClosedOrders: async () => [{ clientOrderId: 'other' }],
      fetchMyTrades: async () => [],
    };
    const result = await reconcileByClientOrderId(exchange, 'BTC/USDT', CID);
    expect(result.state).toBe('absent');
    expect(result.checked).toContain('fetchClosedOrders');
  });

  it('reports unknown when a lookup fails, even if another says absent', async () => {
    const exchange = {
      fetchOpenOrders: async () => [],
      fetchClosedOrders: async () => {
        throw new Error('timeout');
      },
    };
    const result = await reconcileByClientOrderId(exchange, 'BTC/USDT', CID);
    expect(result.state).toBe('unknown');
    expect(result.errors.length).toBe(1);
  });

  it('reports unknown when no lookup is available', async () => {
    const result = await reconcileByClientOrderId({}, 'BTC/USDT', CID);
    expect(result.state).toBe('unknown');
  });

  it('reports unknown without an exchange or client id', async () => {
    expect((await reconcileByClientOrderId(null, 'BTC/USDT', CID)).state).toBe('unknown');
    expect((await reconcileByClientOrderId({ fetchOpenOrders: async () => [] }, 'BTC/USDT', '')).state).toBe('unknown');
  });
});

describe('buildClientOrderId', () => {
  it('produces exchange-safe ids within the length budget', () => {
    const id = buildClientOrderId('ss', 'BTC/USDT-correlation-id');
    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('stays unique even with a very long seed', () => {
    const seed = 'x'.repeat(200);
    const ids = new Set(Array.from({ length: 50 }, () => buildClientOrderId('ss', seed)));
    expect(ids.size).toBe(50);
  });
});
