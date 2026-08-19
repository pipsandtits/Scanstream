/**
 * PHASE 2: Storage Integration + World Tick Emission
 * 
 * Flow (CORRECT ORDER — non-negotiable):
 * 
 * SOURCE (CCXT / OANDA / MT5)
 *   ↓
 * ADAPTER (normalizes raw data)
 *   ↓
 * INGESTION BUFFER
 *   ↓
 * INTEGRITY & GAP CHECKS ← YOU ARE HERE
 *   ↓
 * CANDLE FINALITY LOGIC
 *   ↓
 * 📍 WORLD TICK EMISSION ← GATES HAPPEN HERE
 *   ↓
 * storage.createMarketFrame() (only validated candles reach here)
 *   ↓
 * RPG / AGENTS / STRATEGIES (subscribe to world.tick)
 * 
 * CRITICAL RULE:
 * No agent is allowed to react to raw adapter output.
 * Agents only react to World Ticks (validated, canonical facts).
 */

import { CandleIntegrityLayer, CandleIntegrityFactory } from './candle-integrity-layer';
import type { Candle, ValidatedCandle, WorldTick, OperationMode } from '../../types/market-data';
import { OperationMode as Mode } from '../../types/market-data';
import { getModeDetector } from './mode-detector';
import { getTimeAnchorManager } from './time-anchor';
import { storage } from '../../storage';
import { EventEmitter } from 'events';

/**
 * ⏰ TEMPORAL HYGIENE — Single source of truth for LIVE mode
 */
class LiveEpoch {
  private static instance: LiveEpoch;
  private _liveStartTime: number | null = null;
  private lastWorldTimePerSymbol = new Map<string, number>();
  private timeAuthorityPerSymbol = new Map<string, string>(); // symbol -> exchange

  private constructor() {}

  static getInstance(): LiveEpoch {
    if (!LiveEpoch.instance) {
      LiveEpoch.instance = new LiveEpoch();
    }
    return LiveEpoch.instance;
  }

  /**
   * Initialize LIVE epoch (call once at startup after backfill completes)
   */
  initializeLiveStart(): void {
    if (this._liveStartTime === null) {
      // Round down to nearest minute to avoid subsecond jitter
      this._liveStartTime = Math.floor(Date.now() / 60000) * 60000;
      console.log(`[LiveEpoch] ✅ LIVE mode activated at ${new Date(this._liveStartTime).toISOString()}`);
    }
  }

  /**
   * Register time authority for a symbol (first exchange to emit = authority)
   * Returns true if this exchange is the authority, false if another is
   */
  registerTimeAuthority(symbol: string, exchange: string): boolean {
    const existing = this.timeAuthorityPerSymbol.get(symbol);
    
    if (!existing) {
      this.timeAuthorityPerSymbol.set(symbol, exchange);
      console.log(`[TimeAuthority] ${symbol} ← ${exchange} (LIVE authority)`);
      return true;
    }

    if (existing === exchange) {
      return true; // Same authority, allowed
    }

    // Different exchange trying to emit — reject for LIVE
    return false;
  }

  /**
   * Get time authority for symbol
   */
  getTimeAuthority(symbol: string): string | undefined {
    return this.timeAuthorityPerSymbol.get(symbol);
  }

  /**
   * Check if a candle timestamp is before LIVE start
   */
  isHistorical(candleTs: number): boolean {
    if (this._liveStartTime === null) {
      // Not initialized yet — treat as historical
      return true;
    }
    return candleTs < this._liveStartTime;
  }

  /**
   * Check if worldTime moves backward (time regression)
   */
  isTimeRegression(symbol: string, worldTime: number): boolean {
    const lastTime = this.lastWorldTimePerSymbol.get(symbol);
    if (!lastTime) {
      this.lastWorldTimePerSymbol.set(symbol, worldTime);
      return false;
    }

    const isRegression = worldTime < lastTime;
    this.lastWorldTimePerSymbol.set(symbol, Math.max(lastTime, worldTime));
    return isRegression;
  }

  /**
   * Get LIVE start epoch
   */
  get liveStartTime(): number | null {
    return this._liveStartTime;
  }

  /**
   * Reset (for testing)
   */
  reset(): void {
    this._liveStartTime = null;
    this.lastWorldTimePerSymbol.clear();
    this.timeAuthorityPerSymbol.clear();
  }
}

export function getLiveEpoch(): LiveEpoch {
  return LiveEpoch.getInstance();
}

// Diagnostic helper to expose internals
export function dumpLiveEpochDiagnostics() {
  const le = getLiveEpoch() as any;
  return {
    liveStartTime: le.liveStartTime,
    lastWorldTimePerSymbol: Array.from(le['lastWorldTimePerSymbol'].entries ? le['lastWorldTimePerSymbol'].entries() : []),
    timeAuthorityPerSymbol: Array.from(le['timeAuthorityPerSymbol'].entries ? le['timeAuthorityPerSymbol'].entries() : []),
  };
}

export class IntegrityGate extends EventEmitter {
  // Track last time we logged a time-regression per symbol to avoid spam
  private lastRegressionLog: Map<string, number> = new Map();
  /**
   * Process candles through integrity layer before storage
   * 
   * This is the critical gate between market data and trading logic.
   * 
   * Order is non-negotiable:
   * 1. Validate (check timestamps, continuity, OHLC, finality)
   * 2. Store (only valid candles reach storage)
   * 3. Emit World Tick (facts only, after validation)
   * 4. Agents react to World Ticks (never to raw data)
   * 
   * @param symbol Trading pair
   * @param timeframe Candle timeframe in seconds
   * @param candles Array of raw candles
   * @param exchange Exchange source (for time authority validation)
   */
  async storeValidatedCandles(
    symbol: string,
    timeframe: number,
    candles: Candle[],
    exchange?: string
  ): Promise<{
    stored: ValidatedCandle[];
    rejected: Candle[];
    gaps: any[];
    ticks: WorldTick[];
  }> {
    // Get or create integrity layer for this pair
    const layer = CandleIntegrityFactory.getOrCreate(symbol, timeframe);

    // Validate and normalize
    const report = layer.validateAndNormalize(candles);

    // Emit report for monitoring
    this.emit('integrity.report', report);

    // Store only valid candles and emit World Ticks
    const stored: ValidatedCandle[] = [];
    const ticks: WorldTick[] = [];
    const liveEpoch = getLiveEpoch();
    const source = exchange ? 'WS' : 'REST'; // WS has exchange, REST doesn't
    
    for (const validCandle of report.valid) {
      try {
        // ✅ Accept all data without emit-lag filtering
        // REST: historical, WS: whatever comes (may be replay/backtest data)
        
        // Convert Candle to MarketFrame format (compatible with storage)
        // Construct MarketFrame and include any optional enrichments if available
        const marketFrame: any = {
          symbol,
          timeframe,
          timestamp: new Date(validCandle.ts),
          open: validCandle.open,
          high: validCandle.high,
          low: validCandle.low,
          close: validCandle.close,
          volume: validCandle.volume,
          isFinal: validCandle.isFinal,
        };

        // Attach optional enrichment payloads when present on the validated candle
        if ((validCandle as any).price) {
          marketFrame.price = (validCandle as any).price;
        } else {
          // Provide a minimal price snapshot to keep schema consistent
          marketFrame.price = {
            open: validCandle.open,
            high: validCandle.high,
            low: validCandle.low,
            close: validCandle.close,
          };
        }

        if ((validCandle as any).indicators) {
          marketFrame.indicators = (validCandle as any).indicators;
        }

        if ((validCandle as any).orderFlow) {
          marketFrame.orderFlow = (validCandle as any).orderFlow;
        }

        if ((validCandle as any).marketMicrostructure) {
          marketFrame.marketMicrostructure = (validCandle as any).marketMicrostructure;
          
          // Signal microstructure readiness to mode detector
          // Once we have populated microstructure data, LIVE mode becomes possible
          const modeDetector = getModeDetector();
          const micro = (validCandle as any).marketMicrostructure;
          
          // Check if microstructure is populated (not all zeros)
          const hasMicrostructure = (
            (micro.spread && micro.spread > 0) ||
            (micro.depth && micro.depth > 0) ||
            (micro.imbalance && micro.imbalance !== 0.5)
          );
          
          if (hasMicrostructure) {
            modeDetector.setMicrostructureActive(true);
          }
        }

        // CRITICAL SEMANTIC: worldTime = candle close time (market time, not wall-clock)
        // This ensures replay alignment, cross-timeframe consistency, and physics accuracy
        const worldTime = validCandle.ts + (timeframe * 1000);

        // TEMPORAL HYGIENE CHECKS — evaluated BEFORE storage, so a temporally
        // incoherent candle never becomes canonical data.
        const liveEpochForCandle = getLiveEpoch();
        // Consider this candle historical if explicitly marked OR it predates LIVE start
        const candleIsHistorical = ((validCandle as any).source === 'historical') || liveEpochForCandle.isHistorical(validCandle.ts);
        // Only check for time regression on non-historical (live) candles
        const hasTimeRegression = candleIsHistorical ? false : liveEpochForCandle.isTimeRegression(symbol, worldTime);

        if (hasTimeRegression) {
          // Rate-limit regression logs per symbol (30s)
          const last = this.lastRegressionLog.get(symbol) || 0;
          const now = Date.now();
          if (now - last > 30_000) {
            console.error(
              `[IntegrityGate] ⛔ TIME REGRESSION: ${symbol} ${timeframe}s ` +
              `(current=${new Date(worldTime).toISOString()}) — candle REJECTED before storage`
            );
            this.lastRegressionLog.set(symbol, now);
          }

          // Neither store nor emit: time is incoherent.
          report.rejected.push({ candle: validCandle as any as Candle, reason: 'time_regression' } as any);
          continue; // process next validated candle
        }

        // ATOMIC OPERATION: Store THEN emit tick
        // INVARIANT: A world tick is emitted IF storage succeeded
          try {
          // 1. Store to database/memory (MUST succeed first) and capture saved id
          const savedFrame = await storage.createMarketFrame(marketFrame);
          stored.push(validCandle);

          // 2. 📍 EMIT WORLD TICK (facts only, after storage succeeds)
          // This is the atomic event that drives the RPG and all agents.
          // Agents ONLY react to world ticks, never to raw data.
          const emitTime = Date.now();
          const lag = emitTime - worldTime;

          // 🔄 DETECT OPERATION MODE
          const modeDetector = getModeDetector();
          // Determine tick source: prefer explicit exchange-derived source (exchange param),
          // fall back to validated candle source flag. Normalize to 'ws'|'rest'.
          const inferredSource = (exchange || '').toString().length > 0 ? 'ws' : (((validCandle as any).source === 'live') ? 'ws' : 'rest');
          try { modeDetector.recordTick(inferredSource as any); } catch (e) { /* ignore */ }
          
          // Only record emit-lag if this is LIVE (non-historical)
          if (!candleIsHistorical) {
            modeDetector.recordEmitLag(lag);
          }
          
          // 🔴 TIME AUTHORITY CHECK — One exchange per symbol in LIVE mode
          // If this exchange is not the authority, reject it for LIVE
          let isAuthorized = true;
          if (exchange && !candleIsHistorical) {
            // Try to register this exchange as authority
            isAuthorized = liveEpoch.registerTimeAuthority(symbol, exchange);
            
            if (!isAuthorized) {
              const authority = liveEpoch.getTimeAuthority(symbol);
              console.warn(
                `[IntegrityGate] ⚠️ MULTI-EXCHANGE CONFLICT: ${symbol} ← ${exchange} ` +
                `(authority=${authority}) — downgrading to MIXED`
              );
              // Emit event to signal authority conflict
              this.emit('time-authority-conflict', { symbol, exchange, authority });
            }
          }
          
          const mode = modeDetector.detectMode();

          const tick: WorldTick = {
            symbol,
            timeframe,
            worldTime,      // Canonical market time when candle closed
            emitTime,       // Wall-clock time when we emitted this tick
            mode,           // 🔄 REPLAY | MIXED | LIVE
            candle: validCandle,
            isFinal: validCandle.isFinal,
            source: (validCandle as any).source || 'validated',
            marketFrameId: (savedFrame && (savedFrame as any).id) ? (savedFrame as any).id : undefined,
          };

          ticks.push(tick);
          this.emit('world.tick', tick);
          // Bridge: also emit on the Market Data Layer singleton so agents
          // subscribed to MDL receive world.tick events.
          (async () => {
            try {
              const { getMarketDataLayer } = await import('./market-data-layer');
              const mdl = getMarketDataLayer();
              try {
                mdl.emit('world.tick', tick);
                console.debug('[IntegrityGate] bridged world.tick to MDL');
              } catch (e) {
                // Non-fatal: MDL listeners may error; don't disrupt integrity flow
                console.debug('[IntegrityGate] failed to emit world.tick on MDL:', (e as any)?.message || e);
              }
            } catch (e) {
              // MDL may not be initialized yet in some startup sequences
            }
          })();

          // Log with explicit mode label
          const modeLabel = `mode=${mode}`;
          const historicalLabel = candleIsHistorical ? ' [HISTORICAL]' : '';
          const exchangeLabel = exchange ? ` [${exchange}]` : '';
          console.log(
            `[IntegrityGate] ✅ World Tick: ${symbol} ${timeframe}s ` +
            `(world=${new Date(worldTime).toISOString()}, ` +
            `emit-lag=${lag}ms)${historicalLabel}${exchangeLabel} ` +
            `${modeLabel}`
          );
        } catch (storageErr) {
          // CRITICAL: Storage failed — suppress tick emission
          // INVARIANT: Tick must not exist without storage
          console.error(
            `[IntegrityGate] Storage failed for ${symbol} — tick suppressed:`,
            storageErr
          );
          this.emit('storage.error', {
            symbol,
            candle: validCandle,
            error: storageErr,
            tickSuppressed: true,
          });
        }
      } catch (err) {
        // Outer catch: validation/conversion errors (should not happen)
        console.error(`[IntegrityGate] Processing error for ${symbol}:`, err);
      }
    }

    // Report gaps (PHASE 3: Visibility without healing)
    if (report.gaps.length > 0) {
      const liveEpoch = getLiveEpoch();
      const modeDetector = getModeDetector();
      
      // If we have gaps during LIVE window, downgrade to MIXED
      // LIVE mode requires continuous, unbroken feed
      if (liveEpoch.liveStartTime && report.gaps.some(g => g.from >= liveEpoch.liveStartTime!)) {
        console.warn(
          `[IntegrityGate] 🟡 Gap detected during LIVE window for ${symbol}:${timeframe} — ` +
          `forcing MIXED mode (no gap healing in LIVE)`
        );
        // This will cause next mode detection to return MIXED
        modeDetector.setBackfillComplete(false);
      }
      
      console.warn(
        `[IntegrityGate] 📊 Detected ${report.gaps.length} gaps for ${symbol}:${timeframe}`
      );
      
      // Emit aggregate event
      this.emit('gaps.detected', { symbol, timeframe, gaps: report.gaps });
      
      // PHASE 3: Emit individual gap events for agent monitoring
      // Agents can subscribe to 'gap.detected' to implement visibility-first logic
      for (const gap of report.gaps) {
        this.emit('gap.detected', {
          symbol,
          timeframe,
          gap,
          severity: gap.missingCandles > 10 ? 'high' : 'medium',
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Report rejections
    if (report.rejected.length > 0) {
      console.warn(`[IntegrityGate] Rejected ${report.rejected.length} candles for ${symbol}:${timeframe}`);
      this.emit('candles.rejected', { symbol, timeframe, rejected: report.rejected });
    }

    return {
      stored,
      rejected: report.rejected.map(r => r.candle),
      gaps: report.gaps,
      ticks,
    };
  }

  /**
   * Batch process multiple symbol/timeframe pairs
   * 
   * Emits World Ticks for all validated candles
   */
  async storeBatch(pairs: Array<{
    symbol: string;
    timeframe: number;
    candles: Candle[];
  }>): Promise<Array<{
    symbol: string;
    timeframe: number;
    stored: ValidatedCandle[];
    rejected: Candle[];
    gaps: any[];
    ticks: WorldTick[];
  }>> {
    const results = [];

    for (const pair of pairs) {
      const result = await this.storeValidatedCandles(
        pair.symbol,
        pair.timeframe,
        pair.candles
      );

      results.push({
        symbol: pair.symbol,
        timeframe: pair.timeframe,
        ...result,
      });
    }

    return results;
  }

  /**
   * Get metrics for all symbol/timeframe pairs
   */
  getMetrics() {
    return CandleIntegrityFactory.getAllMetrics();
  }
}

// Global singleton
let globalIntegrityGate: IntegrityGate | null = null;

export function getIntegrityGate(): IntegrityGate {
  if (!globalIntegrityGate) {
    globalIntegrityGate = new IntegrityGate();

    // Listen for issues
    globalIntegrityGate.on('integrity.report', (report) => {
      if (report.rejected.length > 0 || report.continuity.hasGaps) {
        console.warn(
          `[Integrity] ${report.symbol} ${report.timeframe}s: ` +
          `${report.validCount}/${report.inputCount} valid, ` +
          `${report.gaps.length} gaps, ` +
          `${report.rejected.length} rejected`
        );
      }
    });

    globalIntegrityGate.on('gaps.detected', ({ symbol, timeframe, gaps }) => {
      for (const gap of gaps) {
        console.warn(
          `[Gap] ${symbol} ${timeframe}s: ` +
          `${gap.missingCandles} missing candles ` +
          `between ${new Date(gap.from).toISOString()} ` +
          `and ${new Date(gap.to).toISOString()}`
        );
      }
    });

    globalIntegrityGate.on('candles.rejected', ({ symbol, timeframe, rejected }) => {
      for (const r of rejected) {
        console.warn(
          `[Rejected] ${symbol} ${timeframe}s at ${new Date(r.candle.ts).toISOString()}: ` +
          `${r.reason}`
        );
      }
    });
  }

  return globalIntegrityGate;
}

export function initializeIntegrityGate(): IntegrityGate {
  return getIntegrityGate();
}
