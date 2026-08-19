/**
 * Canonical OHLCV normalization and validation.
 *
 * Exchange rows arrive as raw tuples. Prices must keep full decimal precision
 * (flooring a $0.1543 price to $0 destroys every downstream calculation), and
 * structurally impossible rows must be rejected rather than repaired.
 */

export interface NormalizedOhlcv {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RejectedOhlcv {
  reason: OhlcvRejectReason;
  row: unknown;
}

export type OhlcvRejectReason =
  | 'malformed_row'
  | 'invalid_timestamp'
  | 'non_finite_price'
  | 'non_positive_price'
  | 'negative_volume'
  | 'high_below_low'
  | 'high_below_open_close'
  | 'low_above_open_close';

/** Timeframes CCXT/exchanges express directly; anything else is ambiguous. */
const TIMEFRAME_BY_SECONDS: Record<number, string> = {
  60: '1m',
  180: '3m',
  300: '5m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  7200: '2h',
  14400: '4h',
  21600: '6h',
  28800: '8h',
  43200: '12h',
  86400: '1d',
  259200: '3d',
  604800: '1w',
};

/**
 * Convert seconds to an exchange timeframe string.
 * Throws on unsupported values instead of silently rounding (90m -> '2h').
 */
export function secondsToCcxtTimeframe(seconds: number): string {
  const tf = TIMEFRAME_BY_SECONDS[seconds];
  if (!tf) {
    throw new Error(
      `Unsupported timeframe: ${seconds}s. Supported: ${Object.keys(TIMEFRAME_BY_SECONDS).join(', ')}`
    );
  }
  return tf;
}

export function isSupportedTimeframeSeconds(seconds: number): boolean {
  return Boolean(TIMEFRAME_BY_SECONDS[seconds]);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Normalize a single OHLCV row, preserving decimal precision.
 * Returns a reject reason instead of a candle when the row is not usable.
 */
export function normalizeOhlcvRow(row: unknown): NormalizedOhlcv | RejectedOhlcv {
  if (!Array.isArray(row) || row.length < 6) {
    return { reason: 'malformed_row', row };
  }

  const tsRaw = toNumber(row[0]);
  const open = toNumber(row[1]);
  const high = toNumber(row[2]);
  const low = toNumber(row[3]);
  const close = toNumber(row[4]);
  const volume = toNumber(row[5]);

  // Timestamps are integer milliseconds; truncation here is correct.
  if (!Number.isFinite(tsRaw) || tsRaw <= 0) return { reason: 'invalid_timestamp', row };
  const ts = Math.floor(tsRaw);

  for (const price of [open, high, low, close]) {
    if (!Number.isFinite(price)) return { reason: 'non_finite_price', row };
    if (price <= 0) return { reason: 'non_positive_price', row };
  }

  if (!Number.isFinite(volume) || volume < 0) return { reason: 'negative_volume', row };

  if (high < low) return { reason: 'high_below_low', row };
  if (high < open || high < close) return { reason: 'high_below_open_close', row };
  if (low > open || low > close) return { reason: 'low_above_open_close', row };

  return { ts, open, high, low, close, volume };
}

export function isRejected(result: NormalizedOhlcv | RejectedOhlcv): result is RejectedOhlcv {
  return (result as RejectedOhlcv).reason !== undefined;
}

export interface NormalizeBatchResult {
  candles: NormalizedOhlcv[];
  rejected: RejectedOhlcv[];
}

/** Normalize a batch, dropping (and reporting) unusable rows. */
export function normalizeOhlcvBatch(rows: unknown[]): NormalizeBatchResult {
  const candles: NormalizedOhlcv[] = [];
  const rejected: RejectedOhlcv[] = [];

  for (const row of rows || []) {
    const result = normalizeOhlcvRow(row);
    if (isRejected(result)) rejected.push(result);
    else candles.push(result);
  }

  return { candles, rejected };
}
