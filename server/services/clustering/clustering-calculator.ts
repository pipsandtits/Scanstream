/**
 * Clustering Metrics Calculator
 * 
 * Calculates all clustering metrics from OHLCV candle data
 * System-wide clustering analysis for any asset/timeframe
 * 
 * Metrics Calculated:
 * - trend_formation_signal: Boolean (is a trend forming?)
 * - cluster_strength: 0-1 (directional_ratio × follow_through)
 * - directional_ratio: 0-1 (% of candles in dominant direction)
 * - follow_through: 0-1 (candle continuation %)
 * - total_clusters: Count of directional candle groups
 * - bullish_clusters: Count of upward clusters
 * - bearish_clusters: Count of downward clusters
 */

export interface ClusterMetrics {
  trend_formation_signal: boolean;
  cluster_strength: number; // 0-1
  directional_ratio: number; // 0-1
  follow_through: number; // 0-1
  total_clusters: number;
  bullish_clusters: number;
  bearish_clusters: number;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * ClusteringCalculator: Computes clustering metrics from raw price data
 * 
 * Algorithm:
 * 1. Identify candle direction (bullish/bearish/neutral)
 * 2. Group consecutive candles in same direction into clusters
 * 3. Count clusters and measure directional strength
 * 4. Calculate follow-through (momentum continuation)
 * 5. Combine into final cluster strength metric
 */
import { ClusterValidator } from './cluster-validator';

export class ClusteringCalculator {
  /**
   * Calculate all clustering metrics from OHLCV candle history
   * 
   * @param candles Array of OHLCV data points (minimum 10 required)
   * @returns ClusterMetrics with all clustering indicators
   */
  static calculateMetrics(
    candles: OHLCV[],
    options?: { maxDrawdownRisk?: number; barsSinceSignal?: number; minClusterSize?: number }
  ): ClusterMetrics {
    if (!candles || candles.length < 10) {
      return this.getDefaultMetrics(); // Insufficient data
    }

    // Convert to minimal Candle shape expected by ClusterValidator helper
    const minimalCandles = candles.map(c => ({
      ts: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      isFinal: true
    } as any));

    const minClusterSize = options?.minClusterSize ?? 2;

    // Use improved cluster metrics helper (adds avg/max sizes, volatility, neutral ratio)
    const baseMetrics = ClusterValidator.computeClusterMetricsFromCandles(minimalCandles, minClusterSize);

    // compute follow-through using existing method (more specific to OHLCV structure)
    const follow_through = this.calculateFollowThrough(candles);

    // Start from base cluster strength but combine with follow-through
    let cluster_strength = (baseMetrics.cluster_strength + follow_through) / 2;

    // Apply volatility damping (reduce strength when volatility high)
    const vol = baseMetrics.volatility ?? 0;
    cluster_strength = cluster_strength * (1 - Math.min(1, vol) * 0.5);

    // Apply decay based on how many bars since the original signal and drawdown risk
    const barsSince = options?.barsSinceSignal ?? 0;
    const barsDecay = Math.max(0.2, Math.exp(-barsSince / 50));
    const drawdownRisk = options?.maxDrawdownRisk ?? 0; // 0-1
    const drawdownFactor = 1 - Math.min(0.9, drawdownRisk * 0.6);

    cluster_strength = Math.max(0, Math.min(1, cluster_strength * barsDecay * drawdownFactor));

    // Directional ratio - prefer base metric's directional measurement
    const directional_ratio = Math.min(Math.max(baseMetrics.directional_ratio, 0), 1);

    // Trend formation: reuse base helper and follow-through criteria
    const trend_formation_signal = baseMetrics.trend_formation_signal && follow_through >= 0.25;

    return {
      trend_formation_signal,
      cluster_strength: Math.min(Math.max(cluster_strength, 0), 1),
      directional_ratio,
      follow_through: Math.min(Math.max(follow_through, 0), 1),
      total_clusters: baseMetrics.total_clusters,
      bullish_clusters: baseMetrics.bullish_clusters,
      bearish_clusters: baseMetrics.bearish_clusters
    };
  }

  /**
   * Analyze individual candle directions (up/down/neutral)
   */
  private static analyzeCandles(candles: OHLCV[]): ('UP' | 'DOWN' | 'NEUTRAL')[] {
    return candles.map((candle, idx) => {
      // Compare close vs open
      if (candle.close > candle.open) {
        return 'UP';
      } else if (candle.close < candle.open) {
        return 'DOWN';
      } else {
        return 'NEUTRAL'; // Doji/no body
      }
    });
  }

  /**
   * Count clusters (consecutive candles in same direction)
   */
  private static countClusters(directions: ('UP' | 'DOWN' | 'NEUTRAL')[]): {
    total: number;
    bullish: number;
    bearish: number;
  } {
    let total = 0;
    let bullish = 0;
    let bearish = 0;
    let inCluster = false;
    let currentDirection: 'UP' | 'DOWN' | null = null;

    for (let i = 0; i < directions.length; i++) {
      const dir = directions[i];

      // Skip neutral candles
      if (dir === 'NEUTRAL') {
        if (inCluster) {
          // Neutral breaks a cluster
          inCluster = false;
        }
        continue;
      }

      // Same direction as current cluster
      if (inCluster && dir === currentDirection) {
        // Continue cluster
        continue;
      }

      // Direction changed or starting new cluster
      if (!inCluster) {
        // Start new cluster
        inCluster = true;
        currentDirection = dir;
        total++;

        if (dir === 'UP') {
          bullish++;
        } else {
          bearish++;
        }
      } else {
        // Direction changed - end old, start new
        total++;
        currentDirection = dir;

        if (dir === 'UP') {
          bullish++;
        } else {
          bearish++;
        }
      }
    }

    return { total, bullish, bearish };
  }

  /**
   * Calculate directional ratio (% of candles in dominant direction)
   */
  private static calculateDirectionalRatio(directions: ('UP' | 'DOWN' | 'NEUTRAL')[]): number {
    if (directions.length === 0) return 0;

    const bullish = directions.filter(d => d === 'UP').length;
    const bearish = directions.filter(d => d === 'DOWN').length;
    const total = bullish + bearish; // Exclude neutrals

    if (total === 0) return 0;

    // Ratio = max(bullish, bearish) / total
    const dominant = Math.max(bullish, bearish);
    return dominant / total;
  }

  /**
   * Calculate follow-through (momentum continuation across candles)
   * 
   * Follow-through = % of candles that continue previous candle's direction
   */
  private static calculateFollowThrough(candles: OHLCV[]): number {
    if (candles.length < 2) return 0;

    let followThroughCount = 0;

    for (let i = 1; i < candles.length; i++) {
      const prevCandle = candles[i - 1];
      const currCandle = candles[i];

      // Get directions
      const prevDir = prevCandle.close > prevCandle.open ? 'UP' : prevCandle.close < prevCandle.open ? 'DOWN' : 'NEUTRAL';
      const currDir = currCandle.close > currCandle.open ? 'UP' : currCandle.close < currCandle.open ? 'DOWN' : 'NEUTRAL';

      // Count if current continues previous direction
      if (prevDir !== 'NEUTRAL' && currDir === prevDir) {
        followThroughCount++;
      }
    }

    return followThroughCount / (candles.length - 1);
  }

  /**
   * Detect if a trend is forming
   * 
   * Conditions:
   * - At least 4 clusters (organized movement)
   * - Directional ratio > 0.65 (clear direction)
   * - Follow-through > 0.50 (momentum sustaining)
   */
  private static isTrendForming(
    clusterInfo: { total: number; bullish: number; bearish: number },
    directional_ratio: number,
    follow_through: number
  ): boolean {
    const minClusters = 4;
    const minDirectionalRatio = 0.65;
    const minFollowThrough = 0.50;

    return (
      clusterInfo.total >= minClusters &&
      directional_ratio >= minDirectionalRatio &&
      follow_through >= minFollowThrough
    );
  }

  /**
   * Get default metrics for insufficient data
   */
  private static getDefaultMetrics(): ClusterMetrics {
    return {
      trend_formation_signal: false,
      cluster_strength: 0,
      directional_ratio: 0,
      follow_through: 0,
      total_clusters: 0,
      bullish_clusters: 0,
      bearish_clusters: 0
    };
  }

  /**
   * Batch calculate metrics for multiple candle sets
   */
  static calculateMetricsBatch(
    candleSets: OHLCV[][]
  ): ClusterMetrics[] {
    return candleSets.map(candles => this.calculateMetrics(candles));
  }

  /**
   * Quick helper: Convert CCXT number[][] format to OHLCV objects
   */
  static convertFromCCXTFormat(ccxtCandles: number[][]): OHLCV[] {
    return ccxtCandles.map(candle => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: candle[5]
    }));
  }

  /**
   * Quick helper: Convert to CCXT number[][] format
   */
  static convertToCCXTFormat(ohlcv: OHLCV[]): number[][] {
    return ohlcv.map(candle => [
      candle.timestamp,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume
    ]);
  }
}

/**
 * Factory function
 */
export function createClusteringCalculator(): typeof ClusteringCalculator {
  return ClusteringCalculator;
}

/**
 * Quick helper: Calculate metrics without instantiation
 */
export function calculateClusterMetrics(ccxtCandles: number[][], options?: { maxDrawdownRisk?: number; barsSinceSignal?: number; minClusterSize?: number }): ClusterMetrics {
  if (!ccxtCandles || ccxtCandles.length < 10) {
    return {
      trend_formation_signal: false,
      cluster_strength: 0,
      directional_ratio: 0,
      follow_through: 0,
      total_clusters: 0,
      bullish_clusters: 0,
      bearish_clusters: 0
    };
  }

  const ohlcvCandles = ClusteringCalculator.convertFromCCXTFormat(ccxtCandles);
  return ClusteringCalculator.calculateMetrics(ohlcvCandles, options);
}
