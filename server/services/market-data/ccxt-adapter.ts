/**
 * CCXT Market Data Adapter
 * 
 * Wraps CCXT behind the universal MarketDataAdapter interface.
 * This is a thin layer that normalizes CCXT output to our canonical format.
 * 
 * ✅ Zero behavior change from existing code
 * ✅ All CCXT logic stays the same
 * ✅ Just hidden behind a clean interface
 */

import * as ccxt from 'ccxt';
import { EventEmitter } from 'events';
import type { MarketDataAdapter, Candle, Ticker, AdapterHealth } from '../../types/market-data';

/**
 * Single exchange adapter for CCXT
 * Example: BinanceMarketDataAdapter, KuCoinMarketDataAdapter, etc.
 */
export class CCXTMarketDataAdapter extends EventEmitter implements MarketDataAdapter {
  readonly venue: string;
  readonly assetClass: 'crypto' | 'forex' = 'crypto';
  
  private exchange: ccxt.Exchange;
  private lastError?: string;
  private errorCount: number = 0;
  private lastFetchTime?: number;
  private consecutiveFailures: number = 0;
  private marketsLoaded: boolean = false;
  private normalizeSymbolFn?: (s: string) => string;

  constructor(
    exchangeName: string,
    exchange: ccxt.Exchange
  ) {
    super();
    this.venue = exchangeName;
    this.exchange = exchange;
  }

  setNormalizeSymbol(fn: (s: string) => string) {
    this.normalizeSymbolFn = fn;
  }

  /**
   * Fetch OHLCV candles
   * 
   * Input: symbol, timeframe (seconds), since, limit
   * Output: normalized Candle array
   * 
   * ✅ This is the exact same logic as before
   * ✅ Just moved into an adapter class
   */
  async fetchOHLCV(
    symbol: string,
    timeframe: number,
    since?: number,
    limit?: number
  ): Promise<Candle[]> {
    const started = Date.now();
    try {
      // Lazy-load markets if not already done
      try {
        if (!this.marketsLoaded && (!this.exchange.markets || Object.keys(this.exchange.markets).length === 0)) {
          await this.exchange.loadMarkets();
          this.marketsLoaded = true;
        }
      } catch (merr) {
        // non-fatal — continue (some exchanges allow fetch without markets loaded)
        console.debug(`[${this.venue}] loadMarkets() failed (non-fatal):`, (merr as any)?.message || merr);
      }

      // Allow symbol normalization if provided
      if (this.normalizeSymbolFn) {
        symbol = this.normalizeSymbolFn(symbol);
      }
      // Convert seconds to CCXT format (M1, M5, H1, D1, etc)
      const ccxtTimeframe = this.secondsToTimeframe(timeframe);

      // Fetch raw OHLCV from exchange
      const rawCandles = await this.exchange.fetchOHLCV(
        symbol,
        ccxtTimeframe,
        since,
        limit || 100
      );

      // Normalize to our Candle format
      const candles: Candle[] = rawCandles.map((row) => ({
        ts: Math.floor((row[0] as any) || 0),
        open: Math.floor((row[1] as any) || 0),
        high: Math.floor((row[2] as any) || 0),
        low: Math.floor((row[3] as any) || 0),
        close: Math.floor((row[4] as any) || 0),
        volume: row[5] || 0,
        isFinal: this.isCandleFinal(Math.floor((row[0] as any) || 0), timeframe),
        // fetchOHLCV is a REST/backfill call — mark as historical and record adapter origin
        source: 'historical',
        origin: 'ccxt',
        venue: this.venue,
        raw: row,
      }));

      // Track success
      const elapsed = Date.now() - started;
      this.lastFetchTime = Date.now();
      this.consecutiveFailures = 0;
      this.errorCount = 0;
      this.lastError = undefined;

      // Emit adapter-level metrics
      try {
        this.emit('metrics', { venue: this.venue, symbol, timeframe, latency: elapsed, success: true, count: candles.length });
      } catch (em) {
        // ignore
      }

      return candles;
    } catch (error: any) {
      const elapsed = Date.now() - started;
      this.errorCount++;
      this.consecutiveFailures++;
      this.lastError = error?.message || 'Unknown error';

      console.error(
        `[${this.venue}] fetchOHLCV(${symbol}, ${timeframe}s) failed:`,
        error?.message
      );

      // Emit adapter-level failure metrics
      try {
        this.emit('metrics', { venue: this.venue, symbol, timeframe, latency: elapsed, success: false, error: this.lastError });
      } catch (em) {}

      throw error;
    }
  }

  /**
   * Fetch ticker (optional)
   */
  async fetchTicker(symbol: string): Promise<Ticker> {
    try {
      const raw = await this.exchange.fetchTicker(symbol);

      return {
        symbol,
        timestamp: raw.timestamp || Date.now(),
        last: raw.last || 0,
        bid: raw.bid || 0,
        ask: raw.ask || 0,
        volume24h: raw.quoteVolume,
      };
    } catch (error: any) {
      console.error(`[${this.venue}] fetchTicker failed:`, error?.message);
      throw error;
    }
  }

  /**
   * Get adapter health status
   */
  async getHealth(): Promise<AdapterHealth> {
    const now = Date.now();
    const uptime = this.lastFetchTime ? now - this.lastFetchTime : 0;
    const latency = undefined as number | undefined;
    const rateLimit = (this.exchange as any)?.rateLimit || undefined;

    return {
      healthy: this.consecutiveFailures < 3 && uptime < 1000 * 60 * 10, // consider unhealthy if no fetch in last 10m
      lastCheckTime: now,
      lastFetchTime: this.lastFetchTime,
      latencyMs: latency,
      errorCount: this.errorCount,
      errorMessage: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      // Extra info (consumers may ignore):
      // @ts-ignore allow extra fields
      uptime,
      // @ts-ignore
      rateLimit,
    } as AdapterHealth;
  }

  /**
   * Convert seconds to CCXT timeframe string
   */
  private secondsToTimeframe(seconds: number): string {
    const minutes = seconds / 60;
    
    if (minutes < 60) {
      return `${Math.round(minutes)}m`;
    }
    
    const hours = minutes / 60;
    if (hours < 24) {
      return `${Math.round(hours)}h`;
    }
    
    const days = hours / 24;
    return `${Math.round(days)}d`;
  }

  /**
   * Determine if a candle is final (closed)
   * 
   * A candle is final if we're past its close time by at least half the interval.
   * This gives us confidence the broker has finalized it.
   */
  private isCandleFinal(openTime: number, timeframe: number): boolean {
    const now = Date.now();
    const closeTime = openTime + (timeframe * 1000);
    const halfInterval = (timeframe * 1000) / 2;

    return now >= closeTime + halfInterval;
  }
}

/**
 * Factory to create CCXT adapters for multiple exchanges
 * 
 * Usage:
 * ```
 * const adapters = CCXTAdapterFactory.createMultiple([
 *   'binance', 'kucoinfutures', 'okx'
 * ]);
 * ```
 */
export class CCXTAdapterFactory {
  /**
   * Create a single CCXT adapter
   */
  static create(exchangeName: string): CCXTMarketDataAdapter {
    const ExchangeClass = ccxt[exchangeName as keyof typeof ccxt] as any;

    if (!ExchangeClass) {
      throw new Error(
        `Exchange ${exchangeName} not supported by CCXT. ` +
        `Available: ${Object.keys(ccxt).join(', ')}`
      );
    }

    const exchange = new ExchangeClass({
      enableRateLimit: true,
      // Don't load markets here — lazy load on first use
    });

    return new CCXTMarketDataAdapter(exchangeName, exchange);
  }

  /**
   * Create multiple CCXT adapters
   */
  static createMultiple(
    exchangeNames: string[]
  ): Map<string, CCXTMarketDataAdapter> {
    const adapters = new Map<string, CCXTMarketDataAdapter>();

    for (const name of exchangeNames) {
      try {
        const adapter = this.create(name);
        adapters.set(name, adapter);
      } catch (error: any) {
        console.warn(`Failed to create adapter for ${name}:`, error.message);
      }
    }

    return adapters;
  }
}
