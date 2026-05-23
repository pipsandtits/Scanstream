import { EventEmitter } from 'events';
import type { CrossExchangeAggregator } from './cross-exchange-aggregator';

export type Consensus = {
  symbol: string;
  price: number | null;
  timestamp: number;
  sources: string[];
  confidence: number; // 0..100
};

/**
 * TruthEngine (Multi-Source Arbitration)
 * - Listens to world.tick events (via provided gate)
 * - Maintains per-symbol per-exchange latest prices
 * - Computes a consensus price using median/weighted rules
 * - Emits `consensus.updated` when canonical price changes
 */
export class TruthEngine extends EventEmitter {
  private store: Map<string, Consensus> = new Map();
  private aggregator: CrossExchangeAggregator;
  // staleness threshold (ms)
  private staleMs = 90_000;

  constructor(private gate: EventEmitter, aggregator: CrossExchangeAggregator) {
    super();
    this.aggregator = aggregator;
    this.gate.on('world.tick', (tick: any) => this.onWorldTick(tick));
  }

  private onWorldTick(tick: any) {
    try {
      const symbol = tick.symbol;
      // compute consensus from aggregator (uses multiple sources)
      const per = this.aggregator.getPerExchange(symbol);
      const entries = Object.entries(per || {}).filter(([, v]) => !!v) as [string, any][];
      if (entries.length === 0) return;

      const now = Date.now();
      const sources = entries.map(([s]) => s);

      // Compute consensus price using volume-weighted if volume available, else weighted median by venue weight
      const venueHealthScores = this.aggregator.getAggregated(symbol)?.venueHealthScores || {};
      const consensusPrice = this.computeConsensusPrice(entries, venueHealthScores);

      // confidence: weighted composition of source count, freshness, and normalized spread
      const spread = Math.max(...entries.map(([, c]) => c.close)) - Math.min(...entries.map(([, c]) => c.close));
      const sourceFactor = Math.min(1, entries.length / 5);
      const freshnessWindow = this.staleMs;
      let fresh = 0;
      for (const [, c] of entries) if (now - (c.ts || 0) < freshnessWindow) fresh++;
      const freshnessFactor = fresh / Math.max(1, entries.length);
      const spreadFactor = spread > 0 && Math.abs(consensusPrice) > 0 ? Math.max(0, 1 - spread / Math.max(1e-8, Math.abs(consensusPrice))) : 1;

      const confidence = Math.round(100 * Math.min(1,
        (sourceFactor * 0.5) +
        (freshnessFactor * 0.3) +
        (spreadFactor * 0.2)
      ));

      const consensus: Consensus = {
        symbol,
        price: consensusPrice,
        timestamp: now,
        sources,
        confidence,
      };

      const prev = this.store.get(symbol);
      const prevStr = prev ? JSON.stringify(prev) : null;
      const nextStr = JSON.stringify(consensus);
      if (prevStr !== nextStr) {
        this.store.set(symbol, consensus);
        this.emit('consensus.updated', consensus);
        // forward to gate for observability
        try {
          this.gate.emit('consensus.updated', consensus);
        } catch (err) {
          // ignore
        }

        // Price deviation alert: emit if spread is abnormally high relative to consensus (>1%)
        try {
          const maxP = Math.max(...entries.map(([, c]) => c.close));
          const minP = Math.min(...entries.map(([, c]) => c.close));
          const spreadAbs = maxP - minP;
          if (consensus.price && spreadAbs > Math.max(1e-8, Math.abs(consensus.price) * 0.01)) {
            const alert = { symbol, spread: spreadAbs, median: consensus.price, sources: consensus.sources, timestamp: Date.now() };
            this.emit('consensus.alert', alert);
            try { this.gate.emit('consensus.alert', alert); } catch {};
          }
        } catch (e) {
          // ignore
        }
      }
    } catch (err) {
      console.error('[TruthEngine] onWorldTick error', err);
    }
  }

  /**
   * Compute consensus price from entries.
   * - Prefer volume-weighted average when volume data exists
   * - Otherwise compute a weighted median using venue health as weight
   */
  private computeConsensusPrice(entries: [string, any][], venueHealth: Record<string, number> = {}): number {
    // check for volume data
    let volSum = 0;
    let pvSum = 0;
    let hasVolume = false;
    for (const [, c] of entries) {
      if (typeof c.volume === 'number' && c.volume > 0) {
        hasVolume = true;
        volSum += c.volume;
        pvSum += c.close * c.volume;
      }
    }
    // Outlier trimming: if volumes present, apply trimming on price extremes before VWAP
    if (hasVolume && volSum > 0) {
      try {
        const prices = entries.map(([, c]) => ({ price: c.close, vol: c.volume || 0 }));
        if (prices.length >= 5) {
          // trim 10% top/bottom by price
          const trimPct = 0.10;
          const sorted = [...prices].sort((a, b) => a.price - b.price);
          const lowIndex = Math.floor(sorted.length * trimPct);
          const highIndex = Math.ceil(sorted.length * (1 - trimPct)) - 1;
          const lowPrice = sorted[Math.max(0, lowIndex)].price;
          const highPrice = sorted[Math.min(sorted.length - 1, highIndex)].price;
          let tVol = 0;
          let tPv = 0;
          for (const p of prices) {
            if (p.price >= lowPrice && p.price <= highPrice) {
              tVol += p.vol;
              tPv += p.price * p.vol;
            }
          }
          if (tVol > 0) return tPv / tVol;
        }
      } catch (e) {
        // fallback to plain VWAP
      }
      return pvSum / volSum;
    }

    // fallback: weighted median by venue health weights
    // Fallback: weighted median by venue health weights — apply outlier trimming first
    const weighted = entries.map(([exchange, c]) => ({ price: c.close, weight: venueHealth[exchange] ?? 1 }));
    // Trim extremes for robustness when we have enough venues
    let trimmed = weighted;
    if (weighted.length >= 5) {
      const trimPct = 0.10; // 10%
      const pricesOnly = weighted.map(w => w.price).sort((a, b) => a - b);
      const lowIndex = Math.floor(pricesOnly.length * trimPct);
      const highIndex = Math.ceil(pricesOnly.length * (1 - trimPct)) - 1;
      const lowPrice = pricesOnly[Math.max(0, lowIndex)];
      const highPrice = pricesOnly[Math.min(pricesOnly.length - 1, highIndex)];
      trimmed = weighted.filter(w => w.price >= lowPrice && w.price <= highPrice);
      if (trimmed.length === 0) trimmed = weighted;
    }
    // sort by price
    weighted.sort((a, b) => a.price - b.price);
    const totalW = trimmed.reduce((s, w) => s + (w.weight || 0), 0);
    if (totalW === 0) return trimmed.length ? trimmed[Math.floor(trimmed.length / 2)].price : NaN;
    let acc = 0;
    for (const w of trimmed) {
      acc += w.weight;
      if (acc >= totalW / 2) return w.price;
    }
    return weighted.length ? weighted[weighted.length - 1].price : NaN;
  }

  // New public API: getCanonicalPrice (alias for getConsensus)
  getCanonicalPrice(symbol: string): Consensus | undefined {
    return this.getConsensus(symbol);
  }

  // Check if the stored consensus for a symbol is stale
  isStale(symbol: string): boolean {
    const c = this.store.get(symbol);
    if (!c) return true;
    return (Date.now() - (c.timestamp || 0)) > this.staleMs;
  }

  getConsensus(symbol: string): Consensus | undefined {
    return this.store.get(symbol);
  }

  /**
   * Check whether the symbol has sufficient freshness and coverage to be considered tradeable.
   * Returns an object with `ok` boolean and `reason` string for observability.
   */
  isTradeable(symbol: string, opts?: { minSources?: number; minConfidence?: number; maxAgeMs?: number }): { ok: boolean; reason: string } {
    const minSources = opts?.minSources ?? 2;
    const minConfidence = opts?.minConfidence ?? 60; // 0..100
    const maxAgeMs = opts?.maxAgeMs ?? this.staleMs;

    const c = this.store.get(symbol);
    if (!c) return { ok: false, reason: 'no_consensus' };

    const age = Date.now() - (c.timestamp || 0);
    if (age > maxAgeMs) return { ok: false, reason: `stale:${age}` };

    if (!Array.isArray(c.sources) || c.sources.length < minSources) {
      return { ok: false, reason: `insufficient_sources:${(c.sources || []).length}` };
    }

    if (typeof c.confidence !== 'number' || c.confidence < minConfidence) {
      return { ok: false, reason: `low_confidence:${c.confidence ?? 'n/a'}` };
    }

    return { ok: true, reason: 'ok' };
  }
}

export default TruthEngine;
