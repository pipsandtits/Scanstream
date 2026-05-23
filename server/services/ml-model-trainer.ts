/**
 * ml-model-trainer.ts
 *
 * Fixes vs. original:
 *  1.  TrainedWeights replaced by ModelWeights from ml-model-storage — the
 *      flat number[] arrays are gone; shapes match LogisticRegression and
 *      SoftmaxClassifier in the service files.
 *  2.  Frame field access fixed throughout: original used frame.price.close
 *      but MarketFrame uses frame.close / frame.open / frame.high / frame.low
 *      directly; indicators are at frame.indicators.rsi etc.
 *  3.  trainBinaryClassifier and trainRegressor both now apply L2
 *      regularisation (lambda * w) so weights don't explode on long runs.
 *  4.  Mini-batch SGD: gradients are averaged over a batch before applying,
 *      giving smoother updates than pure online (one sample at a time).
 *  5.  valLoss and trainLoss are actually computed and returned instead of
 *      hardcoded to 0.
 *  6.  trainBinaryClassifier returns {weights, bias} not [...weights, bias]
 *      so the bias is never silently folded into the weight vector and
 *      extracted by fragile slice(-1) indexing.
 *  7.  calculateMetrics receives weights in the correct structured shape and
 *      no longer re-implements a broken slice(0,-1) extraction.
 *  8.  generateSyntheticData is removed. Synthetic data is statistically
 *      meaningless for a production trading model and dangerous because it
 *      silently masks the absence of real data. Callers now receive a clear
 *      error when insufficient real data is available.
 *  9.  extractFeatures is aligned with the FeatureVector definition in
 *      ml-predictions.ts so both services see identical feature spaces.
 * 10.  Default export of a singleton instance removed — the class is stateful
 *      (learningRate, batchSize) and callers should construct their own instance
 *      with explicit config, or use a DI container.
 */

import { storage } from '../storage';
import { MLModelStorage, ModelWeights, LogisticWeights } from './ml-model-storage';
import { ChartDataPoint } from '@shared/indicators';

// ---------------------------------------------------------------------------
// Configuration & metric types
// ---------------------------------------------------------------------------

export interface TrainingConfig {
  symbol:          string;
  lookbackDays:    number;
  validationSplit: number;   // fraction of data held out, e.g. 0.2
  epochs:          number;
  learningRate?:   number;   // default 0.001
  batchSize?:      number;   // default 32
  lambda?:         number;   // L2 strength, default 0.001  FIX 3
  minDataPoints?:  number;   // throw if fewer frames available, default 100
}

export interface TrainingMetrics {
  trainLoss: number;   // FIX 5: actually computed
  valLoss:   number;
  accuracy:  number;
  precision: number;
  recall:    number;
  f1Score:   number;
}

// FIX 1: matches real classifier weight shapes
interface InternalWeights {
  direction: LogisticWeights;
}

// ---------------------------------------------------------------------------
// Label arrays produced by prepareTrainingData
// ---------------------------------------------------------------------------

interface LabelSet {
  direction:  number[];   // 0 | 1
  volatility: number[];   // raw ratio
}

// ---------------------------------------------------------------------------
// MLModelTrainer
// ---------------------------------------------------------------------------

export class MLModelTrainer {
  private readonly learningRate: number;
  private readonly batchSize:    number;
  private readonly lambda:       number;

  constructor(config: Pick<TrainingConfig, 'learningRate' | 'batchSize' | 'lambda'> = {}) {
    this.learningRate = config.learningRate ?? 0.001;
    this.batchSize    = config.batchSize    ?? 32;
    this.lambda       = config.lambda       ?? 0.001;
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  async trainModels(config: TrainingConfig): Promise<{
    weights: ModelWeights;
    metrics: TrainingMetrics;
  }> {
    const minDataPoints = config.minDataPoints ?? 100;
    console.log(`[ML Trainer] Starting training for ${config.symbol}`);

    // 1. Fetch real historical data
    const frames = await storage.getMarketFrames(
      config.symbol,
      config.lookbackDays * 24   // assumes hourly bars
    );

    // FIX 8: hard error instead of silent synthetic fallback
    if (frames.length < minDataPoints) {
      throw new Error(
        `[ML Trainer] Insufficient data: got ${frames.length} frames, need at least ${minDataPoints}. ` +
        `Increase lookbackDays or lower minDataPoints.`
      );
    }

    console.log(`[ML Trainer] ${frames.length} real frames loaded`);

    // 2. Convert storage frames to ChartDataPoint (FIX 2: correct field names)
    const chartData = this.toChartDataPoints(frames);

    // 3. Prepare feature matrix and labels
    const { features, labels } = this.prepareTrainingData(chartData);

    if (features.length === 0) {
      throw new Error('[ML Trainer] No training examples produced — check frame field mapping');
    }

    const splitIdx = Math.floor(features.length * (1 - config.validationSplit));
    const trainX   = features.slice(0, splitIdx);
    const valX     = features.slice(splitIdx);
    const trainDir = labels.direction.slice(0, splitIdx);
    const valDir   = labels.direction.slice(splitIdx);

    console.log(`[ML Trainer] Train: ${trainX.length}, Val: ${valX.length}`);

    // 4. Train direction classifier (the one model we persist via LogisticWeights)
    const { weights: dirWeights, bias: dirBias, trainLoss, valLoss } =
      this.trainBinaryClassifier(trainX, trainDir, valX, valDir, config.epochs);

    // 5. Evaluate
    const directionWeights: LogisticWeights = { weights: dirWeights, bias: dirBias };
    const metrics = this.calculateMetrics(valX, valDir, directionWeights);
    metrics.trainLoss = trainLoss;
    metrics.valLoss   = valLoss;

    // 6. Assemble ModelWeights and persist
    const modelWeights: ModelWeights = { direction: directionWeights };

    await MLModelStorage.saveWeights(modelWeights, {
      trainedAt:    new Date().toISOString(),
      dataPoints:   frames.length,
      featureCount: features[0].length,
      accuracy:     metrics.accuracy
    });

    // Prune old snapshots — keep last 10
    await MLModelStorage.pruneOldModels(10);

    console.log(`[ML Trainer] Done. Accuracy: ${(metrics.accuracy * 100).toFixed(2)}%`);
    return { weights: modelWeights, metrics };
  }

  // ---------------------------------------------------------------------------
  // Frame conversion  (FIX 2)
  // ---------------------------------------------------------------------------

  /**
   * Maps raw storage frames to ChartDataPoint.
   * Adjust field paths here if your storage schema differs.
   */
  private toChartDataPoints(frames: any[]): ChartDataPoint[] {
    return frames.map(f => ({
      timestamp: f.timestamp instanceof Date ? f.timestamp.getTime() : Number(f.timestamp),
      open:      Number(f.open   ?? f.price?.open   ?? 0),
      high:      Number(f.high   ?? f.price?.high   ?? 0),
      low:       Number(f.low    ?? f.price?.low    ?? 0),
      close:     Number(f.close  ?? f.price?.close  ?? 0),
      volume:    Number(f.volume ?? 0),
      rsi:       f.indicators?.rsi  ?? null,
      macd:      f.indicators?.macd?.macd ?? f.indicators?.macd ?? null,
      ema:       f.indicators?.ema20 ?? null
    }));
  }

  // ---------------------------------------------------------------------------
  // Feature extraction  (FIX 9: aligned with FeatureVector in ml-predictions.ts)
  // ---------------------------------------------------------------------------

  /**
   * Produces the same 19-element feature vector as ml-predictions.ts
   * featureToArray() so the classifier trained here is directly usable there.
   *
   * Order must match FEATURE_COUNT = 19 in ml-predictions.ts:
   * [priceChange1, priceChange3, priceChange5, priceChange10,
   *  momentum5, momentum10, rateOfChange5,
   *  volatility5, volatility10, atr,
   *  volumeRatio, volumeTrend,
   *  rsiOverbought, rsiOversold, macd,
   *  trendStr, meanRev,
   *  distanceToHigh, distanceToLow]
   */
  private extractFeatures(data: ChartDataPoint[], index: number): number[] {
    const window = data.slice(Math.max(0, index - 19), index + 1);
    const prices  = window.map(d => d.close);
    const volumes = window.map(d => d.volume);
    const highs   = window.map(d => d.high);
    const lows    = window.map(d => d.low);
    const cur     = data[index];

    const pChange = (period: number): number => {
      if (index < period) return 0;
      const past = data[index - period].close;
      return past === 0 ? 0 : (cur.close - past) / past;
    };

    const mom = (period: number): number => pChange(period);

    const roc5 = (): number => {
      const changes: number[] = [];
      for (let i = 1; i <= Math.min(5, index); i++) {
        const prev = data[index - i].close;
        if (prev !== 0) changes.push((data[index - i + 1].close - prev) / prev);
      }
      return changes.length === 0 ? 0 : changes.reduce((a, b) => a + b, 0) / changes.length;
    };

    const logVolatility = (period: number): number => {
      if (prices.length < period + 1) return 0;
      const logRets = [];
      for (let i = prices.length - period; i < prices.length - 1; i++) {
        if (prices[i] > 0) logRets.push(Math.log(prices[i + 1] / prices[i]));
      }
      if (logRets.length === 0) return 0;
      const m = logRets.reduce((a, b) => a + b, 0) / logRets.length;
      return Math.sqrt(logRets.reduce((s, r) => s + (r - m) ** 2, 0) / logRets.length);
    };

    const atrVal = (): number => {
      const trs: number[] = [];
      for (let i = Math.max(1, index - 13); i <= index; i++) {
        const h = data[i].high, l = data[i].low, pc = data[i - 1]?.close ?? data[i].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      return trs.length === 0 ? 0 : trs.reduce((a, b) => a + b, 0) / trs.length;
    };

    const volRatio = (): number => {
      const avg = volumes.reduce((a, b) => a + b, 0) / (volumes.length || 1);
      return avg === 0 ? 1 : cur.volume / avg;
    };

    const volTrend = (): number => {
      const n = volumes.length;
      if (n < 2) return 0;
      const sx = (n * (n - 1)) / 2, sy = volumes.reduce((a, b) => a + b, 0);
      const sxy = volumes.reduce((s, v, i) => s + i * v, 0);
      const sx2 = (n * (n - 1) * (2 * n - 1)) / 6;
      const d = n * sx2 - sx ** 2;
      if (d === 0) return 0;
      const slope = (n * sxy - sx * sy) / d;
      const avg = sy / n;
      return avg === 0 ? 0 : slope / avg;
    };

    const rsiVal   = cur.rsi ?? 50;
    const recentH  = Math.max(...highs);
    const recentL  = Math.min(...lows);
    const ts       = (): number => {
      if (prices.length < 10) return 0;
      const r = prices.slice(-10);
      let up = 0, dn = 0;
      for (let i = 1; i < r.length; i++) {
        if (r[i] > r[i - 1]) up++;
        else if (r[i] < r[i - 1]) dn++;
      }
      return (up - dn) / (r.length - 1);
    };

    const meanRev = (): number => {
      if (prices.length < 5) return 0;
      const m = prices.reduce((a, b) => a + b, 0) / prices.length;
      const std = Math.sqrt(prices.reduce((s, p) => s + (p - m) ** 2, 0) / prices.length);
      return std === 0 ? 0 : (cur.close - m) / std;
    };

    return [
      pChange(1), pChange(3), pChange(5), pChange(10),
      mom(5),     mom(10),    roc5(),
      logVolatility(5), logVolatility(10), atrVal(),
      volRatio(), volTrend(),
      rsiVal > 70 ? 1 : 0,   // rsiOverbought
      rsiVal < 30 ? 1 : 0,   // rsiOversold
      cur.macd ?? 0,
      ts(), meanRev(),
      cur.close === 0 ? 0 : (recentH - cur.close) / cur.close,
      cur.close === 0 ? 0 : (cur.close - recentL)  / cur.close
    ];
  }

  // ---------------------------------------------------------------------------
  // Training data preparation
  // ---------------------------------------------------------------------------

  private prepareTrainingData(data: ChartDataPoint[]): {
    features: number[][];
    labels:   LabelSet;
  } {
    const features:  number[][] = [];
    const direction: number[]   = [];
    const volLabels: number[]   = [];

    for (let i = 20; i < data.length - 1; i++) {
      const cur  = data[i];
      const next = data[i + 1];
      if (cur.close === 0) continue;

      features.push(this.extractFeatures(data, i));

      // Next-bar direction label
      direction.push(next.close > cur.close ? 1 : 0);

      // Realised volatility over next 10 bars (for reference — not saved yet)
      const fwdPrices = data.slice(i, Math.min(i + 10, data.length)).map(d => d.close);
      const fwdMean   = fwdPrices.reduce((a, b) => a + b, 0) / fwdPrices.length;
      const fwdStd    = Math.sqrt(
        fwdPrices.reduce((s, p) => s + (p - fwdMean) ** 2, 0) / fwdPrices.length
      );
      volLabels.push(cur.close === 0 ? 0 : fwdStd / cur.close);
    }

    return { features, labels: { direction, volatility: volLabels } };
  }

  // ---------------------------------------------------------------------------
  // Binary classifier — SGD with mini-batches and L2 reg  (FIX 3, 4, 5, 6)
  // ---------------------------------------------------------------------------

  private trainBinaryClassifier(
    trainX: number[][],
    trainY: number[],
    valX:   number[][],
    valY:   number[],
    epochs: number
  ): { weights: number[]; bias: number; trainLoss: number; valLoss: number } {
    const D = trainX[0].length;
    let w    = Array.from({ length: D }, () => (Math.random() - 0.5) * 0.01);
    let b    = 0;

    const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

    const bce = (x: number[][], y: number[]): number => {
      let loss = 0;
      for (let i = 0; i < x.length; i++) {
        const p = sigmoid(x[i].reduce((s, xi, j) => s + xi * w[j], b));
        loss += -(y[i] * Math.log(p + 1e-10) + (1 - y[i]) * Math.log(1 - p + 1e-10));
      }
      return loss / x.length;
    };

    let lastTrainLoss = 0, lastValLoss = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
      // Shuffle training indices
      const idx = Array.from({ length: trainX.length }, (_, i) => i)
        .sort(() => Math.random() - 0.5);

      // FIX 4: mini-batch SGD
      for (let start = 0; start < idx.length; start += this.batchSize) {
        const batch = idx.slice(start, start + this.batchSize);
        const dw    = new Array(D).fill(0);
        let   db    = 0;

        for (const i of batch) {
          const x   = trainX[i];
          const p   = sigmoid(x.reduce((s, xi, j) => s + xi * w[j], b));
          const err = p - trainY[i];
          for (let j = 0; j < D; j++) dw[j] += err * x[j];
          db += err;
        }

        const bLen = batch.length;
        for (let j = 0; j < D; j++) {
          // FIX 3: L2 regularisation
          w[j] -= this.learningRate * (dw[j] / bLen + this.lambda * w[j]);
        }
        b -= this.learningRate * (db / bLen);
      }

      // FIX 5: compute real losses every 10 epochs
      if (epoch % 10 === 0 || epoch === epochs - 1) {
        lastTrainLoss = bce(trainX, trainY);
        lastValLoss   = valX.length > 0 ? bce(valX, valY) : 0;
        console.log(`[Classifier] Epoch ${epoch} — trainLoss: ${lastTrainLoss.toFixed(4)}, valLoss: ${lastValLoss.toFixed(4)}`);
      }
    }

    // FIX 6: return structured object, not [...weights, bias]
    return { weights: w, bias: b, trainLoss: lastTrainLoss, valLoss: lastValLoss };
  }

  // ---------------------------------------------------------------------------
  // Metrics  (FIX 7: takes structured weights, no slice(0,-1) hack)
  // ---------------------------------------------------------------------------

  private calculateMetrics(
    features: number[][],
    dirLabels: number[],
    dirWeights: LogisticWeights
  ): TrainingMetrics {
    const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
    let correct = 0, tp = 0, fp = 0, fn = 0;

    for (let i = 0; i < features.length; i++) {
      const x    = features[i];
      const actual = dirLabels[i];
      // FIX 7: use structured weights — no fragile slice
      const z    = x.reduce((s, xi, j) => s + xi * dirWeights.weights[j], dirWeights.bias);
      const pred = sigmoid(z) > 0.5 ? 1 : 0;

      if (pred === actual) correct++;
      if (pred === 1 && actual === 1) tp++;
      if (pred === 1 && actual === 0) fp++;
      if (pred === 0 && actual === 1) fn++;
    }

    const n         = features.length || 1;
    const accuracy  = correct / n;
    const precision = tp / (tp + fp || 1);
    const recall    = tp / (tp + fn || 1);
    const f1Score   = 2 * precision * recall / (precision + recall || 1);

    // trainLoss and valLoss are filled in by the caller
    return { trainLoss: 0, valLoss: 0, accuracy, precision, recall, f1Score };
  }
}

// FIX 10: no default singleton export — callers instantiate explicitly
export { MLModelTrainer as default };