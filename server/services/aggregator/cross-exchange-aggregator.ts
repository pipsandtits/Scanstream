/**
 * Cross-Exchange Aggregator
 *
 * Listens to `world.tick` events and keeps latest per-exchange candles
 * for each symbol. Exposes `getAggregated(symbol)` for agents to query
 * unified state inside `onWorldTick` calls (so agents still subscribe
 * only to `world.tick` via BaseAgent).
 *
 * Emits: 'aggregated.updated' events for dashboards/metrics.
 */

import { EventEmitter } from 'events';
import type { WorldTick, Candle } from '../../types/market-data';
import type { AggregatedCandle, CrossExchangeSignal } from './cross-exchange-types';

export class CrossExchangeAggregator extends EventEmitter {
  // symbol -> exchange -> Candle
  private store: Map<string, Map<string, Candle>> = new Map();
  // symbol -> AggregatedCandle
  private aggregatedCache: Map<string, AggregatedCandle> = new Map();

  // freshness threshold (ms) — ignore stale exchange candles
  private freshnessMs: number;
  // optional per-symbol freshness overrides
  private perSymbolFreshness: Map<string, number> = new Map();

  // venue health scores (0-1)
  private venueHealth: Map<string, number> = new Map();

  constructor(private source: EventEmitter, freshnessMs = 90_000) {
    super();
    this.freshnessMs = freshnessMs;

    // Listen to world.tick events from IntegrityGate
    this.source.on('world.tick', (tick: WorldTick) => this.onWorldTick(tick));
  }

  private onWorldTick(tick: WorldTick): void {
    try {
      const symbol = tick.symbol;
      const exchange = tick.source || 'unknown';
      const candle: Candle = tick.candle as Candle;

      if (!this.store.has(symbol)) this.store.set(symbol, new Map());
      const perExchange = this.store.get(symbol)!;
      perExchange.set(exchange, candle);

      // Recompute aggregated view
      const aggregated = this.computeAggregated(symbol, perExchange);

      // Emit only when aggregated snapshot changes to reduce noise
      const prev = this.aggregatedCache.get(symbol);
      const prevStr = prev ? this.serializeSafely(prev) : null;
      const nextStr = this.serializeSafely(aggregated);
      if (prevStr !== nextStr) {
        this.aggregatedCache.set(symbol, aggregated);
        this.emit('aggregated.updated', { symbol, aggregated });

        // Also emit a higher-level CrossExchangeSignal for downstream agents
        try {
          const spreadImpact = (aggregated.spread && ((aggregated.bestBid && aggregated.bestAsk) ? (aggregated.spread / (((aggregated.bestBid || 0) + (aggregated.bestAsk || 0)) / 2)) : undefined)) ?? undefined;
          // compute simple venue consistency metric (1 - relative stddev)
          const prices = Object.values(aggregated.exchangeCandles).filter(Boolean).map(c => (c as Candle).close);
          let venueConsistency = 0;
          if (prices.length > 0) {
            const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
            const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
            const std = Math.sqrt(variance);
            venueConsistency = mean > 0 ? Math.max(0, Math.min(1, 1 - (std / mean))) : 0;
          }

          const sig: CrossExchangeSignal = {
            symbol,
            aggregated,
            spreadImpact: spreadImpact ?? 0,
            venueConsistency,
            recommendation: 'NEUTRAL',
            timestamp: Date.now(),
          };

          this.emit('cross-exchange.signal', sig);
        } catch (e) {
          // non-fatal
        }
      }
    } catch (err) {
      console.error('[CrossExchangeAggregator] onWorldTick error:', err);
    }
  }

  /**
   * Register an exchange adapter to receive its metrics for venue health tracking.
   * Adapter is expected to emit 'metrics' events with a payload containing
   * { venue, success, errorCount, consecutiveFailures, healthy }
   */
  registerAdapter(adapter: EventEmitter, venue: string): void {
    if (!adapter || !venue) return;
    this.venueHealth.set(venue, 1.0);
    adapter.on('metrics', (m: any) => {
      try {
        // Prefer explicit healthy boolean when provided
        if (typeof m.healthy === 'boolean') {
          this.venueHealth.set(venue, m.healthy ? 1.0 : 0.2);
          return;
        }

        const failures = Number(m.consecutiveFailures || m.consecutive_failures || 0);
        const errors = Number(m.errorCount || m.error_count || 0);
        // Basic health heuristic
        const score = Math.max(0, 1 - Math.min(1, failures / 10) - Math.min(0.8, errors / 100));
        this.venueHealth.set(venue, Math.max(0, Math.min(1, score)));
      } catch (e) {
        // ignore
      }
    });
  }

  private serializeSafely(obj: any): string {
    try {
      return JSON.stringify({
        symbol: obj?.symbol || 'unknown',
        bestBid: obj?.bestBid ?? null,
        bestAsk: obj?.bestAsk ?? null,
        spread: obj?.spread ?? null,
        sourcesSeen: (obj?.sourcesSeen && obj.sourcesSeen.length) || 0,
        timestamp: obj?.timestamp || 0
      });
    } catch {
      return `${obj?.symbol || 'unknown'}:${obj?.timestamp || 0}`;
    }
  }

  private computeAggregated(symbol: string, perExchange: Map<string, Candle>): AggregatedCandle {
    const exchangeCandles: Record<string, Candle | undefined> = {};
    const prices: number[] = [];
    const sourcesSeen: string[] = [];
    let latestTs = 0;

    for (const [exchange, candle] of perExchange.entries()) {
      exchangeCandles[exchange] = candle;
      if (candle) {
        prices.push(candle.close);
        sourcesSeen.push(exchange);
        if (candle.ts > latestTs) latestTs = candle.ts;
      }
    }

    const bestBid = prices.length > 0 ? Math.max(...prices) : undefined;
    const bestAsk = prices.length > 0 ? Math.min(...prices) : undefined;
    const spread = bestBid !== undefined && bestAsk !== undefined ? bestBid - bestAsk : undefined;

    // total volume and active sources (fresh contributors)
    let totalVolume = 0;
    let activeSources = 0;
    const now = Date.now();
    const symbolFreshMs = this.perSymbolFreshness.get(symbol) ?? this.freshnessMs;
    for (const [, c] of perExchange.entries()) {
      if (!c) continue;
      totalVolume += (c.volume || 0);
      if (now - (c.ts || 0) < symbolFreshMs) activeSources++;
    }

    const aggregated: AggregatedCandle = {
      symbol,
      exchangeCandles,
      bestBid,
      bestAsk,
      spread,
      timestamp: latestTs || Date.now(),
      sourcesSeen,
      confidence: this.computeConfidence(perExchange, symbol),
      vwap: this.computeVWAP(perExchange),
      totalVolume: totalVolume || undefined,
      activeSources: activeSources,
      lastUpdated: Date.now(),
      venueHealthScores: this.getVenueHealthScores(perExchange),
    };

    return aggregated;
  }

  /**
   * Compute confidence with venue weighting and optional per-symbol freshness
   */
  private computeConfidence(perExchange: Map<string, Candle>, symbol?: string): number {
    const venueWeights: Record<string, number> = {
      binance: 1.0,
      kucoin: 0.85,
      coinbase: 0.9,
      okx: 0.8,
      default: 0.7,
    };

    let score = 0;
    let weightSum = 0;
    const now = Date.now();
    const symbolFreshMs = symbol && this.perSymbolFreshness.has(symbol) ? this.perSymbolFreshness.get(symbol)! : this.freshnessMs;

    for (const [exchange, candle] of perExchange.entries()) {
      const weight = venueWeights[exchange] ?? venueWeights.default;
      weightSum += weight;
      if (candle && (now - (candle.ts || 0) < symbolFreshMs)) {
        score += weight;
      }
    }

    return weightSum > 0 ? Math.round((score / weightSum) * 100) : 0;
  }

  /**
   * Compute VWAP across exchanges using close as price and volume.
   */
  private computeVWAP(perExchange: Map<string, Candle>): number | undefined {
    let volSum = 0;
    let pvSum = 0;
    for (const [, c] of perExchange.entries()) {
      if (!c || typeof c.close !== 'number' || typeof c.volume !== 'number') continue;
      volSum += c.volume;
      pvSum += c.close * c.volume;
    }
    if (volSum === 0) return undefined;
    return pvSum / volSum;
  }

  private getVenueHealthScores(perExchange: Map<string, Candle>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [venue] of perExchange.entries()) {
      out[venue] = this.venueHealth.get(venue) ?? 1.0;
    }
    return out;
  }

  /**
   * Set venue health (0-1)
   */
  setVenueHealth(venue: string, score: number): void {
    this.venueHealth.set(venue, Math.max(0, Math.min(1, score)));
  }

  /**
   * Set per-symbol freshness threshold (ms)
   */
  setFreshnessForSymbol(symbol: string, ms: number): void {
    this.perSymbolFreshness.set(symbol, ms);
  }

  /**
   * Get best price across exchanges for side. Returns {price, exchange}
   */
  getBestPrice(symbol: string, side: 'buy' | 'sell'): { price: number | undefined; exchange?: string | undefined } {
    const agg = this.aggregatedCache.get(symbol);
    if (!agg) return { price: undefined };

    if (side === 'buy') {
      // buyer wants lowest ask
      let bestPrice: number | undefined = undefined;
      let bestEx: string | undefined = undefined;
      for (const [ex, c] of Object.entries(agg.exchangeCandles)) {
        if (!c) continue;
        const price = c.close;
        if (bestPrice === undefined || price < bestPrice) { bestPrice = price; bestEx = ex; }
      }
      return { price: bestPrice, exchange: bestEx };
    } else {
      // seller wants highest bid
      let bestPrice: number | undefined = undefined;
      let bestEx: string | undefined = undefined;
      for (const [ex, c] of Object.entries(agg.exchangeCandles)) {
        if (!c) continue;
        const price = c.close;
        if (bestPrice === undefined || price > bestPrice) { bestPrice = price; bestEx = ex; }
      }
      return { price: bestPrice, exchange: bestEx };
    }
  }

  /**
   * Best executable price considering fees/slippage per venue.
   * options.fees: Record<venue, feeDecimal>
   * options.slippage: decimal (e.g., 0.001 for 0.1%) applied as additive
   */
  getBestExecutablePrice(symbol: string, side: 'buy' | 'sell', options?: { fees?: Record<string, number>; slippage?: number }) {
    const agg = this.aggregatedCache.get(symbol);
    if (!agg) return { price: undefined };
    const fees = options?.fees ?? {};
    const slippage = options?.slippage ?? 0.001;

    let bestEff: number | undefined = undefined;
    let bestEx: string | undefined = undefined;

    for (const [ex, c] of Object.entries(agg.exchangeCandles)) {
      if (!c) continue;
      const fee = fees[ex] ?? 0;
      const price = c.close;
      let eff = price;
      if (side === 'buy') {
        eff = price * (1 + slippage + fee);
        if (bestEff === undefined || eff < bestEff) { bestEff = eff; bestEx = ex; }
      } else {
        eff = price * (1 - (slippage + fee));
        if (bestEff === undefined || eff > bestEff) { bestEff = eff; bestEx = ex; }
      }
    }

    return { price: bestEff, exchange: bestEx };
  }

  /**
   * Get aggregated state for a symbol (may be undefined)
   */
  getAggregated(symbol: string): AggregatedCandle | undefined {
    return this.aggregatedCache.get(symbol);
  }

  /**
   * Get per-exchange map (read-only copy)
   */
  getPerExchange(symbol: string): Record<string, Candle | undefined> {
    const out: Record<string, Candle | undefined> = {};
    const per = this.store.get(symbol);
    if (!per) return out;
    for (const [k, v] of per.entries()) out[k] = v;
    return out;
  }

  /**
   * Remove stale exchanges for a symbol (cleanup)
   */
  pruneStale(symbol: string): void {
    const per = this.store.get(symbol);
    if (!per) return;
    const now = Date.now();
    for (const [exchange, candle] of per.entries()) {
      if (!candle) continue;
      if (now - candle.ts > this.freshnessMs * 10) {
        per.delete(exchange);
      }
    }
  }
}
