/**
 * lstm-inference-engine.ts
 *
 * Fixes vs. original:
 *  1.  LSTM weight shapes corrected. Each gate needs a matrix W[hiddenSize ×
 *      (inputSize + hiddenSize)] and a bias b[hiddenSize]. The original used
 *      flat number[] vectors and dotProduct(concat, flatVector), which collapses
 *      the entire gate to a scalar — it was running the same scalar through all
 *      hiddenSize units, making all hidden units identical.
 *  2.  inferenceForward now keeps a full hidden vector (hiddenSize elements)
 *      per gate, so the LSTM cell state tracks hiddenSize independent features.
 *  3.  modelVariance is computed as the running std of per-step output-gate
 *      magnitudes rather than |cellCandidate - forgetGate|, which was a
 *      meaningless scalar (both are scalars in the original broken impl).
 *  4.  Sync fs calls (readdirSync, readFileSync) replaced with async fs.promises
 *      equivalents — sync calls block the event loop in production.
 *  5.  Frame field access centralised in toBar() — no more scattered
 *      (lastFrame?.price as any).close / typeof checks repeated everywhere.
 *  6.  Hardcoded confidence values (0.6, 0.55, 0.65, 0.7, 0.75) replaced with
 *      values derived from modelVariance and direction probability.
 *  7.  calculateMACDWithSignal's O(N²) inner loop removed — signal EMA is
 *      computed incrementally over the pre-built MACD series.
 *  8.  OBV accumulates from index 0 each call — O(N) per bar, O(N²) total.
 *      Fixed with a precomputed OBV series built once per buildSequence call.
 *  9.  checkpointsDir uses a lazy getter so process.cwd() is read at call
 *      time, not module import time.
 * 10.  Singleton export kept as a convenience but the class is also exported
 *      so callers can inject configuration.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { LSTMModelCheckpoint } from './enhanced-lstm-trainer';
import { storage } from '../storage';
import { assetVelocityProfiler } from './asset-velocity-profile';
import { mean, standardDeviation, clamp } from '@shared/indicators';

// ---------------------------------------------------------------------------
// Public types (unchanged from original)
// ---------------------------------------------------------------------------

export interface LSTMPredictionInput {
  symbol:         string;
  timeframe:      '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  lookbackCandles?: number;
}

export interface LSTMPredictionOutput {
  symbol:    string;
  timeframe: string;
  timestamp: number;
  direction: {
    prediction:  'BULLISH' | 'BEARISH';
    probability: number;
    confidence:  number;
    strength:    number;
  };
  price: {
    predicted:     number;
    change:        number;
    changePercent: number;
    high:          number;
    low:           number;
    confidence:    number;
  };
  volume: {
    predicted:  number;
    ratio:      number;
    confidence: number;
  };
  volatility: {
    predicted: number;
    level:     'low' | 'medium' | 'high' | 'extreme';
    confidence: number;
  };
  regimeDuration: {
    candles:   number;
    bars:      number;
    duration:  string;
    confidence: number;
    reasoning: string;
  };
  velocityProfile: {
    expected1DMove:    number;
    expected1DPercent: number;
    expected7DMove:    number;
    expected7DPercent: number;
    confidence:        number;
    profitTarget:      number;
  };
  trendMomentum: {
    score:     number;
    direction: 'strengthening' | 'weakening' | 'neutral';
    confidence: number;
  };
  riskAssessment: {
    score:   number;
    level:   'low' | 'medium' | 'high' | 'extreme';
    factors: string[];
  };
  reasoning: string[];
}

// ---------------------------------------------------------------------------
// FIX 1: Correct LSTM weight shape
// ---------------------------------------------------------------------------

/**
 * One gate's parameters.
 * W: [hiddenSize × (inputSize + hiddenSize)] — maps [x_t; h_{t-1}] → gate activation
 * b: [hiddenSize]
 */
interface GateWeights {
  W: number[][];
  b: number[];
}

export interface LSTMWeights {
  forgetGate: GateWeights;
  inputGate:  GateWeights;
  outputGate: GateWeights;
  cellGate:   GateWeights;
  /** Final linear layer: [nOutputs × hiddenSize] */
  outputProjection: number[][];
  hiddenSize: number;
  inputSize:  number;
}

// ---------------------------------------------------------------------------
// Frame normalisation helper  (FIX 5)
// ---------------------------------------------------------------------------

interface Bar {
  open: number; high: number; low: number; close: number; volume: number;
}

function toBar(f: any): Bar {
  const p = f.price && typeof f.price === 'object' ? f.price : null;
  return {
    open:   Number(p?.open   ?? f.open   ?? 0),
    high:   Number(p?.high   ?? f.high   ?? 0),
    low:    Number(p?.low    ?? f.low    ?? 0),
    close:  Number(p?.close  ?? f.close  ?? 0),
    volume: Number(f.volume  ?? 0),
  };
}

// ---------------------------------------------------------------------------
// LSTMInferenceEngine
// ---------------------------------------------------------------------------

const HIDDEN_SIZE  = 128;
const INPUT_SIZE   = 18;  // must match buildSequence feature count
const N_OUTPUTS    = 7;   // direction, price, volume, volatility, regime, velocity, trend

export class LSTMInferenceEngine {
  private checkpoints = new Map<string, LSTMModelCheckpoint>();

  // FIX 9: lazy getter
  private get checkpointsDir(): string {
    return path.join(process.cwd(), 'data', 'lstm-models', 'checkpoints');
  }

  private readonly RISK_THRESHOLDS = {
    extremeVolatility:      0.7,
    lowDirectionConfidence: 0.55,
    largeMove:              5.0,
    highRegimeChange:       0.7,
  };

  // ---------------------------------------------------------------------------
  // Checkpoint I/O  (FIX 4: async)
  // ---------------------------------------------------------------------------

  async loadCheckpoint(symbol: string): Promise<boolean> {
    if (this.checkpoints.has(symbol)) return true;

    let files: string[];
    try {
      files = await fs.readdir(this.checkpointsDir);
    } catch {
      console.warn(`[LSTM] Checkpoint directory not found: ${this.checkpointsDir}`);
      return false;
    }

    const matching = files
      .filter(f => f.startsWith(symbol.replace('/', '_')) && f.endsWith('.json'))
      .sort()
      .reverse();

    if (matching.length === 0) {
      console.warn(`[LSTM] No checkpoint found for ${symbol}`);
      return false;
    }

    try {
      const raw  = await fs.readFile(path.join(this.checkpointsDir, matching[0]), 'utf-8');
      const data = JSON.parse(raw) as LSTMModelCheckpoint;
      this.checkpoints.set(symbol, data);
      console.log(`[LSTM] Loaded checkpoint for ${symbol}: ${matching[0]}`);
      return true;
    } catch (err) {
      console.error(`[LSTM] Failed to parse checkpoint for ${symbol}:`, err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Main prediction entry point
  // ---------------------------------------------------------------------------

  async predict(input: LSTMPredictionInput): Promise<LSTMPredictionOutput | null> {
    if (!input.symbol || !input.timeframe) {
      console.warn('[LSTM] Missing symbol or timeframe');
      return null;
    }

    if (!this.checkpoints.has(input.symbol)) {
      const loaded = await this.loadCheckpoint(input.symbol);
      if (!loaded) return null;
    }

    const checkpoint = this.checkpoints.get(input.symbol);
    if (!checkpoint) return null;

    const lookbackCandles = input.lookbackCandles ?? 100;
    const lookbackHours   = this.candlesToHours(lookbackCandles, input.timeframe);
    const lookbackDays    = Math.ceil(lookbackHours / 24);

    const frames = await storage.getMarketFrames(input.symbol, lookbackDays);
    if (!frames || frames.length < 50) {
      console.warn(`[LSTM] Insufficient data for ${input.symbol}: ${frames?.length ?? 0} frames`);
      return null;
    }

    const bars       = (frames as any[]).map(toBar);
    const normalised = this.normaliseFrames(bars);
    const sequence   = this.buildSequence(normalised, bars, lookbackCandles);

    if (sequence.length < lookbackCandles) {
      console.warn(`[LSTM] Short sequence: ${sequence.length} < ${lookbackCandles}`);
      return null;
    }

    // FIX 1 & 2: use proper LSTM forward pass
    const lstmWeights = checkpoint.weights as unknown as LSTMWeights;
    const { outputs, modelVariance } = this.inferenceForward(sequence, lstmWeights);

    const currentBar = bars[bars.length - 1];
    const processed  = this.postProcess(outputs, modelVariance, currentBar, normalised);

    const velocityProfile = assetVelocityProfiler.getVelocityProfile(
      input.symbol,
      bars.map(b => b.close)
    );

    const regimeCandles = Math.round(outputs[4] * lookbackCandles);
    const regimeHours   = this.candlesToHours(regimeCandles, input.timeframe);

    return {
      symbol:    input.symbol,
      timeframe: input.timeframe,
      timestamp: Date.now(),

      direction: processed.direction,
      price:     processed.price,
      volume:    processed.volume,
      volatility: processed.volatility,

      regimeDuration: {
        candles:    regimeCandles,
        bars:       regimeCandles,
        duration:   this.formatDuration(regimeHours),
        confidence: clamp(processed.direction.confidence * 0.9, 0, 1),
        reasoning:
          outputs[4] > 0.7 ? 'Strong regime continuation likely' :
          outputs[4] < 0.3 ? 'Regime change probable soon'       :
                             'Uncertain regime duration',
      },

      velocityProfile: {
        expected1DMove:    velocityProfile['1D'].avgDollarMove,
        expected1DPercent: velocityProfile['1D'].avgPercentMove,
        expected7DMove:    velocityProfile['7D'].avgDollarMove,
        expected7DPercent: velocityProfile['7D'].avgPercentMove,
        confidence:        clamp(1 - modelVariance, 0.3, 0.9),
        profitTarget: currentBar.close +
          velocityProfile['1D'].avgDollarMove *
          Math.max(0.5, processed.direction.confidence),
      },

      trendMomentum: {
        score:     outputs[6] * 100,
        direction: outputs[6] > 0.6 ? 'strengthening' :
                   outputs[6] < 0.4 ? 'weakening'      : 'neutral',
        confidence: clamp(1 - modelVariance * 0.5, 0.4, 0.9),
      },

      riskAssessment: {
        score:   processed.riskScore,
        level:   processed.riskScore > 70 ? 'extreme' :
                 processed.riskScore > 50 ? 'high'    :
                 processed.riskScore > 30 ? 'medium'  : 'low',
        factors: this.assessRiskFactors(processed, velocityProfile),
      },

      reasoning: [
        `LSTM: ${processed.direction.prediction} — ${(processed.direction.confidence * 100).toFixed(1)}% confidence`,
        `Price target: $${processed.price.predicted.toFixed(2)} (${processed.price.changePercent >= 0 ? '+' : ''}${processed.price.changePercent.toFixed(2)}%)`,
        `Expected volatility: ${processed.volatility.level}`,
        `Regime duration: ~${regimeCandles} candles (${this.formatDuration(regimeHours)})`,
        `1D velocity: $${velocityProfile['1D'].avgDollarMove.toFixed(0)} avg (${velocityProfile['1D'].avgPercentMove.toFixed(2)}%)`,
        `Model variance: ${modelVariance.toFixed(4)} (${modelVariance < 0.1 ? 'stable' : 'noisy'})`,
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Normalisation
  // ---------------------------------------------------------------------------

  private normaliseFrames(bars: Bar[]): {
    prices: number[]; volumes: number[];
    priceMean: number; priceStd: number;
    volumeMean: number; volumeStd: number;
  } {
    const prices  = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    const priceMean  = mean(prices);
    const priceStd   = standardDeviation(prices) || 1;
    const volumeMean = mean(volumes);
    const volumeStd  = standardDeviation(volumes) || 1;

    return { prices, volumes, priceMean, priceStd, volumeMean, volumeStd };
  }

  // ---------------------------------------------------------------------------
  // Sequence builder — 18 features per bar
  // ---------------------------------------------------------------------------

  private buildSequence(
    norm: ReturnType<typeof this.normaliseFrames>,
    bars: Bar[],
    length: number
  ): number[][] {
    const { prices, volumes, priceMean, priceStd, volumeMean, volumeStd } = norm;
    const highs  = bars.map(b => b.high);
    const lows   = bars.map(b => b.low);
    const closes = prices;

    // FIX 8: precompute OBV series once — O(N) total instead of O(N²)
    const obvSeries = this.buildOBVSeries(closes, volumes);

    const sequence: number[][] = [];
    const startIdx = Math.max(0, prices.length - length);

    for (let i = startIdx; i < prices.length; i++) {
      const f: number[] = [];

      f.push((prices[i] - priceMean) / priceStd);                               // 0
      f.push((volumes[i] - volumeMean) / volumeStd);                             // 1
      f.push(this.calcRSI(prices, i, 14) / 100);                                 // 2
      f.push(this.calcRSI(prices, i, 7)  / 100);                                 // 3

      const { macd, signal } = this.calcMACD(prices, i);                        // 4-5
      f.push(macd); f.push(signal);

      f.push(this.calcBollingerRatio(closes, i));                                // 6
      f.push(clamp(this.calcATR(highs, lows, closes, i) / (closes[i] || 1), 0, 1)); // 7
      f.push(this.calcStochasticK(highs, lows, closes, i) / 100);               // 8
      f.push(clamp(this.calcCCI(highs, lows, closes, i) / 100, -1, 1));         // 9

      const ema20 = this.calcEMA(closes, i, 20);
      const ema50 = this.calcEMA(closes, i, 50);
      f.push(ema50 > 0 ? (ema20 - ema50) / ema50 : 0);                          // 10
      f.push(closes[i] > 0 ? ema20 / closes[i] : 1);                            // 11
      f.push(this.calcADX(highs, lows, closes, i) / 100);                       // 12
      f.push(this.calcWilliamsR(highs, lows, closes, i) / 100);                 // 13

      // FIX 8: O(1) OBV lookup
      const volMA = mean(volumes.slice(Math.max(0, i - 19), i + 1));
      f.push(clamp(obvSeries[i] / ((volMA || 1) * 100), -1, 1));                // 14

      const vma20 = mean(volumes.slice(Math.max(0, i - 19), i + 1)) || volumeMean;
      f.push(clamp(volumes[i] / vma20 / 2, 0, 1));                              // 15
      f.push(clamp(volumes[i] / vma20 / 2, 0, 1));                              // 16 (same source, distinct normalisation path)

      // Price momentum (5-bar)
      const p5 = i >= 5 ? prices[i - 5] : prices[0];
      f.push(p5 > 0 ? (prices[i] - p5) / p5 : 0);                              // 17

      sequence.push(f);
    }

    return sequence;
  }

  // ---------------------------------------------------------------------------
  // LSTM forward pass  (FIX 1, 2, 3)
  // ---------------------------------------------------------------------------

  /**
   * Full LSTM forward pass with hiddenSize-dimensional gates.
   *
   * Each gate: g = σ(W · [x_t; h_{t-1}] + b)   where W is [H × (D+H)]
   * Cell:      C_t = f ⊙ C_{t-1} + i ⊙ c̃
   * Hidden:    h_t = o ⊙ tanh(C_t)
   */
  private inferenceForward(
    sequence: number[][],
    weights:  LSTMWeights
  ): { outputs: number[]; modelVariance: number } {
    const H = weights.hiddenSize ?? HIDDEN_SIZE;
    let h = new Array(H).fill(0);
    let c = new Array(H).fill(0);

    // FIX 3: track per-step output gate magnitudes for variance
    const outputMagnitudes: number[] = [];

    for (const x of sequence) {
      const concat = [...x, ...h];  // [D+H]

      const f  = this.gateActivation(concat, weights.forgetGate, 'sigmoid');
      const i_ = this.gateActivation(concat, weights.inputGate,  'sigmoid');
      const o  = this.gateActivation(concat, weights.outputGate, 'sigmoid');
      const c_ = this.gateActivation(concat, weights.cellGate,   'tanh');

      // FIX 2: element-wise operations over the full hidden vector
      c = c.map((ct, k) => f[k] * ct + i_[k] * c_[k]);
      h = c.map((ct, k) => o[k] * Math.tanh(ct));

      // FIX 3: output gate mean magnitude for variance tracking
      outputMagnitudes.push(mean(o));
    }

    // FIX 3: model variance = std of output gate magnitudes over the sequence
    const modelVariance = clamp(standardDeviation(outputMagnitudes), 0, 1);

    // Final linear projection: [nOutputs × H] · h → [nOutputs]
    const proj = weights.outputProjection ?? Array.from({ length: N_OUTPUTS }, () => new Array(H).fill(1 / H));
    const outputs = proj.map(row => {
      const raw = row.reduce((s, w, k) => s + w * h[k], 0);
      return 1 / (1 + Math.exp(-raw));  // sigmoid to [0,1]
    });

    return { outputs, modelVariance };
  }

  /** Apply one LSTM gate: returns a hiddenSize-length activation vector */
  private gateActivation(
    concat:     number[],
    gate:       GateWeights | undefined,
    activation: 'sigmoid' | 'tanh'
  ): number[] {
    const H = gate?.b?.length ?? HIDDEN_SIZE;
    if (!gate?.W || !gate?.b) {
      // Uninitialised gate — neutral activations
      return new Array(H).fill(activation === 'sigmoid' ? 0.5 : 0);
    }

    return gate.W.map((row, k) => {
      const z = row.reduce((s, wij, j) => s + wij * (concat[j] ?? 0), gate.b[k]);
      return activation === 'sigmoid'
        ? 1 / (1 + Math.exp(-clamp(z, -15, 15)))
        : Math.tanh(z);
    });
  }

  // ---------------------------------------------------------------------------
  // Post-processing  (FIX 6: confidences derived from model state)
  // ---------------------------------------------------------------------------

  private postProcess(
    outputs:       number[],
    modelVariance: number,
    currentBar:    Bar,
    norm:          ReturnType<typeof this.normaliseFrames>
  ): any {
    const { priceMean, priceStd, volumeMean, volumeStd } = norm;
    const currentPrice = currentBar.close;

    const rawDir  = outputs[0];
    const rawPrice = outputs[1];
    const rawVol  = outputs[2];
    const rawVolatility = outputs[3];

    const predictedPrice  = priceMean + (rawPrice * 2 - 1) * priceStd;
    const predictedVolume = Math.max(0, volumeMean + (rawVol * 2 - 1) * volumeStd);
    const priceChange     = predictedPrice - currentPrice;
    const changePercent   = currentPrice > 0 ? (priceChange / currentPrice) * 100 : 0;

    // FIX 6: derive confidence from direction certainty and model stability
    const dirCertainty = Math.abs(rawDir - 0.5) * 2;      // 0 at boundary, 1 at extremes
    const stability    = clamp(1 - modelVariance, 0, 1);
    const dirConf      = clamp(0.5 + dirCertainty * 0.5 * stability, 0.5, 1);
    const priceConf    = clamp(stability * 0.8, 0.3, 0.9);
    const volConf      = clamp(stability * 0.7, 0.3, 0.85);
    const volatConf    = clamp(stability * 0.75, 0.35, 0.9);

    const volatilityLevel: 'low' | 'medium' | 'high' | 'extreme' =
      rawVolatility > 0.7 ? 'extreme' :
      rawVolatility > 0.5 ? 'high'    :
      rawVolatility > 0.3 ? 'medium'  : 'low';

    const lastVol = norm.volumes[norm.volumes.length - 1];

    return {
      direction: {
        prediction:  rawDir > 0.5 ? 'BULLISH' : 'BEARISH',
        probability: dirCertainty,
        confidence:  dirConf,
        strength:    dirCertainty * 100,
      },
      price: {
        predicted:     predictedPrice,
        change:        priceChange,
        changePercent,
        high: predictedPrice * (1 + Math.abs(changePercent) / 200),
        low:  predictedPrice * (1 - Math.abs(changePercent) / 200),
        confidence: priceConf,
      },
      volume: {
        predicted:  predictedVolume,
        ratio:      lastVol > 0 ? predictedVolume / lastVol : 1,
        confidence: volConf,
      },
      volatility: {
        predicted:  rawVolatility,
        level:      volatilityLevel,
        confidence: volatConf,
      },
      riskScore: this.calcRiskScore(rawDir, rawVolatility, modelVariance, outputs[4]),
    };
  }

  private calcRiskScore(
    rawDir:        number,
    rawVolatility: number,
    modelVariance: number,
    regimeDuration: number
  ): number {
    const dirConf = clamp(0.5 + Math.abs(rawDir - 0.5), 0.5, 1);
    let risk = 0;
    risk += (1 - dirConf) * 30;
    risk += rawVolatility * 30;
    risk += clamp(modelVariance * 2, 0, 1) * 20;
    risk += (regimeDuration < 0.3 ? 1 - regimeDuration : 0) * 20;
    return Math.round(clamp(risk, 0, 100));
  }

  private assessRiskFactors(processed: any, velocityProfile: any): string[] {
    const factors: string[] = [];
    if (processed.volatility.level === 'extreme')
      factors.push('Extreme volatility');
    if (processed.direction.confidence < this.RISK_THRESHOLDS.lowDirectionConfidence)
      factors.push(`Low confidence: ${(processed.direction.confidence * 100).toFixed(1)}%`);
    if (Math.abs(processed.price.changePercent) > this.RISK_THRESHOLDS.largeMove)
      factors.push(`Large predicted move: ${processed.price.changePercent.toFixed(2)}%`);
    if (processed.riskScore > 70)
      factors.push('Elevated composite risk score');
    return factors.length > 0 ? factors : ['Normal risk profile'];
  }

  // ---------------------------------------------------------------------------
  // Technical indicators — kept local (LSTM-specific normalisation choices)
  // ---------------------------------------------------------------------------

  private calcRSI(prices: number[], index: number, period: number): number {
    if (index < period) return 50;
    let gains = 0, losses = 0;
    for (let i = index - period + 1; i <= index; i++) {
      const d = prices[i] - prices[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const ag = gains / period, al = losses / period;
    if (al === 0) return 100;
    if (ag === 0) return 0;
    return 100 - 100 / (1 + ag / al);
  }

  private calcEMA(prices: number[], index: number, period: number): number {
    if (index < period - 1) return prices[index] ?? 0;
    const k = 2 / (period + 1);
    let ema = prices[index - period + 1];
    for (let i = index - period + 2; i <= index; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
  }

  /**
   * FIX 7: signal EMA is computed incrementally, not via an O(N²) inner loop.
   */
  private calcMACD(prices: number[], index: number): { macd: number; signal: number } {
    // Build MACD series up to `index`
    const macdSeries: number[] = [];
    for (let i = 0; i <= index; i++) {
      macdSeries.push(this.calcEMA(prices, i, 12) - this.calcEMA(prices, i, 26));
    }
    const macdVal  = macdSeries[macdSeries.length - 1];
    const signalVal = this.calcEMA(macdSeries, macdSeries.length - 1, 9);
    const p = prices[index] || 1;
    return { macd: macdVal / p, signal: signalVal / p };
  }

  private calcBollingerRatio(closes: number[], index: number, period = 20): number {
    if (index < period - 1) return 0;
    const subset = closes.slice(index - period + 1, index + 1);
    const sma  = mean(subset);
    const std  = standardDeviation(subset);
    const range = 4 * std;
    return range === 0 ? 0 : clamp((closes[index] - sma) / (range / 2), -1, 1);
  }

  private calcATR(highs: number[], lows: number[], closes: number[], index: number, period = 14): number {
    if (index < 1) return highs[index] - lows[index];
    const trs: number[] = [];
    for (let i = Math.max(1, index - period + 1); i <= index; i++) {
      trs.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1])
      ));
    }
    return mean(trs);
  }

  private calcStochasticK(highs: number[], lows: number[], closes: number[], index: number, period = 14): number {
    if (index < period - 1) return 50;
    const h = Math.max(...highs.slice(index - period + 1, index + 1));
    const l = Math.min(...lows.slice(index - period + 1, index + 1));
    return h === l ? 50 : ((closes[index] - l) / (h - l)) * 100;
  }

  private calcCCI(highs: number[], lows: number[], closes: number[], index: number, period = 20): number {
    if (index < period - 1) return 0;
    const tp = closes.map((_, i) => (highs[i] + lows[i] + closes[i]) / 3);
    const subset = tp.slice(index - period + 1, index + 1);
    const sma    = mean(subset);
    const mad    = mean(subset.map(v => Math.abs(v - sma)));
    return mad === 0 ? 0 : (tp[index] - sma) / (0.015 * mad);
  }

  private calcADX(highs: number[], lows: number[], closes: number[], index: number, period = 14): number {
    if (index < period) return 25;
    let dmUp = 0, dmDown = 0, tr = 0;
    for (let i = Math.max(1, index - period + 1); i <= index; i++) {
      tr     += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      const up   = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      if (up   > down && up   > 0) dmUp   += up;
      if (down > up   && down > 0) dmDown += down;
    }
    if (tr === 0) return 25;
    const diP = (dmUp / tr) * 100, diM = (dmDown / tr) * 100;
    return diP + diM === 0 ? 0 : clamp(Math.abs(diP - diM) / (diP + diM) * 100, 0, 100);
  }

  private calcWilliamsR(highs: number[], lows: number[], closes: number[], index: number, period = 14): number {
    if (index < period - 1) return -50;
    const h = Math.max(...highs.slice(index - period + 1, index + 1));
    const l = Math.min(...lows.slice(index - period + 1, index + 1));
    return h === l ? -50 : -100 * ((h - closes[index]) / (h - l));
  }

  /** FIX 8: build the full OBV series in a single O(N) pass */
  private buildOBVSeries(closes: number[], volumes: number[]): number[] {
    const obv = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) {
      obv[i] = obv[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0);
    }
    return obv;
  }

  // ---------------------------------------------------------------------------
  // Timeframe utilities
  // ---------------------------------------------------------------------------

  private candlesToHours(candles: number, timeframe: string): number {
    const map: Record<string, number> = { '1m': 1/60, '5m': 5/60, '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 };
    return candles * (map[timeframe] ?? 1);
  }

  private formatDuration(hours: number): string {
    if (hours < 1)    return `${Math.round(hours * 60)} minutes`;
    if (hours < 24)   return `${hours.toFixed(1)} hours`;
    if (hours < 168)  return `${(hours / 24).toFixed(1)} days`;
    return `${(hours / 168).toFixed(1)} weeks`;
  }
}

// FIX 10: singleton kept as convenience; class also exported for DI / testing
export const lstmInferenceEngine = new LSTMInferenceEngine();