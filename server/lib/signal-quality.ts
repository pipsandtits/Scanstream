/**
 * SCANSTREAM Signal Quality Framework
 * Unified signal quality scoring and comparison system
 * Ensures only high-quality signals are presented to users
 */

import { SignalAccuracyEngine } from './signal-accuracy';
import { db } from '../db-storage';

export interface SignalMetrics {
  id: string;
  symbol: string;
  type: string; // 'ma_crossover', 'rsi', 'macd', 'confluence', 'ml_prediction'
  classifications?: string[]; // MULTIPLE: BREAKOUT, ACCUMULATION, BULL_EARLY, etc.
  primaryClassification?: string; // Highest confidence pattern
  strength: number; // 0-100
  confidence: number; // 0-1
  direction: 'buy' | 'sell' | 'hold';
  price: number;
  timestamp: Date;
  reasoning: Record<string, any>;
  riskRewardRatio?: number;
  convergenceScore?: number; // How many signals agree
  historicalAccuracy?: number; // Past win rate
  volatilityAdjusted?: boolean;
  patternDetails?: Record<string, any>[];
  timeframeAlignment?: number;
}

export interface QualityScore {
  overallScore: number; // 0-100
  confidenceScore: number; // 0-100
  convergenceScore: number; // How many independent methods agree
  historicalAccuracy: number; // Based on past performance
  riskRewardScore: number; // Risk/reward quality
  timeframeAlignment: number; // How well it aligns across timeframes
  reasons: string[];
  rating: 'excellent' | 'good' | 'fair' | 'poor' | 'filtered';
}

export class SignalQualityEngine {
  private performanceCache: Map<string, { wins: number; losses: number; rate: number }> = new Map();
  private accuracyEngine: SignalAccuracyEngine;

  constructor() {
    this.accuracyEngine = new SignalAccuracyEngine();
  }

  /**
   * Calculate comprehensive quality score for a signal
   */
  async calculateQualityScore(signal: SignalMetrics, relatedSignals: SignalMetrics[] = [], preloadedAccuracy?: Map<string, number>): Promise<QualityScore> {
    // Deprecated: callers should prefer passing a preloaded accuracy map via
    // the optional third parameter in future refactors. Backwards compatible
    // signature kept for internal calls.
    const reasons: string[] = [];
    let scores = {
      strength: 0,
      confidence: 0,
      convergence: 0,
      accuracy: 0,
      riskReward: 0,
      timeframeAlignment: 0
    };

    // 1. Strength Score (0-25 points)
    if (signal.strength >= 85) {
      scores.strength = 25;
      reasons.push('Very strong signal momentum');
    } else if (signal.strength >= 70) {
      scores.strength = 18;
      reasons.push('Strong signal momentum');
    } else if (signal.strength >= 55) {
      scores.strength = 12;
      reasons.push('Moderate signal momentum');
    } else {
      scores.strength = 0;
      reasons.push('Weak signal momentum - filtered');
    }

    // 2. Confidence Score (0-25 points)
    if (signal.confidence >= 0.85) {
      scores.confidence = 25;
      reasons.push('Very high confidence');
    } else if (signal.confidence >= 0.70) {
      scores.confidence = 18;
      reasons.push('High confidence');
    } else if (signal.confidence >= 0.55) {
      scores.confidence = 12;
      reasons.push('Moderate confidence');
    } else {
      scores.confidence = 0;
      reasons.push('Low confidence - filtered');
    }

    // 3. Convergence Score (0-20 points)
    const convergence = this.calculateConvergence(signal, relatedSignals);
    scores.convergence = convergence.score;
    reasons.push(...convergence.reasons);

    // 4. Historical Accuracy (0-20 points) - IMPROVED WITH PATTERN ACCURACY
    let totalAccuracy = 0;
    if (signal.classifications && signal.classifications.length > 0) {
      // Use pattern-specific accuracy
      for (const pattern of signal.classifications) {
        const adjustment = this.accuracyEngine.adjustConfidenceByAccuracy(0.5, pattern as any, "1h");
        totalAccuracy += adjustment.patternAccuracy;
        reasons.push(...adjustment.reasoning);
      }
      const avgPatternAccuracy = totalAccuracy / signal.classifications.length;
      if (avgPatternAccuracy >= 0.75) {
        scores.accuracy = 20;
      } else if (avgPatternAccuracy >= 0.70) {
        scores.accuracy = 16;
      } else if (avgPatternAccuracy >= 0.60) {
        scores.accuracy = 12;
      } else if (avgPatternAccuracy >= 0.50) {
        scores.accuracy = 6;
      } else {
        scores.accuracy = 0;
      }
    } else {
      // Fallback to signal type accuracy
      const cacheKey = `${signal.type}:${signal.symbol}`;
      let accuracy = 0.5;
      if (preloadedAccuracy && preloadedAccuracy.has(cacheKey)) {
        accuracy = preloadedAccuracy.get(cacheKey)!;
      } else {
        accuracy = await this.getHistoricalAccuracy(signal.type, signal.symbol);
      }

      if (accuracy >= 0.70) {
        scores.accuracy = 15;
        reasons.push(`Signal type has ${(accuracy * 100).toFixed(1)}% historical accuracy`);
      } else if (accuracy >= 0.55) {
        scores.accuracy = 8;
        reasons.push(`Signal type has ${(accuracy * 100).toFixed(1)}% historical accuracy`);
      } else {
        scores.accuracy = 0;
        reasons.push('Poor historical accuracy for this signal type');
      }
    }

    // 5. Risk/Reward Score (0-10 points)
    if (signal.riskRewardRatio && signal.riskRewardRatio >= 1.5) {
      scores.riskReward = 10;
      reasons.push(`Excellent risk/reward ratio: ${signal.riskRewardRatio.toFixed(2)}`);
    } else if (signal.riskRewardRatio && signal.riskRewardRatio >= 1.0) {
      scores.riskReward = 6;
      reasons.push(`Good risk/reward ratio: ${signal.riskRewardRatio.toFixed(2)}`);
    } else {
      scores.riskReward = 0;
      reasons.push('Poor risk/reward ratio');
    }

    // 6. Timeframe Alignment (0-5 points)
    if (signal.convergenceScore && signal.convergenceScore >= 0.8) {
      scores.timeframeAlignment = 5;
      reasons.push('Strong alignment across multiple timeframes');
    } else if (signal.convergenceScore && signal.convergenceScore >= 0.5) {
      scores.timeframeAlignment = 3;
      reasons.push('Moderate timeframe alignment');
    }

    const overallScore = Object.values(scores).reduce((a, b) => a + b, 0);
    
    let rating: 'excellent' | 'good' | 'fair' | 'poor' | 'filtered' = 'poor';
    if (overallScore >= 90) rating = 'excellent';
    else if (overallScore >= 75) rating = 'good';
    else if (overallScore >= 60) rating = 'fair';
    else if (overallScore >= 45) rating = 'poor';
    else rating = 'filtered';

    return {
      overallScore,
      confidenceScore: scores.confidence,
      convergenceScore: scores.convergence,
      historicalAccuracy: scores.accuracy,
      riskRewardScore: scores.riskReward,
      timeframeAlignment: scores.timeframeAlignment,
      reasons,
      rating
    };
  }

  /**
   * Calculate convergence score (how many independent signals agree)
   */
  private calculateConvergence(signal: SignalMetrics, relatedSignals: SignalMetrics[]): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    if (!relatedSignals || relatedSignals.length === 0) {
      return { score: 5, reasons: ['No convergence data (single signal)'] };
    }

    const agreeingSignals = relatedSignals.filter(s => s.direction === signal.direction);
    const convergenceRate = agreeingSignals.length / relatedSignals.length;

    if (convergenceRate >= 0.9) {
      reasons.push(`Convergence: ${agreeingSignals.length}/${relatedSignals.length} signals agree (${(convergenceRate * 100).toFixed(0)}%)`);
      return { score: 20, reasons };
    } else if (convergenceRate >= 0.7) {
      reasons.push(`Convergence: ${agreeingSignals.length}/${relatedSignals.length} signals agree (${(convergenceRate * 100).toFixed(0)}%)`);
      return { score: 15, reasons };
    } else if (convergenceRate >= 0.5) {
      reasons.push(`Mixed convergence: ${agreeingSignals.length}/${relatedSignals.length} signals agree`);
      return { score: 8, reasons };
    } else {
      reasons.push(`Divergence warning: Only ${agreeingSignals.length}/${relatedSignals.length} signals agree`);
      return { score: 2, reasons };
    }
  }

  /**
   * Get historical accuracy for a signal type
   */
  private async getHistoricalAccuracy(signalType: string, symbol: string): Promise<number> {
    const cacheKey = `${signalType}:${symbol}`;
    
    if (this.performanceCache.has(cacheKey)) {
      const cached = this.performanceCache.get(cacheKey)!;
      return cached.rate;
    }

    try {
      const res = await db.query('SELECT * FROM "Signal" WHERE type = $1 AND symbol = $2 ORDER BY "timestamp" DESC LIMIT 100', [signalType, symbol]);
      const signals = res.rows || [];

      if (signals.length === 0) return 0.5; // Default to 50% if no history

      // Simple win/loss calculation based on reasoning
      let wins = 0;
      let losses = 0;

      signals.forEach((signal: any) => {
        const reasoning = signal.reasoning as Record<string, any>;
        if (reasoning?.outcome === 'win') wins++;
        else if (reasoning?.outcome === 'loss') losses++;
      });

      const total = wins + losses;
      const rate = total > 0 ? wins / total : 0.5;

      this.performanceCache.set(cacheKey, { wins, losses, rate });
      return rate;
    } catch (error) {
      console.error('Error getting historical accuracy:', error);
      return 0.5;
    }
  }

  /**
   * Preload historical accuracy for a batch of signals (avoid N+1 DB calls).
   * Returns a Map keyed by `${type}:${symbol}` -> accuracy (0-1).
   */
  async preloadHistoricalAccuracy(signals: SignalMetrics[]): Promise<Map<string, number>> {
    const prismaAny = (db as any).prisma as any;
    const pairs = new Map<string, { type: string; symbol: string }>();
    for (const s of signals) {
      const key = `${s.type}:${s.symbol}`;
      if (!pairs.has(key)) pairs.set(key, { type: s.type, symbol: s.symbol });
    }

    const keys = Array.from(pairs.values());
    const result = new Map<string, number>();
    if (keys.length === 0) return result;

    // Build a VALUES list for parameterized query
    const vals: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const k of keys) {
      vals.push(`($${idx}, $${idx + 1})`);
      params.push(k.type, k.symbol);
      idx += 2;
    }

    const sql = `
      WITH pairs(type, symbol) AS (VALUES ${vals.join(',')}),
      ranked AS (
        SELECT s.type, s.symbol, s.outcome,
          ROW_NUMBER() OVER (PARTITION BY s.type, s.symbol ORDER BY s.timestamp DESC) as rn
        FROM signal s
        JOIN pairs p ON p.type = s.type AND p.symbol = s.symbol
      )
      SELECT type, symbol,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses
      FROM ranked
      WHERE rn <= 100
      GROUP BY type, symbol
    `;

    try {
      const rowsRes = await db.query(sql, params);
      const rows: any[] = rowsRes.rows || [];
      for (const r of rows) {
        const tot = (Number(r.wins) || 0) + (Number(r.losses) || 0);
        const acc = tot > 0 ? (Number(r.wins) || 0) / tot : 0.5;
        result.set(`${r.type}:${r.symbol}`, acc);
      }
    } catch (err) {
      // On error, leave map empty; callers will fall back to individual queries
      console.warn('[SignalQuality] preloadHistoricalAccuracy failed:', err);
    }

    return result;
  }

  /**
   * Filter signals by quality threshold
   */
  async filterByQuality(signals: SignalMetrics[], minQualityScore: number = 60): Promise<SignalMetrics[]> {
    // Preload accuracies to avoid per-signal DB calls
    const accuracyMap = await this.preloadHistoricalAccuracy(signals);
    const qualityResults = await Promise.all(
      signals.map(async (signal: SignalMetrics) => {
        const quality = await this.calculateQualityScore(signal, signals, accuracyMap);
        return { signal, quality };
      })
    );

    return qualityResults
      .filter(({ quality }) => quality.overallScore >= minQualityScore && quality.rating !== 'filtered')
      .map(({ signal }) => signal);
  }

  /**
   * Consolidate signals from different sources into best signal per symbol
   */
  async consolidateSignals(signals: SignalMetrics[]): Promise<Map<string, { signal: SignalMetrics; quality: QualityScore }>> {
    const consolidated = new Map<string, { signal: SignalMetrics; quality: QualityScore }>();

    // Group by symbol
    const bySymbol = new Map<string, SignalMetrics[]>();
    signals.forEach((signal: SignalMetrics) => {
      if (!bySymbol.has(signal.symbol)) {
        bySymbol.set(signal.symbol, []);
      }
      bySymbol.get(signal.symbol)!.push(signal);
    });

    // For each symbol, pick the best signal
    // Preload accuracy map for all signals to avoid N+1
    const allSignals = Array.from(bySymbol.values()).flat();
    const accuracyMap = await this.preloadHistoricalAccuracy(allSignals);

    for (const [symbol, symbolSignals] of bySymbol.entries()) {
      let bestSignal = symbolSignals[0];
      let bestQuality = await this.calculateQualityScore(bestSignal, symbolSignals, accuracyMap);

      for (const signal of symbolSignals.slice(1)) {
        const quality = await this.calculateQualityScore(signal, symbolSignals, accuracyMap);
        if (quality.overallScore > bestQuality.overallScore) {
          bestSignal = signal;
          bestQuality = quality;
        }
      }

      consolidated.set(symbol, { signal: bestSignal, quality: bestQuality });
    }

    return consolidated;
  }

  /**
   * Rank signals by quality
   */
  async rankSignals(signals: SignalMetrics[]): Promise<Array<{ signal: SignalMetrics; quality: QualityScore; rank: number }>> {
    const withQuality = await Promise.all(
      signals.map(async (signal: SignalMetrics) => ({
        signal,
        quality: await this.calculateQualityScore(signal, signals)
      }))
    );

    return withQuality
      .sort((a, b) => b.quality.overallScore - a.quality.overallScore)
      .map((item, index) => ({ ...item, rank: index + 1 }));
  }
}

export const signalQualityEngine = new SignalQualityEngine();
