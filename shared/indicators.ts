/**
 * indicators.ts
 *
 * Single source of truth for all technical indicator calculations.
 * Both MLPredictionService and AdvancedMLService import from here —
 * no more copy-pasted helpers that drift apart.
 */

export interface ChartDataPoint {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi?: number | null;
  macd?: number | null;
  ema?: number | null;
}

// ---------------------------------------------------------------------------
// Basic statistics
// ---------------------------------------------------------------------------

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Price-based features
// ---------------------------------------------------------------------------

/** Percentage return over `period` bars */
export function momentum(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;
  const past = prices[prices.length - 1 - period];
  if (past === 0) return 0;
  return (prices[prices.length - 1] - past) / past;
}

/** Log-return volatility (annualisation-free, just std of log returns) */
export function volatility(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;
  const window = prices.slice(-period - 1);
  const logReturns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] <= 0) continue;
    logReturns.push(Math.log(window[i] / window[i - 1]));
  }
  return standardDeviation(logReturns);
}

/** Z-score of current price relative to recent window */
export function meanReversion(prices: number[]): number {
  if (prices.length < 20) return 0;
  const m   = mean(prices);
  const std = standardDeviation(prices);
  return std === 0 ? 0 : (prices[prices.length - 1] - m) / std;
}

/**
 * Fraction of up-moves minus fraction of down-moves over last 10 bars.
 * Range: [-1, 1].
 */
export function trendStrength(prices: number[]): number {
  if (prices.length < 10) return 0;
  const recent = prices.slice(-10);
  let up = 0, down = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) up++;
    else if (recent[i] < recent[i - 1]) down++;
  }
  return (up - down) / (recent.length - 1);
}

/** Ordinary-least-squares slope normalised by the series mean */
export function linearTrend(values: number[], period: number): number {
  const recent = values.slice(-Math.min(period, values.length));
  if (recent.length < 2) return 0;
  const n    = recent.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = recent.reduce((a, b) => a + b, 0);
  const sumXY = recent.reduce((s, y, i) => s + i * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX ** 2;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const avg   = sumY / n;
  return avg === 0 ? 0 : slope / avg;
}

/** Average True Range */
export function atr(
  highs:  number[],
  lows:   number[],
  closes: number[],
  period: number
): number {
  const trs: number[] = [];
  const len = Math.min(period + 1, highs.length);
  for (let i = highs.length - len + 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    );
    trs.push(tr);
  }
  return trs.length === 0 ? 0 : mean(trs);
}

/** Rate-of-change: average of last `period` single-bar returns */
export function rateOfChange(prices: number[], period: number): number {
  const changes: number[] = [];
  for (let i = 1; i <= Math.min(period, prices.length - 1); i++) {
    const prev = prices[prices.length - i - 1];
    if (prev !== 0) changes.push((prices[prices.length - i] - prev) / prev);
  }
  return changes.length === 0 ? 0 : mean(changes);
}

/** Percentage change between two points in the series */
export function priceChange(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;
  const past = prices[prices.length - 1 - period];
  return past === 0 ? 0 : (prices[prices.length - 1] - past) / past;
}

// ---------------------------------------------------------------------------
// Volume-based features
// ---------------------------------------------------------------------------

/** Ratio of current volume to rolling average */
export function volumeRatio(volumes: number[]): number {
  if (volumes.length === 0) return 1;
  const avg = mean(volumes.slice(-20));
  return avg === 0 ? 1 : volumes[volumes.length - 1] / avg;
}

// ---------------------------------------------------------------------------
// More advanced indicators used across the codebase
// ---------------------------------------------------------------------------

/** Simple moving average (per-index array) */
export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] || 0;
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average */
export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      prev = v;
      out[i] = prev;
    } else {
      prev = (v - prev) * k + prev;
      out[i] = prev;
    }
  }
  return out;
}

/** MACD indicator: returns macd line, signal line, and histogram arrays */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const fastE = ema(values, fast);
  const slowE = ema(values, slow);
  const macdLine = values.map((_, i) => {
    const f = fastE[i];
    const s = slowE[i];
    return (Number.isFinite(f) && Number.isFinite(s)) ? f - s : NaN;
  });
  const signal = ema(macdLine.map(v => Number.isFinite(v) ? v : 0), signalPeriod);
  const histogram = macdLine.map((v, i) => (Number.isFinite(v) && Number.isFinite(signal[i])) ? v - signal[i] : NaN);
  return { macd: macdLine, signal, histogram };
}

/** RSI (Wilder) */
export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < 2) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= Math.min(period, values.length - 1); i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (period >= 1 && values.length > period) {
    let avgGain = gains / period;
    let avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
  }
  return out;
}

/** Bollinger Bands */
export function bollingerBands(values: number[], period = 20, mult = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(NaN);
  const lower = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const sd = standardDeviation(window.map(v => Math.log(v / (window[0] || 1))));
    const m = middle[i] || NaN;
    if (Number.isFinite(m)) {
      upper[i] = m + mult * sd * (m || 1);
      lower[i] = m - mult * sd * (m || 1);
    }
  }
  return { upper, middle, lower };
}

/** On-Balance Volume */
export function obv(close: number[], volume: number[]): number[] {
  const out: number[] = new Array(close.length).fill(0);
  let cum = 0;
  for (let i = 1; i < close.length; i++) {
    if (close[i] > close[i - 1]) cum += volume[i] || 0;
    else if (close[i] < close[i - 1]) cum -= volume[i] || 0;
    out[i] = cum;
  }
  return out;
}

/** Stochastic oscillator: returns { k: number[], d: number[] } */
export function stochastic(high: number[], low: number[], close: number[], kPeriod = 14, dPeriod = 3) {
  const k: number[] = new Array(close.length).fill(NaN);
  const d: number[] = new Array(close.length).fill(NaN);
  for (let i = kPeriod - 1; i < close.length; i++) {
    const hh = Math.max(...high.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...low.slice(i - kPeriod + 1, i + 1));
    k[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    // %D is sma of %K over dPeriod
    if (i >= kPeriod - 1 + dPeriod - 1) {
      const slice = k.slice(i - dPeriod + 1, i + 1).filter(Number.isFinite);
      d[i] = slice.length ? mean(slice) : NaN;
    }
  }
  return { k, d };
}

/** Commodity Channel Index */
export function cci(high: number[], low: number[], close: number[], period = 20) {
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  const smaTp = sma(tp, period);
  const out: number[] = new Array(close.length).fill(NaN);
  for (let i = period - 1; i < tp.length; i++) {
    const window = tp.slice(i - period + 1, i + 1);
    const md = mean(window.map(v => Math.abs(v - (smaTp[i] || 0))));
    out[i] = md === 0 ? 0 : (tp[i] - (smaTp[i] || 0)) / (0.015 * md);
  }
  return out;
}

/** Keltner Channels (EMA + ATR) */
export function keltnerChannels(high: number[], low: number[], close: number[], emaPeriod = 20, atrPeriod = 10, mult = 2) {
  const middle = ema(close, emaPeriod);
  const atrVals: number[] = new Array(close.length).fill(NaN);
  for (let i = 1; i < close.length; i++) {
    const tr = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    atrVals[i] = tr;
  }
  // smooth ATR simple
  const atrSmoothed = ema(atrVals.map(v => Number.isFinite(v) ? v : 0), atrPeriod);
  const upper = middle.map((m, i) => (Number.isFinite(m) && Number.isFinite(atrSmoothed[i])) ? m + mult * atrSmoothed[i] : NaN);
  const lower = middle.map((m, i) => (Number.isFinite(m) && Number.isFinite(atrSmoothed[i])) ? m - mult * atrSmoothed[i] : NaN);
  return { upper, lower, middle, atr: atrSmoothed };
}

/** Money Flow Index */
export function mfi(high: number[], low: number[], close: number[], volume: number[], period = 14) {
  const pmf: number[] = new Array(close.length).fill(NaN);
  const nmf: number[] = new Array(close.length).fill(NaN);
  const mfiOut: number[] = new Array(close.length).fill(NaN);
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  for (let i = 1; i < close.length; i++) {
    const raw = tp[i] * (volume[i] || 0);
    if (tp[i] > tp[i - 1]) pmf[i] = raw; else nmf[i] = raw;
  }
  for (let i = period; i < close.length; i++) {
    const pos = mean(pmf.slice(i - period + 1, i + 1).filter(Number.isFinite));
    const neg = mean(nmf.slice(i - period + 1, i + 1).filter(Number.isFinite));
    const ratio = neg === 0 ? 0 : pos / neg;
    mfiOut[i] = 100 - 100 / (1 + ratio);
  }
  return mfiOut;
}

/** Chaikin Money Flow */
export function cmf(high: number[], low: number[], close: number[], volume: number[], period = 20) {
  const mfv: number[] = new Array(close.length).fill(0);
  for (let i = 0; i < close.length; i++) {
    const denom = high[i] - low[i];
    const mfm = denom === 0 ? 0 : ((close[i] - low[i]) - (high[i] - close[i])) / denom;
    mfv[i] = mfm * (volume[i] || 0);
  }
  const cmfOut: number[] = new Array(close.length).fill(NaN);
  for (let i = period - 1; i < close.length; i++) {
    const num = mean(mfv.slice(i - period + 1, i + 1));
    const den = mean(volume.slice(i - period + 1, i + 1));
    cmfOut[i] = den === 0 ? 0 : num / den;
  }
  return cmfOut;
}

/** Ichimoku Clouds (basic) */
export function ichimoku(high: number[], low: number[], close: number[]) {
  const tenkan: number[] = new Array(close.length).fill(NaN);
  const kijun: number[] = new Array(close.length).fill(NaN);
  const senkouA: number[] = new Array(close.length).fill(NaN);
  const senkouB: number[] = new Array(close.length).fill(NaN);
  const chikou: number[] = new Array(close.length).fill(NaN);
  for (let i = 8; i < close.length; i++) {
    const high9 = Math.max(...high.slice(i - 8, i + 1));
    const low9 = Math.min(...low.slice(i - 8, i + 1));
    tenkan[i] = (high9 + low9) / 2;
  }
  for (let i = 25; i < close.length; i++) {
    const high26 = Math.max(...high.slice(i - 25, i + 1));
    const low26 = Math.min(...low.slice(i - 25, i + 1));
    kijun[i] = (high26 + low26) / 2;
    if (tenkan[i] && kijun[i]) senkouA[i + 26] = (tenkan[i] + kijun[i]) / 2;
    const high52 = Math.max(...high.slice(i - 51, i + 1));
    const low52 = Math.min(...low.slice(i - 51, i + 1));
    senkouB[i + 26] = (high52 + low52) / 2;
  }
  for (let i = 0; i < close.length; i++) chikou[i] = close[i - 26] ?? NaN;
  return { tenkan, kijun, senkouA, senkouB, chikou };
}

/** ADX (approximate) */
export function adx(high: number[], low: number[], close: number[], period = 14) {
  const plusDM: number[] = new Array(close.length).fill(0);
  const minusDM: number[] = new Array(close.length).fill(0);
  const tr: number[] = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const upMove = high[i] - high[i - 1];
    const downMove = low[i - 1] - low[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  const plusDI = ema(plusDM.map(v => Number.isFinite(v) ? v : 0), period).map((v, i) => (v && tr[i]) ? (v / tr[i]) * 100 : NaN);
  const minusDI = ema(minusDM.map(v => Number.isFinite(v) ? v : 0), period).map((v, i) => (v && tr[i]) ? (v / tr[i]) * 100 : NaN);
  const dx = plusDI.map((p, i) => (Number.isFinite(p) && Number.isFinite(minusDI[i]) && (p + minusDI[i]) !== 0) ? (Math.abs(p - minusDI[i]) / (p + minusDI[i])) * 100 : NaN);
  const adxOut = ema(dx.map(v => Number.isFinite(v) ? v : 0), period);
  return adxOut;
}

/** Parabolic SAR (very simple fallback implementation)
 * Note: This is a simplified version and may differ from production-grade SAR.
 */
export function parabolicSAR(high: number[], low: number[], close: number[], step = 0.02, max = 0.2) {
  const out: number[] = new Array(close.length).fill(NaN);
  if (close.length === 0) return out;
  let sar = close[0];
  let ep = close[0];
  let af = step;
  let up = true;
  out[0] = sar;
  for (let i = 1; i < close.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      if (low[i] < sar) {
        up = false; sar = ep; ep = low[i]; af = step;
      } else {
        if (high[i] > ep) { ep = high[i]; af = Math.min(max, af + step); }
      }
    } else {
      if (high[i] > sar) {
        up = true; sar = ep; ep = high[i]; af = step;
      } else {
        if (low[i] < ep) { ep = low[i]; af = Math.min(max, af + step); }
      }
    }
    out[i] = sar;
  }
  return out;
}