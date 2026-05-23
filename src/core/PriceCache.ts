import { getAggregator } from './aggregator.singleton';

export type TickerData = { symbol: string; price: number; timestamp: number; exchange?: string; confidence?: number };
export type OHLCV = [number, number, number, number, number, number];

class PriceCache {
  private store: Map<string, TickerData> = new Map();
  private candles: Map<string, Map<string, OHLCV[]>> = new Map(); // symbol -> timeframe -> candles

  async refresh(symbol: string): Promise<void> {
    try {
      const agg = getAggregator();
      const data = await agg.getAggregatedPrice(symbol);
      this.store.set(symbol, { symbol, price: data.price, timestamp: Date.now(), exchange: data.sources?.[0], confidence: data.confidence });
    } catch (e) {
      // ignore failures — callers should handle missing data
    }
  }

  get(symbol: string): TickerData | null {
    return this.store.get(symbol) || null;
  }

  set(symbol: string, data: TickerData) {
    this.store.set(symbol, data);
  }

  async refreshCandles(symbol: string, timeframe: string = '1m', limit: number = 100) {
    try {
      const agg = getAggregator();
      const ohlcv = await agg.getOHLCV(symbol, timeframe, limit);
      if (!this.candles.has(symbol)) this.candles.set(symbol, new Map());
      this.candles.get(symbol)!.set(timeframe, ohlcv.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume] as OHLCV));
    } catch (e) {
      // noop
    }
  }

  getCandles(symbol: string, timeframe: string): OHLCV[] {
    return this.candles.get(symbol)?.get(timeframe) || [];
  }
}

export const priceCache = new PriceCache();
