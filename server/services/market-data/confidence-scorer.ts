/**
 * 🎯 MODE-AWARE CONFIDENCE SCORER
 * 
 * Key insight: Don't penalize confidence in LIVE mode
 * 
 * Phases:
 * 1. REPLAY (historical backfill): Confidence = 0 (data is old)
 * 2. MIXED (backfill + live): Confidence = capped (wait for LIVE to rise)
 * 3. LIVE (pure WS + filled memory): Confidence = natural rise (allow it!)
 * 
 * This prevents the false confidence penalty in live trading.
 */

import { OperationMode } from '../../types/market-data';
import type { WorldTick } from '../../types/market-data';
import { getModeDetector } from './mode-detector';

export interface ConfidenceScoreResult {
  /** Raw confidence (before mode adjustment) */
  raw: number;

  /** Mode-adjusted confidence */
  adjusted: number;

  /** Why was it adjusted? */
  reason: string;

  /** Current operation mode */
  mode: OperationMode;

  /** Should trading proceed? */
  canTrade: boolean;
}

export class ModeAwareConfidenceScorer {
  private static instance: ModeAwareConfidenceScorer;

  /**
   * Confidence thresholds by mode
   */
  private thresholds: Record<OperationMode, number>;

  /**
   * Configuration knobs (runtime adjustable)
   */
  private config = {
    liveMinimumFloor: 0.25, // minimum allowed confidence in LIVE
    mixedStalenessWindowMs: 60_000, // time delta that fully penalizes in MIXED
    momentumHistorySize: 5, // number of recent ticks to use for momentum
    momentumWeight: 0.25, // how strongly momentum affects adjusted confidence
    sourceWeights: {
      RL: 1.1,
      scanner: 1.0,
      ml: 1.05,
      default: 1.0,
    } as Record<string, number>,
  };

  // per-symbol recent raw confidence history for momentum calculations
  private recentConfidence: Map<string, number[]> = new Map();

  // last emit time per symbol for staleness calculations
  private lastEmitTime: Map<string, number> = new Map();

  constructor(initialThresholds?: Partial<Record<OperationMode, number>>) {
    // default thresholds
    this.thresholds = {
      [OperationMode.REPLAY]: 0,
      [OperationMode.MIXED]: 0.55,
      [OperationMode.LIVE]: 1.0,
    };

    if (initialThresholds) {
      this.thresholds = { ...this.thresholds, ...initialThresholds } as Record<OperationMode, number>;
    }
  }


  static getInstance(initialThresholds?: Partial<Record<OperationMode, number>>): ModeAwareConfidenceScorer {
    if (!ModeAwareConfidenceScorer.instance) {
      ModeAwareConfidenceScorer.instance = new ModeAwareConfidenceScorer(initialThresholds);
    }
    return ModeAwareConfidenceScorer.instance;
  }

  /**
   * Score confidence taking mode into account
   *
   * @param rawConfidence Original confidence (0-1)
   * @param tick World tick with mode info
   * @param signal Signal context (optional metadata)
   * @returns Adjusted confidence and reasoning
   */
  score(
    rawConfidence: number,
    tick: WorldTick,
    signal?: { name?: string; source?: string }
  ): ConfidenceScoreResult {
    const mode = tick.mode;

    // update per-symbol history and lastEmitTime
    try {
      const key = tick.symbol || 'unknown';
      const hist = this.recentConfidence.get(key) || [];
      hist.push(rawConfidence);
      if (hist.length > this.config.momentumHistorySize) hist.shift();
      this.recentConfidence.set(key, hist);
      this.lastEmitTime.set(key, tick.emitTime || Date.now());
    } catch (e) {
      // non-fatal
    }

    // apply source weighting
    const source = (signal && signal.source) || tick.source || 'default';
    const sourceWeight = this.config.sourceWeights[source] ?? this.config.sourceWeights.default ?? 1.0;
    let adjustedRaw = rawConfidence * sourceWeight;

    // Calculate momentum: difference between last value and previous average
    let momentum = 0;
    try {
      const hist = this.recentConfidence.get(tick.symbol) || [];
      if (hist.length >= 2) {
        const last = hist[hist.length - 1];
        const prev = hist.slice(0, -1);
        const avgPrev = prev.reduce((a, b) => a + b, 0) / Math.max(1, prev.length);
        momentum = last - avgPrev; // raw difference in [ -1 .. 1 ]
      }
    } catch (e) {
      momentum = 0;
    }

    // MIXED mode: apply time-since-last-tick penalty
    if (mode === OperationMode.MIXED) {
      const last = this.lastEmitTime.get(tick.symbol) || tick.emitTime || Date.now();
      const delta = Math.max(0, (Date.now() - last));
      const w = Math.max(0, 1 - Math.min(1, delta / this.config.mixedStalenessWindowMs));
      adjustedRaw = adjustedRaw * w;
    }

    // LIVE mode: enforce minimum floor
    if (mode === OperationMode.LIVE) {
      adjustedRaw = Math.max(adjustedRaw, this.config.liveMinimumFloor);
    }

    // Apply momentum effect (small boost/penalty)
    if (momentum !== 0) {
      adjustedRaw = adjustedRaw * (1 + this.config.momentumWeight * momentum);
    }

    // Finally apply threshold caps for non-LIVE modes
    const threshold = this.thresholds[mode];
    const capped = mode === OperationMode.LIVE ? adjustedRaw : Math.min(adjustedRaw, threshold);

    // Ensure adjusted is within [0,1]
    const finalAdjusted = Math.max(0, Math.min(1, capped));

    const canTrade = this.isTradeworthy(finalAdjusted, mode);
    const reason = this.getDetailedReason(mode, rawConfidence, source, sourceWeight, momentum, finalAdjusted);

    return {
      raw: rawConfidence,
      adjusted: finalAdjusted,
      reason,
      mode,
      canTrade,
    };
  }

  /**
   * Alternative: Score without tick (use current mode)
   */
  scoreWithCurrentMode(rawConfidence: number, signalName?: string): ConfidenceScoreResult {
    const detector = getModeDetector();
    const mode = detector.detectMode();
    // Delegate to primary scoring function with a minimal fake tick
    const fakeTick: WorldTick = {
      symbol: 'unknown',
      timeframe: 60,
      worldTime: Date.now(),
      emitTime: Date.now(),
      mode,
      candle: { t: Date.now(), o: 0, h: 0, l: 0, c: 0, v: 0 },
      isFinal: true,
      source: 'default'
    } as any;

    return this.score(rawConfidence, fakeTick, { name: signalName, source: 'default' });
  }

  /**
   * Generate human-readable reason for adjustment
   */
  private getReason(mode: OperationMode, raw: number, adjusted: number): string {
    if (mode === OperationMode.REPLAY) {
      return `REPLAY mode: Historical data, no trading (raw=${(raw * 100).toFixed(1)}%)`;
    }

    if (mode === OperationMode.MIXED) {
      if (adjusted < raw) {
        return `MIXED mode: Backfill in progress, capped at 50% (raw=${(raw * 100).toFixed(1)}% → adjusted=${(adjusted * 100).toFixed(1)}%)`;
      }
      return `MIXED mode: Backfill active, confidence within limits (${(adjusted * 100).toFixed(1)}%)`;
    }

    if (mode === OperationMode.LIVE) {
      return `LIVE mode: Full confidence allowed (${(adjusted * 100).toFixed(1)}%)`;
    }

    return 'Unknown mode';
  }

  /**
   * More detailed reason including source and momentum
   */
  private getDetailedReason(mode: OperationMode, raw: number, source: string, sourceWeight: number, momentum: number, adjusted: number): string {
    const base = this.getReason(mode, raw, adjusted);
    const pieces = [base];
    pieces.push(`source=${source} weight=${sourceWeight.toFixed(2)}`);
    if (Math.abs(momentum) > 0.0001) pieces.push(`momentum=${momentum.toFixed(3)}`);
    return pieces.join(' | ');
  }

  /**
   * Is this signal tradeable?
   *
   * Criteria:
   * - Mode-adjusted confidence > 30%
   * - REPLAY always non-tradeable
   * - MIXED only if confidence > 50%
   * - LIVE allows normal thresholds
   */
  isTradeworthy(confidence: number, mode: OperationMode): boolean {
    if (mode === OperationMode.REPLAY) return false;
    if (mode === OperationMode.MIXED) return confidence > 0.5;
    if (mode === OperationMode.LIVE) return confidence > 0.3;
    return false;
  }

  /**
   * Diagnostic: Show thresholds by mode
   */
  diagnostics(): string {
    return [
      '[ConfidenceScorer] Thresholds by Mode:',
      `  REPLAY: ${(this.thresholds[OperationMode.REPLAY] * 100).toFixed(0)}% (no trading)`,
      `  MIXED:  ${(this.thresholds[OperationMode.MIXED] * 100).toFixed(0)}% (capped)`,
      `  LIVE:   ${(this.thresholds[OperationMode.LIVE] * 100).toFixed(0)}% (unlimited)`,
    ].join('\n');
  }
}

export function getConfidenceScorer(): ModeAwareConfidenceScorer {
  return ModeAwareConfidenceScorer.getInstance();
}
