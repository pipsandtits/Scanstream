import { describe, it, expect } from 'vitest';
import {
  normalizeOhlcvRow,
  isRejected,
  secondsToCcxtTimeframe,
} from '../candle-normalizer';

function ok(row: unknown) {
  const result = normalizeOhlcvRow(row);
  if (isRejected(result)) throw new Error(`expected accepted row, got ${result.reason}`);
  return result;
}

function reason(row: unknown): string {
  const result = normalizeOhlcvRow(row);
  if (!isRejected(result)) throw new Error('expected rejection');
  return result.reason;
}

describe('normalizeOhlcvRow precision', () => {
  it('preserves BTC-like prices exactly', () => {
    const c = ok([1700000000000, 67432.15, 67891.42, 67210.03, 67555.78, 1234.5678]);
    expect(c.open).toBe(67432.15);
    expect(c.high).toBe(67891.42);
    expect(c.low).toBe(67210.03);
    expect(c.close).toBe(67555.78);
    expect(c.volume).toBe(1234.5678);
  });

  it('preserves ETH-like prices exactly', () => {
    const c = ok([1700000000000, 3421.67, 3450.01, 3399.99, 3444.44, 88.125]);
    expect(c.close).toBe(3444.44);
    expect(c.low).toBe(3399.99);
  });

  it('preserves sub-cent prices that flooring would zero out', () => {
    const c = ok([1700000000000, 0.00001234, 0.00001299, 0.00001201, 0.00001250, 9_000_000]);
    expect(c.open).toBe(0.00001234);
    expect(c.close).toBe(0.00001250);
    expect(c.low).toBeGreaterThan(0);
  });

  it('keeps small movements distinguishable', () => {
    const a = ok([1700000000000, 100.01, 100.02, 100.0, 100.01, 1]);
    const b = ok([1700000060000, 100.01, 100.03, 100.0, 100.02, 1]);
    expect(b.close - a.close).toBeCloseTo(0.01, 10);
  });

  it('keeps stop-loss / take-profit arithmetic accurate', () => {
    const c = ok([1700000000000, 67432.15, 67891.42, 67210.03, 67555.78, 10]);
    const stop = c.close * 0.98;
    const target = c.close * 1.03;
    expect(stop).toBeCloseTo(66204.6644, 4);
    expect(target).toBeCloseTo(69582.4534, 4);
  });

  it('parses numeric strings from exchanges that return strings', () => {
    const c = ok([1700000000000, '67432.15', '67891.42', '67210.03', '67555.78', '12.5']);
    expect(c.open).toBe(67432.15);
    expect(c.volume).toBe(12.5);
  });

  it('floors only the timestamp', () => {
    const c = ok([1700000000000.7, 10.5, 11.5, 9.5, 10.75, 1.5]);
    expect(c.ts).toBe(1700000000000);
    expect(c.close).toBe(10.75);
  });
});

describe('normalizeOhlcvRow rejection', () => {
  it('rejects malformed rows', () => {
    expect(reason(null)).toBe('malformed_row');
    expect(reason([1, 2, 3])).toBe('malformed_row');
    expect(reason({ ts: 1 })).toBe('malformed_row');
  });

  it('rejects invalid timestamps', () => {
    expect(reason([0, 1, 2, 0.5, 1.5, 1])).toBe('invalid_timestamp');
    expect(reason([-5, 1, 2, 0.5, 1.5, 1])).toBe('invalid_timestamp');
    expect(reason(['not-a-date', 1, 2, 0.5, 1.5, 1])).toBe('invalid_timestamp');
  });

  it('rejects non-finite and non-positive prices', () => {
    expect(reason([1700000000000, NaN, 2, 0.5, 1.5, 1])).toBe('non_finite_price');
    expect(reason([1700000000000, Infinity, 2, 0.5, 1.5, 1])).toBe('non_finite_price');
    expect(reason([1700000000000, 0, 2, 0.5, 1.5, 1])).toBe('non_positive_price');
    expect(reason([1700000000000, -1, 2, 0.5, 1.5, 1])).toBe('non_positive_price');
  });

  it('rejects negative volume', () => {
    expect(reason([1700000000000, 1, 2, 0.5, 1.5, -1])).toBe('negative_volume');
  });

  it('rejects impossible OHLC relationships', () => {
    expect(reason([1700000000000, 10, 9, 11, 10, 1])).toBe('high_below_low');
    expect(reason([1700000000000, 12, 11, 10, 10.5, 1])).toBe('high_below_open_close');
    expect(reason([1700000000000, 10, 12, 10.5, 10.2, 1])).toBe('low_above_open_close');
  });

  it('accepts a flat candle where OHLC are all equal', () => {
    const c = ok([1700000000000, 5.5, 5.5, 5.5, 5.5, 0]);
    expect(c.volume).toBe(0);
  });
});

describe('secondsToCcxtTimeframe', () => {
  it('maps supported timeframes', () => {
    expect(secondsToCcxtTimeframe(60)).toBe('1m');
    expect(secondsToCcxtTimeframe(300)).toBe('5m');
    expect(secondsToCcxtTimeframe(900)).toBe('15m');
    expect(secondsToCcxtTimeframe(3600)).toBe('1h');
    expect(secondsToCcxtTimeframe(14400)).toBe('4h');
    expect(secondsToCcxtTimeframe(86400)).toBe('1d');
  });

  it('throws instead of silently rounding an unsupported timeframe', () => {
    // 90 minutes previously became "2h", producing candles of the wrong period.
    expect(() => secondsToCcxtTimeframe(5400)).toThrow();
    expect(() => secondsToCcxtTimeframe(37)).toThrow();
  });
});
