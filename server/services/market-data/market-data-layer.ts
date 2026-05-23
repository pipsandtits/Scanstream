/**
 * Market Data Layer (MDL) Orchestrator
 * 
 * Coordinates:
 * - Adapter selection
 * - Integrity checking
 * - Storage
 * - Event emission
 * 
 * This is what the rest of the system calls.
 * All complex logic is hidden here.
 */

import type {
  MarketDataAdapter,
  Candle,
  WorldTick,
  WorldState,
  IntegrityIssue,
  OperationMode,
} from '../../types/market-data';

import { MarketDataIntegrityChecker } from './integrity-checker';
import { storage } from '../../storage';
import { EventEmitter } from 'events';
import { getRegimeService } from '../regime-service';
import { symbolManager } from '../symbol-manager';
import type { SymbolRuntimeState } from '../../types/symbol-universe';

export class MarketDataLayer extends EventEmitter implements WorldState {
  private adapters: Map<string, MarketDataAdapter>;
  private integrity: MarketDataIntegrityChecker;
  private adapterPriority: string[];
  // Concurrency control
  private maxConcurrentRequests = 5;
  private activeRequests = 0;
  private requestQueue: Array<() => void> = [];

  constructor(
    adapters: Map<string, MarketDataAdapter>,
    adapterPriority?: string[]
  ) {
    super();
    this.adapters = adapters;
    this.integrity = new MarketDataIntegrityChecker();
    
    // Default priority: try adapters in order
    this.adapterPriority = adapterPriority || Array.from(adapters.keys());
  }

  setConcurrency(n: number): void {
    this.maxConcurrentRequests = Math.max(1, Math.floor(n));
    console.log(`[MDL] concurrency set to ${this.maxConcurrentRequests}`);
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrentRequests) {
      this.activeRequests++;
      return;
    }

    return new Promise(resolve => {
      this.requestQueue.push(() => {
        this.activeRequests++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.requestQueue.shift();
    if (next) next();
  }

  /**
   * Fetch and validate candles
   * 
   * This is the main entry point for fetching market data.
   * It handles:
   * - Adapter selection
   * - Integrity validation
   * - Gap healing
   * - Storage
   * - Event emission
   */
  async fetchAndValidate(
    symbol: string,
    timeframe: number,
    since?: number,
    limit?: number,
    adapterHint?: string
  ): Promise<Candle[]> {
    await this.acquireSlot();
    const start = Date.now();
    // Select adapter
    const adapter = this.selectAdapter(adapterHint);
    if (!adapter) {
      const err = new Error('No market data adapters available');
      this.emit('metrics', { adapter: adapterHint || 'none', latency: Date.now() - start, success: false, error: err.message });
      this.releaseSlot();
      throw err;
    }

    // Fetch raw candles
    console.log(`[MDL] Fetching ${symbol} ${timeframe}s from ${adapter.venue}`);
    let rawCandles: Candle[] = [];
    try {
      rawCandles = await adapter.fetchOHLCV(symbol, timeframe, since, limit);
    } catch (err: any) {
      this.emit('metrics', { adapter: adapter.venue || adapterHint || 'unknown', latency: Date.now() - start, success: false, error: (err && err.message) || String(err) });
      this.releaseSlot();
      throw err;
    }

    // Validate integrity
    console.log(
      `[MDL] Validating ${rawCandles.length} candles for ${symbol}`
    );
    const result = await this.integrity.validate(
      rawCandles,
      symbol,
      timeframe
    );

    // Report issues
    if (result.issues.length > 0) {
      result.issues.forEach((issue: IntegrityIssue) => {
        this.emit('integrity.issue', issue);
      });
    }

    // Attempt healing if needed
    if (result.backfillRequired && result.valid) {
      try {
        const healed = await this.integrity.healGap(
          adapter,
          symbol,
          timeframe,
          result.backfillRequired.from,
          result.backfillRequired.to
        );

        // Merge healed candles
        result.candles = this.mergeCandles(result.candles, healed);
      } catch (error: any) {
        console.warn(
          `[MDL] Gap healing failed, proceeding with gap:`,
          error.message
        );
      }
    }

    // Return validated candles
    if (!result.valid) {
      console.error(
        `[MDL] Validation failed for ${symbol}, but returning candles anyway`
      );
    }
    // Emit metrics about fetch
    this.emit('metrics', { adapter: adapter.venue || adapterHint || 'unknown', latency: Date.now() - start, success: true, candles: result.candles.length });
    this.releaseSlot();

    return result.candles;
  }

  /**
   * Batch fetch multiple symbols/timeframes (concurrent, bounded by concurrency)
   */
  async batchFetchAndValidate(requests: Array<{ symbol: string; timeframe: number; since?: number; limit?: number; adapterHint?: string }>) {
    const promises = requests.map(r => this.fetchAndValidate(r.symbol, r.timeframe, r.since, r.limit, r.adapterHint).then(
      data => ({ ok: true, data, req: r }),
      err => ({ ok: false, error: err, req: r })
    ));

    return Promise.all(promises);
  }

  /**
   * Emit a world tick (candle event)
   * 
   * ⚠️  DEPRECATED: Use IntegrityGate.storeValidatedCandles() instead
   * 
   * This method is kept for backward compatibility, but the preferred path is:
   * 1. Data source (CCXT/adapter) fetches candles
   * 2. IntegrityGate validates and stores
   * 3. IntegrityGate emits 'world.tick' event automatically
   * 
   * This MDL.emitWorldTick() is only for manual emission (e.g., replay, testing).
   * 
   * This is how the RPG system learns that time advanced.
   */
  async emitWorldTick(
    symbol: string,
    timeframe: number,
    candle: Candle
  ): Promise<void> {
    const tick: WorldTick = {
      symbol,
      timeframe,
      worldTime: candle.ts + (timeframe * 1000),  // Canonical market time
      emitTime: Date.now(),                       // Wall-clock emission time
      candle,
      isFinal: candle.isFinal,
      source: candle.source || 'unknown',
      mode: 'LIVE' as any as OperationMode,  // TODO: Determine actual operation mode
    };

    // Attach regimeContext if available (non-blocking best-effort)
    try {
      const regimeSvc = getRegimeService();
      const regime = await regimeSvc.computeRegime(symbol, timeframe);
      if (regime) {
        // safe cast to allow optional field
        (tick as any).regimeContext = regime;
      }
    } catch (err) {
      // Don't block emission on regime failures
      console.warn('[MDL] regime attach failed:', (err as any)?.message || err);
    }

    // Emit to RPG system (world.tick now may include regimeContext)
    this.emit('world.tick', tick);

    // Store in database (redundant if called from IntegrityGate)
    try {
      await storage.createMarketFrame({
        symbol,
        price: candle.close,
        volume: candle.volume,
        indicators: {
          timestamp: candle.ts,
          isFinal: candle.isFinal,
          source: candle.source,
        },
        orderFlow: {},
        marketMicrostructure: {},
      });
    } catch (error: any) {
      console.error(
        `[MDL] Failed to store candle for ${symbol}:`,
        error.message
      );
    }
  }

  /**
   * Get candles from storage (world state snapshot)
   */
  async getSnapshot(
    symbol: string,
    timeframe: number,
    lookback: number
  ): Promise<Candle[]> {
    try {
      const frames = await storage.getMarketFrames(symbol, lookback);

      return frames
        .filter((f: any) => f.timeframe === timeframe || f.timeframe?.toString() === timeframe.toString())
        .map((f: any) => ({
          ts: f.timestamp.getTime(),
          open: f.open,
          high: f.high,
          low: f.low,
          close: f.close,
          volume: f.volume || 0,
          isFinal: f.isFinal || false,
          source: f.source,
        }));
    } catch (error: any) {
      console.error(`[MDL] Failed to get snapshot for ${symbol}:`, error.message);
      return [];
    }
  }

  /**
   * Get latest candle for an asset
   */
  async getLatest(
    symbol: string,
    timeframe: number
  ): Promise<Candle | undefined> {
    const snapshot = await this.getSnapshot(symbol, timeframe, 1);
    return snapshot[0];
  }

  /**
   * Build an enriched runtime state for a symbol by combining SymbolManager hints
   * with live adapter health and recent market volume.
   */
  async getSymbolRuntimeState(symbol: string, currentMode: 'LIVE' | 'REPLAY' = 'LIVE'): Promise<SymbolRuntimeState | null> {
    const base = symbolManager.getRuntimeState(symbol, currentMode as any);
    if (!base) return null;

    // Determine venue availability: any adapter that supports this symbol and is healthy
    let venueAvailable = false;
    try {
      for (const [venue, adapter] of this.adapters.entries()) {
        // If this symbol is listed for this venue
        const symDef = symbolManager.getSymbol(symbol);
        if (symDef && symDef.venues && Object.prototype.hasOwnProperty.call(symDef.venues, venue)) {
          if (adapter.getHealth) {
            try {
              const h = await adapter.getHealth();
              if (h.healthy) { venueAvailable = true; break; }
            } catch (err) {
              // ignore individual adapter errors
            }
          } else {
            // No health endpoint - assume adapter present
            venueAvailable = true;
            break;
          }
        }
      }
    } catch (err) {
      // Non-fatal
      console.warn('[MDL] getSymbolRuntimeState adapter health check failed:', (err as any)?.message || err);
    }

    // Estimate liquidity using recent candles (hourly window if available)
    let liquidityState: 'HIGH' | 'MEDIUM' | 'LOW' = base.liquidityState;
    try {
      const recent = await this.getSnapshot(symbol, 3600, 24).catch(() => []);
      const totalVol = recent.reduce((acc, c) => acc + (c.volume || 0), 0);
      const avgVol = recent.length ? totalVol / recent.length : 0;
      if (avgVol >= 1_000_000) liquidityState = 'HIGH';
      else if (avgVol >= 10_000) liquidityState = 'MEDIUM';
      else liquidityState = 'LOW';
      // Update popularity score with a bounded metric
      symbolManager.setPopularity(symbol, Math.min(10_000_000_000, Math.round(avgVol)));
    } catch (err) {
      // ignore
    }

    const enriched: SymbolRuntimeState = {
      ...base,
      venueAvailable,
      liquidityState,
      isTradeable: base.isMarketOpen && venueAvailable && liquidityState !== 'LOW' && !!base.meta,
      lastTradeTs: (await this.getLatest(symbol, 60))?.ts || base.lastTradeTs,
      lastQuoteTs: (await this.getLatest(symbol, 1))?.ts || base.lastQuoteTs,
      estimatedSpread: undefined,
      meta: base.meta,
    };

    return enriched;
  }

  /**
   * Select an adapter
   * Priority: explicit hint > priority list > first available
   */
  private selectAdapter(hint?: string): MarketDataAdapter | undefined {
    if (hint) {
      const adapter = this.adapters.get(hint);
      if (adapter) return adapter;
      console.warn(`[MDL] Adapter hint '${hint}' not found in adapters map; falling back to priority list.`);
    }

    // Use configured priority list
    for (const venue of this.adapterPriority) {
      const adapter = this.adapters.get(venue);
      if (adapter) {
        console.log(`[MDL] selectAdapter -> using priority adapter '${venue}'`);
        return adapter;
      }
    }

    // Fallback: pick any adapter but log clearly
    const any = this.adapters.values().next();
    if (!any.done) {
      console.warn('[MDL] No adapter in priority list available, using first registered adapter');
      return any.value;
    }

    console.error('[MDL] No adapters available (empty map)');
    return undefined;
  }

  /**
   * Merge two candle arrays, removing duplicates
   */
  private mergeCandles(existing: Candle[], new_: Candle[]): Candle[] {
    const map = new Map<number, Candle>();
    for (const c of existing) map.set(c.ts, c);
    for (const c of new_) map.set(c.ts, c);
    const merged = Array.from(map.values());
    return merged.sort((a, b) => a.ts - b.ts);
  }
}

/**
 * Global MDL instance
 * Initialized during server startup
 */
let mdlInstance: MarketDataLayer | null = null;

export function initializeMarketDataLayer(
  adapters: Map<string, MarketDataAdapter>,
  adapterPriority?: string[]
): MarketDataLayer {
  mdlInstance = new MarketDataLayer(adapters, adapterPriority);
  console.log('[MDL] Market Data Layer initialized');
  return mdlInstance;
}

export function getMarketDataLayer(): MarketDataLayer {
  if (!mdlInstance) {
    throw new Error('Market Data Layer not initialized');
  }
  return mdlInstance;
}
