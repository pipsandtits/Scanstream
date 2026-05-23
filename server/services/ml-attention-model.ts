/**
 * attention-sequence-model.ts
 *
 * Fixes vs. original:
 *  1.  Q/K/V weight matrices are [D×D] — proper linear projections, not unused
 *      flat vectors. calculateAttention uses W_q·q and W_k·k_i correctly.
 *  2.  outputWeights is a real [D_out × (2*D)] projection matrix used in
 *      predict(); it was declared but never used in the original.
 *  3.  train() implements real gradient descent through the attention mechanism:
 *      MSE loss on next-bar return → backprop through output projection →
 *      backprop through context vector → backprop through attention weights →
 *      weight updates for W_q, W_k, W_v, W_out.
 *  4.  All technical indicator helpers removed — imported from indicators.ts.
 *  5.  Frame field access normalised through a single toChartDataPoints()
 *      helper; no more scattered (f as any).price.close / Number(f.price) casts.
 *  6.  extractSequenceFeatures builds a fixed 10-element vector per bar using
 *      only indicators.ts primitives; orderFlow / marketMicrostructure fields
 *      are optional and default to 0 if absent.
 *  7.  predict() uses the trained W_out projection instead of the
 *      hard-coded alternating-sign dot-product hack.
 *  8.  Confidence is entropy-based exactly as before but clamped to [0, 1].
 *  9.  Weights are serialisable plain arrays for persistence.
 * 10.  Singleton default export removed.
 */

import type { MarketFrame } from '@shared/schema';
import {
  mean,
  standardDeviation,
  clamp,
  momentum,
  volatility,
  trendStrength,
  volumeRatio,
  atr,
} from '@shared/indicators';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttentionWeights {
  timeSteps: number[];
  weights:   number[];
  focus:     'recent' | 'historical' | 'balanced';
}

export interface AttentionPrediction {
  priceTarget:      number;
  confidence:       number;
  attentionWeights: AttentionWeights;
  interpretation:   string;
}

/** Serialisable weight snapshot for persistence */
export interface AttentionModelWeights {
  Wq:  number[][];   // [D × D]
  Wk:  number[][];
  Wv:  number[][];
  Wout: number[][];  // [1 × 2D]  (single output: next-bar return)
  featureDim: number;
}

// ---------------------------------------------------------------------------
// Matrix helpers (kept local — not generic enough for indicators.ts)
// ---------------------------------------------------------------------------

function matVec(M: number[][], v: number[]): number[] {
  return M.map(row => row.reduce((s, mij, j) => s + mij * v[j], 0));
}

function outerProduct(a: number[], b: number[]): number[][] {
  return a.map(ai => b.map(bj => ai * bj));
}

function addMatrices(A: number[][], B: number[][], scale = 1): number[][] {
  return A.map((row, i) => row.map((v, j) => v + scale * B[i][j]));
}

function randomMatrix(rows: number, cols: number, scale = 0.01): number[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => (Math.random() - 0.5) * scale)
  );
}

// ---------------------------------------------------------------------------
// Frame normalisation  (FIX 5)
// ---------------------------------------------------------------------------

interface NormalisedBar {
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  rsi:    number;
  macd:   number;
  netFlow: number;
  spread: number;
  toxicity: number;
}

function toNormalisedBar(f: any): NormalisedBar {
  const price = f.price && typeof f.price === 'object' ? f.price : null;
  return {
    open:    Number(price?.open   ?? f.open   ?? 0),
    high:    Number(price?.high   ?? f.high   ?? 0),
    low:     Number(price?.low    ?? f.low    ?? 0),
    close:   Number(price?.close  ?? f.close  ?? 0),
    volume:  Number(f.volume ?? 0),
    rsi:     Number(f.indicators?.rsi   ?? 50),
    macd:    Number(f.indicators?.macd?.histogram ?? f.indicators?.macd ?? 0),
    netFlow: Number(f.orderFlow?.netFlow ?? 0),
    spread:  Number(f.marketMicrostructure?.spread   ?? 0),
    toxicity:Number(f.marketMicrostructure?.toxicity ?? 0),
  };
}

// ---------------------------------------------------------------------------
// AttentionSequenceModel
// ---------------------------------------------------------------------------

export class AttentionSequenceModel {
  private readonly D:              number;   // feature dimension
  private readonly sequenceLength: number;
  private readonly lr:             number;   // learning rate
  private readonly lambda:         number;   // L2 regularisation

  // FIX 1: proper [D×D] projection matrices
  private Wq:   number[][];
  private Wk:   number[][];
  private Wv:   number[][];
  // FIX 2: real output projection [1 × 2D]
  private Wout: number[][];

  private isTrained = false;

  constructor(options: {
    featureDim?:     number;
    sequenceLength?: number;
    lr?:             number;
    lambda?:         number;
    weights?:        AttentionModelWeights;
  } = {}) {
    this.D              = options.featureDim     ?? 10;
    this.sequenceLength = options.sequenceLength ?? 50;
    this.lr             = options.lr             ?? 0.005;
    this.lambda         = options.lambda         ?? 0.001;

    if (options.weights) {
      this.Wq   = options.weights.Wq;
      this.Wk   = options.weights.Wk;
      this.Wv   = options.weights.Wv;
      this.Wout = options.weights.Wout;
      this.isTrained = true;
    } else {
      this.Wq   = randomMatrix(this.D, this.D);
      this.Wk   = randomMatrix(this.D, this.D);
      this.Wv   = randomMatrix(this.D, this.D);
      this.Wout = randomMatrix(1, 2 * this.D);  // single scalar output
    }
  }

  /** Export weights for persistence */
  getWeights(): AttentionModelWeights {
    return { Wq: this.Wq, Wk: this.Wk, Wv: this.Wv, Wout: this.Wout, featureDim: this.D };
  }

  // ---------------------------------------------------------------------------
  // Feature extraction  (FIX 4, 6)
  // ---------------------------------------------------------------------------

  private extractSequenceFeatures(frames: MarketFrame[]): number[][] {
    const bars = (frames as any[]).map(toNormalisedBar);
    const result: number[][] = [];

    for (let i = 20; i < bars.length; i++) {
      const window = bars.slice(i - 20, i + 1);
      const prices  = window.map(b => b.close);
      const volumes = window.map(b => b.volume);
      const highs   = window.map(b => b.high);
      const lows    = window.map(b => b.low);
      const closes  = prices;
      const cur     = bars[i];
      const p0      = prices[0] || 1;

      result.push([
        cur.close,                                               // 0: raw price
        (cur.close - p0) / p0,                                  // 1: 20-bar return
        (Math.max(...highs) / (cur.close || 1)) - 1,            // 2: dist to high
        1 - (Math.min(...lows)  / (cur.close || 1)),            // 3: dist to low
        volumeRatio(volumes),                                    // 4: vol ratio
        cur.rsi / 100,                                          // 5: RSI normalised
        cur.macd,                                               // 6: MACD histogram
        cur.volume === 0 ? 0 : cur.netFlow / cur.volume,        // 7: net flow ratio
        cur.spread,                                             // 8: spread
        cur.toxicity,                                           // 9: toxicity
      ]);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Attention forward pass  (FIX 1)
  // ---------------------------------------------------------------------------

  /**
   * Scaled dot-product attention using learned Q/K/V projections.
   * Returns attention weights and the context vector.
   */
  private attend(query: number[], keys: number[][]): {
    attnWeights: number[];
    context:     number[];
  } {
    // FIX 1: project query and keys through learned matrices
    const q = matVec(this.Wq, query);

    const scores = keys.map(k => {
      const kProj = matVec(this.Wk, k);
      return q.reduce((s, qi, i) => s + qi * kProj[i], 0) / Math.sqrt(this.D);
    });

    // Numerically stable softmax
    const maxS   = Math.max(...scores);
    const exps   = scores.map(s => Math.exp(s - maxS));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const attnWeights = exps.map(e => e / (sumExp || 1));

    // Weighted sum of value projections
    const context = new Array(this.D).fill(0);
    for (let i = 0; i < keys.length; i++) {
      const v = matVec(this.Wv, keys[i]);
      for (let d = 0; d < this.D; d++) context[d] += attnWeights[i] * v[d];
    }

    return { attnWeights, context };
  }

  // ---------------------------------------------------------------------------
  // Prediction  (FIX 2, 7, 8)
  // ---------------------------------------------------------------------------

  async predict(frames: MarketFrame[]): Promise<AttentionPrediction> {
    if (frames.length < this.sequenceLength) {
      throw new Error(
        `Insufficient data: need ${this.sequenceLength} frames, got ${frames.length}`
      );
    }

    const seqFeatures = this.extractSequenceFeatures(frames);
    const recent      = seqFeatures.slice(-this.sequenceLength);
    const query       = recent[recent.length - 1];
    const keys        = recent.slice(0, -1);

    const { attnWeights, context } = this.attend(query, keys);

    // FIX 7: use Wout projection instead of alternating-sign hack
    const combined   = [...query, ...context];          // length 2D
    const rawChange  = matVec(this.Wout, combined)[0];  // single scalar
    const priceChange = Math.tanh(rawChange);            // squash to (-1, 1)

    const lastBar = toNormalisedBar(frames[frames.length - 1] as any);
    const currentPrice = lastBar.close;
    const priceTarget  = currentPrice * (1 + priceChange * 0.05); // ±5% max

    // FIX 8: entropy-based confidence, clamped
    const entropy    = attnWeights.reduce((s, w) => s - (w > 0 ? w * Math.log(w) : 0), 0);
    const maxEntropy = Math.log(attnWeights.length || 1);
    const confidence = clamp(1 - (maxEntropy > 0 ? entropy / maxEntropy : 0), 0, 1);

    const recentWeight = attnWeights.slice(-10).reduce((a, b) => a + b, 0);
    const focus: AttentionWeights['focus'] =
      recentWeight > 0.6 ? 'recent' :
      recentWeight < 0.4 ? 'historical' : 'balanced';

    const interpretation =
      focus === 'recent'     ? 'Model focusing on recent price action' :
      focus === 'historical' ? 'Model detecting pattern from historical data' :
                               'Model balancing recent and historical signals';

    return {
      priceTarget,
      confidence,
      attentionWeights: {
        timeSteps: attnWeights.map((_, i) => i),
        weights:   attnWeights,
        focus
      },
      interpretation
    };
  }

  // ---------------------------------------------------------------------------
  // Training  (FIX 3: real backprop through attention)
  // ---------------------------------------------------------------------------

  /**
   * Trains on all valid windows in `frames`.
   * Loss: MSE on next-bar log return.
   * Backprop: output layer → context/query concat → Wv, Wk, Wq.
   */
  async train(frames: MarketFrame[], epochs = 10): Promise<void> {
    const seqFeatures = this.extractSequenceFeatures(frames);
    if (seqFeatures.length < this.sequenceLength + 1) {
      throw new Error(`Need at least ${this.sequenceLength + 1} feature frames to train`);
    }

    console.log(`[Attention] Training on ${seqFeatures.length} bars, ${epochs} epoch(s)`);

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;
      let count     = 0;

      for (let t = this.sequenceLength; t < seqFeatures.length - 1; t++) {
        const recent = seqFeatures.slice(t - this.sequenceLength + 1, t + 1);
        const query  = recent[recent.length - 1];
        const keys   = recent.slice(0, -1);

        const { attnWeights, context } = this.attend(query, keys);
        const combined  = [...query, ...context];
        const rawOut    = matVec(this.Wout, combined)[0];
        const predicted = Math.tanh(rawOut) * 0.05;

        // Label: actual next-bar return (clamped to ±5%)
        const p0 = seqFeatures[t][0];     // current close (feature 0)
        const p1 = seqFeatures[t + 1][0]; // next close
        const actual = p0 === 0 ? 0 : clamp((p1 - p0) / p0, -0.05, 0.05);

        const loss  = (predicted - actual) ** 2;
        totalLoss  += loss;
        count++;

        // --- Backprop ---
        // dL/d(predicted) = 2(predicted - actual)
        const dLdPred = 2 * (predicted - actual);

        // dL/d(rawOut) = dL/dPred * d(tanh(rawOut)*0.05)/d(rawOut)
        const dLdRaw  = dLdPred * 0.05 * (1 - Math.tanh(rawOut) ** 2);

        // dL/dWout = dLdRaw * combined^T  (outer product, 1 row)
        const dWout = [combined.map(c => dLdRaw * c)];

        // dL/d(combined) = dLdRaw * Wout[0]
        const dCombined = this.Wout[0].map(w => dLdRaw * w);
        const dQuery  = dCombined.slice(0, this.D);
        const dContext = dCombined.slice(this.D);

        // dL/dWv: dContext flows through weighted sum over keys
        let dWv = randomMatrix(this.D, this.D, 0); // zero init
        for (let i = 0; i < keys.length; i++) {
          const kv  = matVec(this.Wv, keys[i]);
          // dL/dWv += attn[i] * dContext ⊗ keys[i]
          const dWvi = outerProduct(dContext.map(dc => attnWeights[i] * dc), keys[i]);
          dWv = addMatrices(dWv, dWvi);
        }

        // dL/d(attn[i]) = dContext · v_i  for each i
        const dAttn = keys.map(k => {
          const v = matVec(this.Wv, k);
          return dContext.reduce((s, dc, d) => s + dc * v[d], 0);
        });

        // Backprop through softmax: d(scores) = softmax_jacobian * dAttn
        const dScores = attnWeights.map((ai, i) =>
          attnWeights.reduce((s, aj, j) => s + (i === j ? ai * (1 - ai) : -ai * aj) * dAttn[j], 0)
        );

        // dL/dWq: d(score_i)/d(q) = W_k * key_i / sqrt(D)
        // => dL/dWq = sum_i dScores[i] * outer( Wk*keys[i] / sqrt(D), query )
        let dWq = randomMatrix(this.D, this.D, 0);
        let dWk = randomMatrix(this.D, this.D, 0);

        const qProj = matVec(this.Wq, query);
        for (let i = 0; i < keys.length; i++) {
          const kProj = matVec(this.Wk, keys[i]);
          const scale = dScores[i] / Math.sqrt(this.D);

          // dWq: gradient w.r.t. Wq from d(q·k)/dWq = k ⊗ query
          const dWqi = outerProduct(kProj.map(kp => scale * kp), query);
          dWq = addMatrices(dWq, dWqi);

          // dWk: gradient w.r.t. Wk from d(q·k)/dWk = q ⊗ key
          const dWki = outerProduct(qProj.map(qp => scale * qp), keys[i]);
          dWk = addMatrices(dWk, dWki);
        }

        // Apply updates with L2 regularisation
        this.Wout = addMatrices(
          this.Wout, dWout,
          -(this.lr / (keys.length || 1))
        );
        this.Wout = this.Wout.map(row => row.map(w => w * (1 - this.lr * this.lambda)));

        const batchScale = -(this.lr / (keys.length || 1));
        this.Wq = addMatrices(this.Wq, dWq, batchScale);
        this.Wk = addMatrices(this.Wk, dWk, batchScale);
        this.Wv = addMatrices(this.Wv, dWv, batchScale);
        [this.Wq, this.Wk, this.Wv] = [this.Wq, this.Wk, this.Wv].map(W =>
          W.map(row => row.map(w => w * (1 - this.lr * this.lambda)))
        );
      }

      const avgLoss = count > 0 ? totalLoss / count : 0;
      console.log(`[Attention] Epoch ${epoch + 1}/${epochs} — MSE: ${avgLoss.toFixed(6)}`);
    }

    this.isTrained = true;
    console.log('[Attention] Training complete');
  }
}

// FIX 10: no default singleton — callers instantiate explicitly
export default AttentionSequenceModel;