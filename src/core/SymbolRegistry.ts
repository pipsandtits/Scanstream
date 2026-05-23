export interface SymbolConfig {
  symbol: string;          // "BTC/USDT"
  exchanges: string[];     // ["binance", "bybit", "okx", "kraken"]
  timeframes: string[];    // ["1m", "5m", "15m", "1h", "4h", "1d"]
  active: boolean;
  excludeFrom?: string[]; // optional per-symbol exchange exclusions
}

export class SymbolRegistry {
  private symbols = new Map<string, SymbolConfig>();

  getAll(): SymbolConfig[] {
    return Array.from(this.symbols.values());
  }

  get(symbol: string): SymbolConfig | undefined {
    return this.symbols.get(symbol);
  }

  set(config: SymbolConfig) {
    this.symbols.set(config.symbol, config);
  }

  has(symbol: string): boolean {
    return this.symbols.has(symbol);
  }

  clear() {
    this.symbols.clear();
  }

  // Populate registry from an exchanges Map (exchangeName -> exchangeInstance.markets)
  // Expects a map-like object: { exchangeName: { markets: { SYMBOL: ... } } }
  populateFromExchanges(exchanges: Map<string, any> | Record<string, any>) {
    // Normalize to iterable entries
    const entries: Array<[string, any]> = exchanges instanceof Map ? Array.from(exchanges.entries()) : Object.entries(exchanges);

    for (const [exchangeName, exchangeObj] of entries) {
      try {
        const markets = (exchangeObj && exchangeObj.markets) || {};
        for (const symbol of Object.keys(markets)) {
          const canonical = symbol;
          const existing = this.symbols.get(canonical);
          if (!existing) {
            this.symbols.set(canonical, {
              symbol: canonical,
              exchanges: [exchangeName],
              timeframes: ['1m','5m','15m','1h','4h','1d'],
              active: true
            });
          } else if (!existing.exchanges.includes(exchangeName)) {
            existing.exchanges.push(exchangeName);
          }
        }
      } catch (e) {
        // ignore malformed exchange entries
      }
    }

    // Remove known bad entries and apply requested renames/exclusions
    this.symbols.delete('LENS/USDT');
    this.symbols.delete('GGM/USDT');

    // rename MATIC/USDT -> POL/USDT if present
    if (this.symbols.has('MATIC/USDT')) {
      const cfg = this.symbols.get('MATIC/USDT')!;
      this.symbols.delete('MATIC/USDT');
      cfg.symbol = 'POL/USDT';
      this.symbols.set('POL/USDT', cfg);
    }

    // Per-symbol exclusions
    const bnb = this.symbols.get('BNB/USDT');
    if (bnb) bnb.excludeFrom = Array.from(new Set([...(bnb.excludeFrom||[]),'coinbase']));

    const bonk = this.symbols.get('BONK/USDT');
    if (bonk) bonk.excludeFrom = Array.from(new Set([...(bonk.excludeFrom||[]),'kucoinfutures']));
  }
}

export const symbolRegistry = new SymbolRegistry();
