/**
 * ml-predictions.ts
 *
 * Fixes vs. original:
 *  1. trainedWeights actually used — direction classifier is initialised from
 *     stored weights and updated via online SGD (real learning, not heuristics).
 *  2. All static methods replaced with instance methods so weights are accessible.
 *  3. Shared ChartDataPoint and helpers imported from indicators.ts — no more
 *     duplicate definitions that drift apart between files.
 *  4. direction.prediction casing unified to lowercase literals only.
 *  5. Dead `signal` variable removed.
 *  6. predictPrice confidence clamped to [0, 1].
 *  7. RSI treated as a threshold feature (overbought/oversold binary) rather
 *     than a raw linear weight.
 *  8. holdingPeriod accepts an explicit `candleMinutes` parameter so the
 *     day/hour conversion is always correct.
 *  9. Direction classifier exposes `train(features, label)` for online updates.
 * 10. Model weights are serialisable and round-trip through MLModelStorage.
 */

import { MLModelStorage } from './ml-model-storage';
import {
  ChartDataPoint,
  mean,
  standardDeviation,
  clamp,
  momentum,
  volatility,
  meanReversion,
  trendStrength,
  linearTrend,
  atr,
  rateOfChange,
  priceChange,
  volumeRatio
} from '@shared/indicators';

export type { ChartDataPoint };

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface MLPredictions {
  direction: {
    prediction:  'bullish' | 'bearish';
    probability: number;   // P(bullish) in [0, 1]
    confidence:  number;   // distance from 0.5, scaled to [0, 1]
    strength:    number;   // same as confidence (alias for interface compat)
  };
  price: {
    predicted:      number;
    change:         number;
    changePercent:  number;
    high:           number;
    low:            number;
    confidence:     number;
    target:         'UP' | 'DOWN' | 'NEUTRAL';
  };
  volatility: {
    predicted:  number;
    level:      'low' | 'medium' | 'high' | 'extreme';
    confidence: number;
  };
  holdingPeriod: {
    candles:    number;
    days:       number;
    hours:      number;
    confidence: number;
    reason:     string;
  };
  risk: {
    score:   number;       // 0–100
    level:   'low' | 'medium' | 'high' | 'extreme';
    factors: string[];
  };
  metadata: {
    timestamp:  number;
    dataPoints: number;
    features:   number;
    horizon:    string;
  };
}

// ---------------------------------------------------------------------------
// Feature vector helpers
// ---------------------------------------------------------------------------

export interface FeatureVector {
  priceChange1:     number;
  priceChange3:     number;
  priceChange5:     number;
  priceChange10:    number;
  momentum5:        number;
  momentum10:       number;
  rateOfChange5:    number;
  volatility5:      number;
  volatility10:     number;
  atr:              number;
  volumeRatioVal:   number;
  volumeTrend:      number;
  rsi:              number;
  rsiOverbought:    number;   // FIX 7: binary threshold features
  rsiOversold:      number;
  macd:             number;
  ema:              number;
  trendStr:         number;
  meanRev:          number;
  distanceToHigh:   number;
  distanceToLow:    number;
}

function extractFeatures(data: ChartDataPoint[]): FeatureVector {
  const recent  = data.slice(-20);
  const current = recent[recent.length - 1];
  const prices  = recent.map(d => d.close);
  const volumes = recent.map(d => d.volume);
  const highs   = recent.map(d => d.high);
  const lows    = recent.map(d => d.low);
  const closes  = recent.map(d => d.close);

  const rsiVal = current.rsi ?? 50;

  return {
    priceChange1:   priceChange(prices, 1),
    priceChange3:   priceChange(prices, 3),
    priceChange5:   priceChange(prices, 5),
    priceChange10:  priceChange(prices, 10),
    momentum5:      momentum(prices, 5),
    momentum10:     momentum(prices, 10),
    rateOfChange5:  rateOfChange(prices, 5),
    volatility5:    volatility(prices, 5),
    volatility10:   volatility(prices, 10),
    atr:            atr(highs, lows, closes, 14),
    volumeRatioVal: volumeRatio(volumes),
    volumeTrend:    linearTrend(volumes, 5),
    rsi:            rsiVal,
    // FIX 7: threshold binary features instead of raw RSI magnitude
    rsiOverbought:  rsiVal > 70 ? 1 : 0,
    rsiOversold:    rsiVal < 30 ? 1 : 0,
    macd:           current.macd ?? 0,
    ema:            current.ema  ?? current.close,
    trendStr:       trendStrength(prices),
    meanRev:        meanReversion(prices),
    distanceToHigh: (Math.max(...highs) - current.close) / (current.close || 1),
    distanceToLow:  (current.close - Math.min(...lows))  / (current.close || 1),
  };
}

function featureToArray(f: FeatureVector): number[] {
  return [
    f.priceChange1, f.priceChange3, f.priceChange5, f.priceChange10,
    f.momentum5,    f.momentum10,   f.rateOfChange5,
    f.volatility5,  f.volatility10, f.atr,
    f.volumeRatioVal, f.volumeTrend,
    f.rsiOverbought, f.rsiOversold, f.macd,
    f.trendStr,     f.meanRev,
    f.distanceToHigh, f.distanceToLow,
  ];
}

const FEATURE_COUNT = 19; // must match featureToArray length

// ---------------------------------------------------------------------------
// SGD Logistic Regression — real online learning
// ---------------------------------------------------------------------------

/**
 * Minimal SGD logistic-regression classifier.
 *
 * Predicts P(y=1 | x) = sigmoid(w·x + b).
 * Updated via online SGD with L2 regularisation on every `train()` call.
 * Weights are plain arrays so they serialise/deserialise trivially.
 */
class LogisticRegression {
  weights: number[];
  bias:    number;
  private lr:     number;  // learning rate
  private lambda: number;  // L2 regularisation strength

  constructor(
    featureCount: number,
    lr     = 0.01,
    lambda = 0.001,
    weights?: number[],
    bias?:    number
  ) {
    // FIX 1: initialise from stored weights when available
    this.weights = weights ?? Array.from({ length: featureCount }, () => (Math.random() - 0.5) * 0.01);
    this.bias    = bias    ?? 0;
    this.lr      = lr;
    this.lambda  = lambda;
  }

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-z));
  }

  predict(x: number[]): number {
    const z = x.reduce((sum, xi, i) => sum + xi * this.weights[i], this.bias);
    return this.sigmoid(z);
  }

  /**
   * Single online SGD step.
   * @param x       feature vector
   * @param label   1 = bullish, 0 = bearish
   */
  train(x: number[], label: 0 | 1): void {
    const prob  = this.predict(x);
    const error = prob - label;               // dL/dz

    // Update weights with L2 regularisation
    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] -= this.lr * (error * x[i] + this.lambda * this.weights[i]);
    }
    this.bias -= this.lr * error;
  }

  /**
   * Batch training on a labelled history.
   * Labels are generated from next-bar returns: positive return → 1, else 0.
   */
  trainOnHistory(data: ChartDataPoint[]): void {
    for (let i = 20; i < data.length - 1; i++) {
      const slice   = data.slice(0, i + 1);
      const f       = extractFeatures(slice);
      const x       = featureToArray(f);
      const nextRet = (data[i + 1].close - data[i].close) / (data[i].close || 1);
      const label   = nextRet > 0 ? 1 : 0;
      this.train(x, label as 0 | 1);
    }
  }
}

// ---------------------------------------------------------------------------
// MLPredictionService
// ---------------------------------------------------------------------------

export class MLPredictionService {
  // FIX 2: instance-level classifier so weights are reachable everywhere
  private classifier: LogisticRegression;
  private isLoaded = false;

  constructor() {
    this.classifier = new LogisticRegression(FEATURE_COUNT);
    this.loadTrainedWeights();
  }

  // FIX 1: weights are now actually applied to the classifier
  private async loadTrainedWeights(): Promise<void> {
    try {
      const loaded = await MLModelStorage.loadLatestWeights();
      if (loaded?.weights?.direction) {
        const { weights, bias } = loaded.weights.direction as { weights: number[]; bias: number };
        this.classifier = new LogisticRegression(FEATURE_COUNT, 0.01, 0.001, weights, bias);
        this.isLoaded   = true;
        console.log('[ML Predictions] Loaded trained weights from:', loaded.metadata.trainedAt);
      }
    } catch {
      console.log('[ML Predictions] No trained weights found — using randomly initialised model');
    }
  }

  async saveWeights(dataPoints?: number): Promise<void> {
    await MLModelStorage.saveWeights(
      { direction: { weights: this.classifier.weights, bias: this.classifier.bias } },
      { trainedAt: new Date().toISOString(), dataPoints: dataPoints ?? 0, featureCount: FEATURE_COUNT }
    );
  }

  /**
   * Online update: call after observing a real outcome.
   * @param data   the candle history at prediction time
   * @param label  1 = next bar was bullish, 0 = bearish
   */
  trainOnline(data: ChartDataPoint[], label: 0 | 1): void {
    const f = extractFeatures(data);
    this.classifier.train(featureToArray(f), label);
  }

  /**
   * Batch-train on a full historical dataset.
   * Call this once on startup with sufficient history before serving predictions.
   */
  async trainOnHistory(data: ChartDataPoint[]): Promise<void> {
    this.classifier.trainOnHistory(data);
    await this.saveWeights(data.length);
    console.log(`[ML Predictions] Trained on ${data.length} bars`);
  }

  // FIX 2: instance method so the live classifier is used
  async generatePredictions(
    chartData:       ChartDataPoint[],
    candleMinutes = 60   // FIX 8: caller specifies the bar size
  ): Promise<MLPredictions> {
    if (chartData.length < 20) {
      throw new Error('Insufficient data for ML predictions (minimum 20 candles required)');
    }

    const features     = extractFeatures(chartData);
    const direction    = this.predictDirection(features);
    const price        = predictPrice(chartData, features);
    const vol          = predictVolatility(chartData, features);
    const holdingPeriod = predictHoldingPeriod(features, direction, vol, candleMinutes);
    const risk         = assessRisk(features, direction, vol);
    // Wrap ML confidences with mode-aware scorer before publishing
    try {
      const scorerMod = require('./market-data/confidence-scorer') as any;
      if (scorerMod && typeof scorerMod.getConfidenceScorer === 'function') {
        const scorer = scorerMod.getConfidenceScorer();
        const dirScored = scorer.scoreWithCurrentMode(direction.confidence, 'ml');
        direction.confidence = dirScored.adjusted;
        // also adjust price/volatility/holdingPeriod confidences conservatively
        price.confidence = Math.min(1, (price.confidence + dirScored.adjusted) / 2);
        vol.confidence   = Math.min(1, (vol.confidence   + dirScored.adjusted) / 2);
        holdingPeriod.confidence = Math.min(1, (holdingPeriod.confidence + dirScored.adjusted) / 2);
      }
    } catch (e) {
      // ignore scorer failures
    }

    return {
      direction,
      price,
      volatility: vol,
      holdingPeriod,
      risk,
      metadata: {
        timestamp:  Date.now(),
        dataPoints: chartData.length,
        features:   Object.keys(features).length,
        horizon:    '1 candle'
      }
    };
  }

  // FIX 1 & 2: uses the live logistic-regression classifier
  private predictDirection(features: FeatureVector): MLPredictions['direction'] {
    const x           = featureToArray(features);
    const probability = this.classifier.predict(x);          // real model output
    // FIX 4: lowercase only
    const prediction  = probability > 0.5 ? 'bullish' : 'bearish';
    const confidence  = clamp(Math.abs(probability - 0.5) * 2, 0, 1);

    return { prediction, probability, confidence, strength: confidence };
  }
}

// ---------------------------------------------------------------------------
// Pure prediction functions (no learned weights needed — these are analytic)
// ---------------------------------------------------------------------------

function predictPrice(
  data:     ChartDataPoint[],
  features: FeatureVector
): MLPredictions['price'] {
  const current = data[data.length - 1];

  let predictedChange = current.close * (features.momentum5 * 0.5 + features.trendStr * 0.3);

  // FIX 7: use threshold features, not raw RSI magnitude
  if (features.rsiOverbought) predictedChange *= 0.7;
  if (features.rsiOversold)   predictedChange *= 1.3;

  const predicted    = Math.max(0, current.close + predictedChange);
  const volBand      = current.close * features.volatility5 * 2;

  // FIX 6: confidence clamped to [0, 1]
  const confidence   = clamp(Math.abs(features.trendStr) * (1 - features.volatility5), 0, 1);
  const change       = predicted - current.close;
  const changePercent = current.close === 0 ? 0 : (change / current.close) * 100;
  const target: 'UP' | 'DOWN' | 'NEUTRAL' =
    changePercent >  0.1 ? 'UP'   :
    changePercent < -0.1 ? 'DOWN' : 'NEUTRAL';

  return {
    predicted,
    change,
    changePercent,
    high: Math.max(0, predicted + volBand),
    low:  Math.max(0, predicted - volBand),
    confidence,
    target
  };
}

function predictVolatility(
  data:     ChartDataPoint[],
  features: FeatureVector
): MLPredictions['volatility'] {
  const currentPrice = data[data.length - 1].close || 1;
  let predicted = features.volatility10 * 0.7 + (features.atr / currentPrice) * 0.3;
  if (features.volumeRatioVal > 1.5) predicted *= 1.2;

  const level: MLPredictions['volatility']['level'] =
    predicted < 0.01 ? 'low'     :
    predicted < 0.02 ? 'medium'  :
    predicted < 0.04 ? 'high'    : 'extreme';

  const volHistory = data.slice(-10).map((d, i, arr) =>
    i === 0 ? 0 : Math.abs((d.close - arr[i - 1].close) / (arr[i - 1].close || 1))
  );
  const confidence = clamp(1 - standardDeviation(volHistory) * 10, 0.3, 1);

  return { predicted, level, confidence };
}

// FIX 8: candleMinutes parameter replaces the hardcoded 1H assumption
function predictHoldingPeriod(
  features:      FeatureVector,
  direction:     MLPredictions['direction'],
  vol:           MLPredictions['volatility'],
  candleMinutes: number
): MLPredictions['holdingPeriod'] {
  let basePeriod = 10;
  let confidence = 0.5;
  let reason     = 'Normal market conditions';

  if (vol.level === 'low') {
    basePeriod = 30; confidence = 0.8;
    reason = 'Low volatility favors longer holds';
  } else if (vol.level === 'high') {
    basePeriod = 5;  confidence = 0.7;
    reason = 'High volatility favors quick exits';
  } else if (vol.level === 'extreme') {
    basePeriod = 2;  confidence = 0.85;
    reason = 'Extreme volatility — scalp only';
  }

  const ts = Math.abs(features.trendStr);
  if (ts > 0.6) {
    basePeriod = Math.floor(basePeriod * 1.5);
    confidence = Math.min(0.9, confidence + 0.1);
    reason = 'Strong trend detected — extended hold';
  } else if (ts < 0.2) {
    basePeriod = Math.floor(basePeriod * 0.5);
    reason = 'Weak trend — quick scalp recommended';
  }

  // FIX 7: use threshold features
  if (features.rsiOverbought || features.rsiOversold) {
    basePeriod = Math.floor(basePeriod * 0.7);
    reason = features.rsiOverbought
      ? 'Overbought — expect reversal'
      : 'Oversold — expect bounce';
  }

  if (direction.confidence > 0.8) {
    basePeriod = Math.floor(basePeriod * 1.3);
    confidence = Math.max(confidence, direction.confidence);
  }

  if (features.volumeRatioVal > 2) {
    basePeriod = Math.floor(basePeriod * 0.8);
    reason = 'High volume — accelerated timeline';
  }

  basePeriod = clamp(basePeriod, 1, 100);

  // FIX 8: correct conversion using caller-supplied candleMinutes
  const totalMinutes = basePeriod * candleMinutes;
  const hours = totalMinutes / 60;
  const days  = Math.round((totalMinutes / (60 * 24)) * 10) / 10;

  return { candles: basePeriod, days, hours, confidence, reason };
}

function assessRisk(
  features:  FeatureVector,
  direction: MLPredictions['direction'],
  vol:       MLPredictions['volatility']
): MLPredictions['risk'] {
  const factors: string[] = [];
  let riskScore = 0;

  if      (vol.level === 'extreme') { riskScore += 30; factors.push('Extreme volatility'); }
  else if (vol.level === 'high')    { riskScore += 20; factors.push('High volatility'); }
  else if (vol.level === 'medium')  { riskScore += 10; }

  const ts = Math.abs(features.trendStr);
  if      (ts < 0.2) { riskScore += 20; factors.push('Weak trend — unclear direction'); }
  else if (ts < 0.4) { riskScore += 10; }

  if      (direction.confidence < 0.4) { riskScore += 25; factors.push('Low model confidence'); }
  else if (direction.confidence < 0.6) { riskScore += 15; }

  // FIX 7: use threshold features
  if (features.rsiOverbought) { riskScore += 15; factors.push(`RSI overbought (${features.rsi.toFixed(0)})`); }
  else if (features.rsi > 70) { riskScore += 8; }
  if (features.rsiOversold)   { riskScore += 15; factors.push(`RSI oversold (${features.rsi.toFixed(0)})`); }
  else if (features.rsi < 30) { riskScore += 8; }

  if      (features.volumeRatioVal > 3)   { riskScore += 10; factors.push('Unusual volume spike'); }
  else if (features.volumeRatioVal < 0.5) { riskScore += 5;  factors.push('Low volume — thin market'); }

  if (factors.length === 0) factors.push('Normal market conditions');

  const level: MLPredictions['risk']['level'] =
    riskScore < 25 ? 'low'     :
    riskScore < 50 ? 'medium'  :
    riskScore < 75 ? 'high'    : 'extreme';

  return { score: clamp(riskScore, 0, 100), level, factors };
}

// Export a singleton instance by default so importing modules can call
// `generatePredictions(...)` directly without needing to instantiate.
export default new MLPredictionService();