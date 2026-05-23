/**
 * advanced-ml-service.ts
 *
 * Fixes vs. original:
 *  1. ChartDataPoint is imported from indicators.ts — no more duplicate definition.
 *  2. All helper methods removed — imported from indicators.ts instead.
 *  3. Breakout probabilities are modelled as a single softmax over three classes
 *     (up / neutral / down) so they always sum to 1 and can never both be 1.0.
 *  4. Order flow: division by zero on doji candles (high === low) is guarded.
 *  5. allModelsConfidence only averages values that are provably in [0, 1].
 *  6. liquiditySqueeze timeToRelease logic is corrected: longer compression → sooner release.
 *  7. Market regime, breakout, and liquidity-squeeze detectors each have a real
 *     online-learning classifier (SGD softmax / logistic regression) that learns
 *     from labelled history and accepts new examples via train().
 *  8. generateAdvancedPredictions is an instance method so classifiers are accessible.
 *  9. Classifiers serialise to plain arrays and can be saved/loaded externally.
 */

import {
  ChartDataPoint,
  mean,
  standardDeviation,
  clamp,
  momentum,
  volatility,
  trendStrength,
  linearTrend,
  volumeRatio,
} from '@shared/indicators';

export type { ChartDataPoint };

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type MarketRegimeLabel = 'trending_up' | 'trending_down' | 'ranging' | 'volatile' | 'breakout';
export type BreakoutDirection = 'up' | 'neutral' | 'down';
export type LiquidityLevel    = 'none' | 'low' | 'medium' | 'high' | 'extreme';

export interface AdvancedMLPredictions {
  marketRegime: {
    regime:          MarketRegimeLabel;
    confidence:      number;
    strength:        number;
    characteristics: string[];
  };
  breakoutProbability: {
    upward:       number;    // P(break up)    — always in [0,1], sums with others to 1
    neutral:      number;    // P(no breakout) — FIX 3
    downward:     number;    // P(break down)
    direction:    BreakoutDirection;
    timeframe:    string;
    triggerPrice: number;
  };
  orderFlowImbalance: {
    buyPressure:   number;   // % of volume weighted to buyers
    sellPressure:  number;
    netImbalance:  number;   // buyPressure − sellPressure, in [-100, 100]
    dominantSide:  'buyers' | 'sellers' | 'balanced';
    strength:      number;   // |netImbalance| / 100
  };
  multiTimeframeMomentum: {
    shortTerm:  number;
    mediumTerm: number;
    longTerm:   number;
    alignment:  'bullish' | 'bearish' | 'mixed';
    divergence: boolean;
    score:      number;      // clipped to [-1, 1]  FIX 5
  };
  liquiditySqueeze: {
    detected:       boolean;
    intensity:      number;  // 0–100
    level:          LiquidityLevel;
    expectedMove:   number;
    timeToRelease:  number;  // candles; shorter = sooner  FIX 6
  };
  metadata: {
    timestamp:          number;
    dataPoints:         number;
    allModelsConfidence: number;
  };
}

// ---------------------------------------------------------------------------
// Learning: SGD Softmax (multi-class logistic regression)
// ---------------------------------------------------------------------------

/**
 * K-class SGD softmax classifier.
 * W: [K × D] weight matrix (row per class).
 * b: [K] bias vector.
 */
class SoftmaxClassifier {
  W: number[][];   // [classes][features]
  b: number[];
  private lr:     number;
  private lambda: number;

  constructor(
    classes:  number,
    features: number,
    lr      = 0.01,
    lambda  = 0.001,
    W?:       number[][],
    b?:       number[]
  ) {
    this.W      = W ?? Array.from({ length: classes }, () =>
      Array.from({ length: features }, () => (Math.random() - 0.5) * 0.01)
    );
    this.b      = b ?? Array(classes).fill(0);
    this.lr     = lr;
    this.lambda = lambda;
  }

  /** Returns probability vector over classes (sums to 1). */
  predict(x: number[]): number[] {
    const logits = this.W.map((w, k) =>
      w.reduce((sum, wi, i) => sum + wi * x[i], this.b[k])
    );
    const maxLogit = Math.max(...logits);
    const exps     = logits.map(l => Math.exp(l - maxLogit)); // numerical stability
    const sumExps  = exps.reduce((a, b) => a + b, 0);
    return exps.map(e => e / sumExps);
  }

  /** Single SGD step with L2 regularisation. */
  train(x: number[], trueClass: number): void {
    const probs = this.predict(x);
    for (let k = 0; k < this.W.length; k++) {
      const error = probs[k] - (k === trueClass ? 1 : 0);
      for (let i = 0; i < this.W[k].length; i++) {
        this.W[k][i] -= this.lr * (error * x[i] + this.lambda * this.W[k][i]);
      }
      this.b[k] -= this.lr * error;
    }
  }
}

/** Binary SGD logistic regression (reused from ml-predictions, inlined here for module independence) */
class LogisticRegression {
  weights: number[];
  bias:    number;
  private lr:     number;
  private lambda: number;

  constructor(features: number, lr = 0.01, lambda = 0.001, weights?: number[], bias?: number) {
    this.weights = weights ?? Array.from({ length: features }, () => (Math.random() - 0.5) * 0.01);
    this.bias    = bias    ?? 0;
    this.lr      = lr;
    this.lambda  = lambda;
  }

  predict(x: number[]): number {
    const z = x.reduce((s, xi, i) => s + xi * this.weights[i], this.bias);
    return 1 / (1 + Math.exp(-z));
  }

  train(x: number[], label: 0 | 1): void {
    const err = this.predict(x) - label;
    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] -= this.lr * (err * x[i] + this.lambda * this.weights[i]);
    }
    this.bias -= this.lr * err;
  }
}

// ---------------------------------------------------------------------------
// Feature extraction for advanced models
// ---------------------------------------------------------------------------

const REGIME_CLASSES: MarketRegimeLabel[] = [
  'trending_up', 'trending_down', 'ranging', 'volatile', 'breakout'
];
const REGIME_CLASS_COUNT    = REGIME_CLASSES.length;  // 5
const BREAKOUT_CLASSES: BreakoutDirection[] = ['up', 'neutral', 'down'];
const BREAKOUT_CLASS_COUNT  = 3;
const SQUEEZE_FEATURE_COUNT = 3;   // priceCompression, volumeDecline, rangeCompression
const REGIME_FEATURE_COUNT  = 6;   // see extractRegimeFeatures
const BREAKOUT_FEATURE_COUNT = 5;  // see extractBreakoutFeatures

function extractRegimeFeatures(data: ChartDataPoint[]): number[] {
  const prices  = data.map(d => d.close);
  const volumes = data.map(d => d.volume);
  const highs   = data.map(d => d.high);
  const lows    = data.map(d => d.low);
  const ts      = trendStrength(prices);
  const vol20   = volatility(prices, 20);
  const volTr   = linearTrend(volumes, 20);
  const prRange = prices.length >= 20
    ? (Math.max(...highs.slice(-20)) - Math.min(...lows.slice(-20))) / (prices[prices.length - 1] || 1)
    : 0;
  const avgVol20 = mean(volumes.slice(-20));
  const volSpike = avgVol20 === 0 ? 1 : volumes[volumes.length - 1] / avgVol20;

  return [ts, vol20, volTr, prRange, volSpike, Math.abs(ts)];
}

function extractBreakoutFeatures(data: ChartDataPoint[]): number[] {
  const prices = data.map(d => d.close);
  const volumes = data.map(d => d.volume);
  const highs  = data.map(d => d.high);
  const lows   = data.map(d => d.low);
  const cur    = prices[prices.length - 1] || 1;
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow  = Math.min(...lows.slice(-20));

  return [
    cur / (recentHigh || 1),                                   // proximity to resistance
    (cur - recentLow) / (cur || 1),                            // proximity to support
    (recentHigh - recentLow) / (cur || 1),                     // compression ratio
    volatility(volumes, 10),                                    // volume compression
    mean(volumes.slice(-20)) === 0 ? 1
      : volumes[volumes.length - 1] / mean(volumes.slice(-20)) // volume spike
  ];
}

function extractSqueezeFeatures(data: ChartDataPoint[]): number[] {
  const prices  = data.map(d => d.close);
  const volumes = data.map(d => d.volume);
  const highs   = data.map(d => d.high);
  const lows    = data.map(d => d.low);
  const cur     = prices[prices.length - 1] || 1;
  const priceCompression = volatility(prices.slice(-20), 20);
  const volumeDecline    = linearTrend(volumes.slice(-20), 20);
  const rangeCompression = (Math.max(...highs.slice(-20)) - Math.min(...lows.slice(-20))) / cur;

  return [priceCompression, volumeDecline, rangeCompression];
}

// ---------------------------------------------------------------------------
// AdvancedMLService — instance-based (FIX 8)
// ---------------------------------------------------------------------------

export class AdvancedMLService {
  // FIX 7: real learned classifiers
  private regimeClassifier:   SoftmaxClassifier;
  private breakoutClassifier: SoftmaxClassifier;
  private squeezeClassifier:  LogisticRegression;

  constructor(savedWeights?: {
    regime?:   { W: number[][]; b: number[] };
    breakout?: { W: number[][]; b: number[] };
    squeeze?:  { weights: number[]; bias: number };
  }) {
    this.regimeClassifier   = new SoftmaxClassifier(
      REGIME_CLASS_COUNT, REGIME_FEATURE_COUNT, 0.01, 0.001,
      savedWeights?.regime?.W, savedWeights?.regime?.b
    );
    this.breakoutClassifier = new SoftmaxClassifier(
      BREAKOUT_CLASS_COUNT, BREAKOUT_FEATURE_COUNT, 0.01, 0.001,
      savedWeights?.breakout?.W, savedWeights?.breakout?.b
    );
    this.squeezeClassifier  = new LogisticRegression(
      SQUEEZE_FEATURE_COUNT, 0.01, 0.001,
      savedWeights?.squeeze?.weights, savedWeights?.squeeze?.bias
    );
  }

  /** Export weights for persistence. */
  getWeights() {
    return {
      regime:   { W: this.regimeClassifier.W,   b: this.regimeClassifier.b   },
      breakout: { W: this.breakoutClassifier.W,  b: this.breakoutClassifier.b  },
      squeeze:  { weights: this.squeezeClassifier.weights, bias: this.squeezeClassifier.bias }
    };
  }

  /**
   * Batch-train all three classifiers on labelled history.
   * Labels are derived heuristically from the data itself — replace with
   * real human-labelled or backtest-derived labels for best accuracy.
   */
  trainOnHistory(data: ChartDataPoint[]): void {
    for (let i = 50; i < data.length - 1; i++) {
      const slice = data.slice(0, i + 1);

      // --- Regime label: derive from next 5-bar forward returns + volatility ---
      const prices    = slice.map(d => d.close);
      const fwdReturn = (data[i + 1].close - data[i].close) / (data[i].close || 1);
      const vol5      = volatility(prices, 5);
      const ts        = trendStrength(prices);
      const volumes   = slice.map(d => d.volume);
      const avgVol    = mean(volumes.slice(-20));
      const volSpike  = avgVol === 0 ? 1 : volumes[volumes.length - 1] / avgVol;

      let regimeLabel = 2; // 'ranging' default
      if (ts > 0.3 && fwdReturn > 0)  regimeLabel = 0; // trending_up
      if (ts < -0.3 && fwdReturn < 0) regimeLabel = 1; // trending_down
      if (vol5 > 0.03)                regimeLabel = 3; // volatile
      if (volSpike > 2 && Math.abs(fwdReturn) > 0.02) regimeLabel = 4; // breakout

      this.regimeClassifier.train(extractRegimeFeatures(slice), regimeLabel);

      // --- Breakout label: does price break recent high/low next bar? ---
      const recentHigh = Math.max(...slice.slice(-20).map(d => d.high));
      const recentLow  = Math.min(...slice.slice(-20).map(d => d.low));
      const nextClose  = data[i + 1].close;
      let breakoutLabel = 1; // neutral
      if (nextClose > recentHigh) breakoutLabel = 0; // up
      if (nextClose < recentLow)  breakoutLabel = 2; // down

      this.breakoutClassifier.train(extractBreakoutFeatures(slice), breakoutLabel);

      // --- Squeeze label: was volatility below threshold for 5+ bars? ---
      const squeezeLabel: 0 | 1 = vol5 < 0.01 ? 1 : 0;
      this.squeezeClassifier.train(extractSqueezeFeatures(slice), squeezeLabel);
    }

    console.log(`[AdvancedMLService] Trained on ${data.length} bars`);
  }

  /** Online update after observing real outcomes. */
  trainRegimeOnline(data: ChartDataPoint[], label: number): void {
    this.regimeClassifier.train(extractRegimeFeatures(data), label);
  }
  trainBreakoutOnline(data: ChartDataPoint[], label: number): void {
    this.breakoutClassifier.train(extractBreakoutFeatures(data), label);
  }
  trainSqueezeOnline(data: ChartDataPoint[], label: 0 | 1): void {
    this.squeezeClassifier.train(extractSqueezeFeatures(data), label);
  }

  // ---------------------------------------------------------------------------
  // Model 1: Market Regime Detector
  // ---------------------------------------------------------------------------

  detectMarketRegime(data: ChartDataPoint[]): AdvancedMLPredictions['marketRegime'] {
    if (data.length < 50) {
      return { regime: 'ranging', confidence: 0.5, strength: 0, characteristics: ['Insufficient data'] };
    }

    const x     = extractRegimeFeatures(data);
    const probs = this.regimeClassifier.predict(x);           // real model output
    const maxP  = Math.max(...probs);
    const idx   = probs.indexOf(maxP);
    const regime = REGIME_CLASSES[idx];

    const prices  = data.map(d => d.close);
    const volumes = data.map(d => d.volume);
    const vol20   = volatility(prices, 20);
    const volTr   = linearTrend(volumes, 20);
    const ts      = trendStrength(prices);

    const characteristics: string[] = [];
    if (vol20 > 0.03)         characteristics.push('High volatility');
    if (volTr > 0.5)          characteristics.push('Increasing volume');
    if (Math.abs(ts) > 0.5)   characteristics.push('Strong directional move');
    if (characteristics.length === 0) characteristics.push('Normal conditions');

    return {
      regime,
      confidence: clamp(maxP, 0, 1),
      strength:   clamp(Math.abs(ts), 0, 1),
      characteristics
    };
  }

  // ---------------------------------------------------------------------------
  // Model 2: Breakout Probability Predictor  (FIX 3)
  // ---------------------------------------------------------------------------

  predictBreakout(data: ChartDataPoint[]): AdvancedMLPredictions['breakoutProbability'] {
    const fallback = {
      upward: 1/3, neutral: 1/3, downward: 1/3,
      direction: 'neutral' as BreakoutDirection,
      timeframe: 'unknown',
      triggerPrice: data[data.length - 1]?.close ?? 0
    };

    if (data.length < 30) return fallback;

    const x     = extractBreakoutFeatures(data);
    const probs = this.breakoutClassifier.predict(x); // sums to 1 — FIX 3
    const [pUp, pNeutral, pDown] = probs;

    const highs      = data.map(d => d.high);
    const lows       = data.map(d => d.low);
    const recentHigh = Math.max(...highs.slice(-20));
    const recentLow  = Math.min(...lows.slice(-20));
    const cur        = data[data.length - 1].close;

    const compressionRatio = (recentHigh - recentLow) / (cur || 1);
    const direction: BreakoutDirection =
      pUp > pDown && pUp > pNeutral ? 'up'   :
      pDown > pUp && pDown > pNeutral ? 'down' : 'neutral';
    const triggerPrice = direction === 'up' ? recentHigh : direction === 'down' ? recentLow : cur;
    const timeframe    =
      compressionRatio < 0.03 ? '1–3 candles' :
      compressionRatio < 0.07 ? '3–7 candles' : '7+ candles';

    return {
      upward:   clamp(pUp,      0, 1),
      neutral:  clamp(pNeutral, 0, 1),
      downward: clamp(pDown,    0, 1),
      direction, timeframe, triggerPrice
    };
  }

  // ---------------------------------------------------------------------------
  // Model 3: Order Flow Imbalance  (FIX 4 — doji guard)
  // ---------------------------------------------------------------------------

  analyzeOrderFlow(data: ChartDataPoint[]): AdvancedMLPredictions['orderFlowImbalance'] {
    const zero = { buyPressure: 50, sellPressure: 50, netImbalance: 0, dominantSide: 'balanced' as const, strength: 0 };
    if (data.length < 10) return zero;

    let buy = 0, sell = 0;

    for (const candle of data.slice(-20)) {
      const totalRange = candle.high - candle.low;
      // FIX 4: skip doji / malformed candles instead of dividing by zero
      if (totalRange <= 0) continue;
      const bodySize = Math.abs(candle.close - candle.open);
      const ratio    = bodySize / totalRange;
      if (candle.close >= candle.open) buy  += ratio * candle.volume;
      else                              sell += ratio * candle.volume;
    }

    const total = buy + sell;
    if (total === 0) return zero;

    const buyPct  = (buy  / total) * 100;
    const sellPct = (sell / total) * 100;
    const net     = buyPct - sellPct;

    return {
      buyPressure:  buyPct,
      sellPressure: sellPct,
      netImbalance: net,
      dominantSide: net > 10 ? 'buyers' : net < -10 ? 'sellers' : 'balanced',
      strength:     clamp(Math.abs(net) / 100, 0, 1)
    };
  }

  // ---------------------------------------------------------------------------
  // Model 4: Multi-Timeframe Momentum  (FIX 5 — score clipped to [-1,1])
  // ---------------------------------------------------------------------------

  synthesizeMomentum(data: ChartDataPoint[]): AdvancedMLPredictions['multiTimeframeMomentum'] {
    if (data.length < 50) {
      return { shortTerm: 0, mediumTerm: 0, longTerm: 0, alignment: 'mixed', divergence: false, score: 0 };
    }

    const prices     = data.map(d => d.close);
    const shortTerm  = momentum(prices, 5);
    const mediumTerm = momentum(prices, 20);
    const longTerm   = momentum(prices, 50);

    const alignment: 'bullish' | 'bearish' | 'mixed' =
      shortTerm > 0 && mediumTerm > 0 && longTerm > 0 ? 'bullish' :
      shortTerm < 0 && mediumTerm < 0 && longTerm < 0 ? 'bearish' : 'mixed';

    const divergence = (shortTerm > 0) !== (mediumTerm > 0);

    // FIX 5: raw momentum values are unbounded; normalise to [-1,1]
    const rawScore = shortTerm * 0.5 + mediumTerm * 0.3 + longTerm * 0.2;
    const score    = clamp(rawScore * 10, -1, 1); // scale then clip

    return { shortTerm, mediumTerm, longTerm, alignment, divergence, score };
  }

  // ---------------------------------------------------------------------------
  // Model 5: Liquidity Squeeze  (FIX 6 — timeToRelease corrected)
  // ---------------------------------------------------------------------------

  detectLiquiditySqueeze(data: ChartDataPoint[]): AdvancedMLPredictions['liquiditySqueeze'] {
    if (data.length < 30) {
      return { detected: false, intensity: 0, level: 'none', expectedMove: 0, timeToRelease: 0 };
    }

    const x          = extractSqueezeFeatures(data);
    const squeezePr  = this.squeezeClassifier.predict(x); // P(squeeze active)

    // Map model probability to a 0–100 intensity score
    const intensity  = clamp(squeezePr * 100, 0, 100);
    const detected   = intensity > 50;

    const level: LiquidityLevel =
      intensity > 80 ? 'extreme' :
      intensity > 60 ? 'high'    :
      intensity > 40 ? 'medium'  :
      intensity > 20 ? 'low'     : 'none';

    const priceCompression = x[0]; // first squeeze feature
    const expectedMove     = detected ? clamp((1 - priceCompression) * 0.1, 0, 1) : 0;

    // FIX 6: longer compression → sooner release (shorter timeToRelease)
    const compressionDuration = countConsecutiveLowVolatility(data.map(d => d.close));
    const timeToRelease =
      compressionDuration > 10 ? 1 :
      compressionDuration > 5  ? 3 : 5;

    return { detected, intensity, level, expectedMove, timeToRelease };
  }

  // ---------------------------------------------------------------------------
  // Aggregate prediction entry point  (FIX 8: instance method)
  // ---------------------------------------------------------------------------

  async generateAdvancedPredictions(data: ChartDataPoint[]): Promise<AdvancedMLPredictions> {
    const marketRegime          = this.detectMarketRegime(data);
    const breakoutProbability   = this.predictBreakout(data);
    const orderFlowImbalance    = this.analyzeOrderFlow(data);
    const multiTimeframeMomentum = this.synthesizeMomentum(data);
    const liquiditySqueeze      = this.detectLiquiditySqueeze(data);

    // FIX 5: all values provably in [0, 1] before averaging
    const allConfidences = [
      clamp(marketRegime.confidence, 0, 1),
      clamp(Math.max(breakoutProbability.upward, breakoutProbability.downward), 0, 1),
      clamp(orderFlowImbalance.strength, 0, 1),
      clamp((multiTimeframeMomentum.score + 1) / 2, 0, 1), // [-1,1] → [0,1]
      clamp(liquiditySqueeze.intensity / 100, 0, 1)
    ];
    const allModelsConfidence = mean(allConfidences);

    return {
      marketRegime,
      breakoutProbability,
      orderFlowImbalance,
      multiTimeframeMomentum,
      liquiditySqueeze,
      metadata: {
        timestamp:           Date.now(),
        dataPoints:          data.length,
        allModelsConfidence: clamp(allModelsConfidence, 0, 1)
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Private helper (not exported — only used inside this module)
// ---------------------------------------------------------------------------

function countConsecutiveLowVolatility(prices: number[]): number {
  let count = 0;
  for (let i = prices.length - 1; i >= Math.max(0, prices.length - 20); i--) {
    const window = prices.slice(Math.max(0, i - 5), i + 1);
    if (volatility(window, window.length) < 0.015) count++;
    else break;
  }
  return count;
}

export default AdvancedMLService;