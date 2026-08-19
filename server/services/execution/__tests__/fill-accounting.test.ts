import { describe, it, expect } from 'vitest';
import {
  applyFills,
  classifyOutcome,
  computeSlippagePct,
  createFillAccount,
  realizedPnl,
  type ExchangeFill,
} from '../fill-accounting';

function fill(partial: Partial<ExchangeFill> & { id: string }): ExchangeFill {
  return { amount: 1, price: 100, ...partial };
}

describe('fill accounting', () => {
  it('accumulates a single full fill', () => {
    const { account, applied } = applyFills(createFillAccount(), [fill({ id: 't1', amount: 0.5, price: 60_000 })], 0.5);
    expect(applied).toBe(1);
    expect(account.filled).toBe(0.5);
    expect(account.cost).toBe(30_000);
    expect(account.avgPrice).toBe(60_000);
    expect(account.remaining).toBe(0);
  });

  it('computes a volume-weighted average across multiple partial fills', () => {
    const { account } = applyFills(
      createFillAccount(),
      [
        fill({ id: 't1', amount: 0.25, price: 60_000 }),
        fill({ id: 't2', amount: 0.75, price: 61_000 }),
      ],
      1
    );
    expect(account.filled).toBe(1);
    expect(account.avgPrice).toBeCloseTo(60_750, 6);
  });

  it('does not report cost as a price for sub-unit quantities', () => {
    // Regression: `cost / max(1, filled)` returned 600 instead of 60000 here.
    const { account } = applyFills(createFillAccount(), [fill({ id: 't1', amount: 0.01, price: 60_000 })], 0.01);
    expect(account.avgPrice).toBe(60_000);
  });

  it('tracks remaining quantity on a partial fill', () => {
    const { account } = applyFills(createFillAccount(), [fill({ id: 't1', amount: 0.3, price: 100 })], 1);
    expect(account.remaining).toBeCloseTo(0.7, 12);
  });

  it('is idempotent for duplicate fill ids', () => {
    const first = applyFills(createFillAccount(), [fill({ id: 't1', amount: 1, price: 100 })], 2);
    const second = applyFills(first.account, [fill({ id: 't1', amount: 1, price: 100 })], 2);

    expect(second.applied).toBe(0);
    expect(second.rejected[0].reason).toBe('duplicate');
    expect(second.account.filled).toBe(1);
    expect(second.account.cost).toBe(100);
  });

  it('produces the same state regardless of fill arrival order', () => {
    const a = fill({ id: 't1', amount: 0.4, price: 100, timestamp: 2_000 });
    const b = fill({ id: 't2', amount: 0.6, price: 110, timestamp: 1_000 });

    const forward = applyFills(createFillAccount(), [a, b], 1).account;
    const reverse = applyFills(createFillAccount(), [b, a], 1).account;

    expect(forward.filled).toBe(reverse.filled);
    expect(forward.cost).toBeCloseTo(reverse.cost, 12);
    expect(forward.avgPrice).toBeCloseTo(reverse.avgPrice!, 12);
    expect(forward.lastFillAt).toBe(2_000);
    expect(reverse.lastFillAt).toBe(2_000);
  });

  it('applies a late fill on top of existing state without double counting', () => {
    const initial = applyFills(createFillAccount(), [fill({ id: 't1', amount: 0.5, price: 100 })], 1).account;
    const late = applyFills(initial, [fill({ id: 't1' }), fill({ id: 't2', amount: 0.5, price: 120 })], 1);

    expect(late.applied).toBe(1);
    expect(late.account.filled).toBe(1);
    expect(late.account.avgPrice).toBeCloseTo(110, 12);
    expect(late.account.remaining).toBe(0);
  });

  it('keeps fees separated by currency instead of summing them', () => {
    const { account } = applyFills(
      createFillAccount(),
      [
        fill({ id: 't1', fee: { cost: 0.1, currency: 'USDT' } }),
        fill({ id: 't2', fee: { cost: '0.2', currency: 'usdt' } }),
        fill({ id: 't3', fee: { cost: 0.001, currency: 'BNB' } }),
      ],
      3
    );

    expect(account.fees).toEqual([
      { currency: 'USDT', cost: 0.30000000000000004 },
      { currency: 'BNB', cost: 0.001 },
    ]);
  });

  it('splits maker and taker volume', () => {
    const { account } = applyFills(
      createFillAccount(),
      [fill({ id: 't1', amount: 1, takerOrMaker: 'maker' }), fill({ id: 't2', amount: 2, takerOrMaker: 'taker' })],
      3
    );
    expect(account.makerFilled).toBe(1);
    expect(account.takerFilled).toBe(2);
  });

  it('rejects unusable fills instead of counting them as zero', () => {
    const { account, rejected } = applyFills(
      createFillAccount(),
      [
        { id: '', amount: 1, price: 100 },
        fill({ id: 't1', amount: 0 }),
        fill({ id: 't2', price: Number.NaN }),
      ],
      1
    );

    expect(account.filled).toBe(0);
    expect(account.avgPrice).toBeNull();
    expect(rejected.map((r) => r.reason)).toEqual(['missing_id', 'invalid_amount', 'invalid_price']);
  });

  it('derives cost when the exchange omits it and trusts it when present', () => {
    const derived = applyFills(createFillAccount(), [fill({ id: 't1', amount: 2, price: 50 })], 2).account;
    expect(derived.cost).toBe(100);

    const reported = applyFills(createFillAccount(), [fill({ id: 't2', amount: 2, price: 50, cost: 101 })], 2).account;
    expect(reported.cost).toBe(101);
  });
});

describe('slippage', () => {
  it('reports a buy executed above the requested price as positive slippage', () => {
    expect(computeSlippagePct(100, 101, 'buy')).toBeCloseTo(1, 12);
  });

  it('reports a sell executed below the requested price as positive slippage', () => {
    expect(computeSlippagePct(100, 99, 'sell')).toBeCloseTo(1, 12);
  });

  it('returns null rather than 0 when it cannot be computed', () => {
    expect(computeSlippagePct(null, 100, 'buy')).toBeNull();
    expect(computeSlippagePct(100, null, 'buy')).toBeNull();
    expect(computeSlippagePct(0, 100, 'buy')).toBeNull();
  });
});

describe('realized pnl', () => {
  it('subtracts quote-currency fees from a long', () => {
    const r = realizedPnl({
      side: 'long',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 2,
      fees: [{ currency: 'USDT', cost: 3 }],
      quoteCurrency: 'USDT',
    });
    expect(r.gross).toBe(20);
    expect(r.net).toBe(17);
    expect(r.unconvertedFees).toEqual([]);
  });

  it('profits on a short when price falls', () => {
    const r = realizedPnl({
      side: 'short',
      entryPrice: 100,
      exitPrice: 90,
      quantity: 1,
      fees: [],
      quoteCurrency: 'USDT',
    });
    expect(r.net).toBe(10);
  });

  it('does not invent a conversion rate for non-quote fees', () => {
    const r = realizedPnl({
      side: 'long',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 1,
      fees: [{ currency: 'BNB', cost: 0.01 }],
      quoteCurrency: 'USDT',
    });
    expect(r.net).toBe(10);
    expect(r.unconvertedFees).toEqual([{ currency: 'BNB', cost: 0.01 }]);
  });
});

describe('order outcome classification', () => {
  const acct = (filled: number, requested: number) =>
    applyFills(createFillAccount(), filled > 0 ? [fill({ id: 'f', amount: filled, price: 100 })] : [], requested)
      .account;

  it('separates a clean cancel from a cancel that left exposure', () => {
    expect(classifyOutcome('canceled', acct(0, 1), 1)).toBe('canceled_unfilled');
    expect(classifyOutcome('canceled', acct(0.4, 1), 1)).toBe('canceled_partially_filled');
  });

  it('classifies filled and partially filled orders', () => {
    expect(classifyOutcome('closed', acct(1, 1), 1)).toBe('filled');
    expect(classifyOutcome('open', acct(0.4, 1), 1)).toBe('partially_filled');
    expect(classifyOutcome('open', acct(0, 1), 1)).toBe('unfilled');
  });

  it('tolerates exchange dust residuals on a complete fill', () => {
    const account = applyFills(createFillAccount(), [fill({ id: 'f', amount: 1 - 1e-12, price: 100 })], 1).account;
    expect(classifyOutcome('open', account, 1)).toBe('filled');
  });
});
