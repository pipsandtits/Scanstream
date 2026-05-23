/**
 * SYMBOL MANAGER — Central Symbol Registry
 * 
 * Manages the canonical symbol universe:
 * - Registration and discovery
 * - Cross-venue symbol mapping
 * - Consistency validation
 * - Event notifications
 * 
 * This is the single source of truth for all symbols.
 */

import { EventEmitter } from 'events';
import type {
  Symbol,
  SymbolGroup,
  SymbolUIConfig,
  SymbolUniverseState,
  UniverseChangeEvent,
  SymbolLookupQuery,
  SymbolLookupResult,
  UniverseValidationRule,
  SymbolRuntimeState,
} from '../types/symbol-universe';
import { AssetClass } from '../types/symbol-universe';

/**
 * Default UI configuration
 * Consistent across all components
 */
const DEFAULT_UI_CONFIG: SymbolUIConfig = {
  showAssetClass: true,
  showQuote: true,
  showLiquidity: true,
  showTradingHours: true,
  abbreviate: false,
  colors: {
    [AssetClass.CRYPTO]: '#F7931A',      // Bitcoin orange
    [AssetClass.FOREX]: '#1E40AF',       // Deep blue
    [AssetClass.EQUITIES]: '#059669',    // Green
    [AssetClass.COMMODITIES]: '#DC2626', // Red
    [AssetClass.INDICES]: '#7C3AED',     // Purple
  },
  icons: {
    [AssetClass.CRYPTO]: '₿',            // Bitcoin symbol
    [AssetClass.FOREX]: '💱',            // Currency exchange
    [AssetClass.EQUITIES]: '📈',         // Chart
    [AssetClass.COMMODITIES]: '⛽',      // Fuel
    [AssetClass.INDICES]: '📊',          // Bar chart
  },
};

export class SymbolManager extends EventEmitter {
  private symbols: Map<string, Symbol> = new Map();
  private groups: Map<string, SymbolGroup> = new Map();
  private uiConfig: SymbolUIConfig = DEFAULT_UI_CONFIG;
  private validationRules: UniverseValidationRule[] = [];

  // Reverse mapping for quick lookups
  // venue -> exchange-format -> canonical-symbol
  private venueMapping: Map<string, Map<string, string>> = new Map();

  // Popularity / liquidity score for ordering watchlists
  private popularity: Map<string, number> = new Map();

  // Dependency graph for composite symbols (index -> components)
  private dependencyGraph: Map<string, Set<string>> = new Map();

  constructor() {
    super();
    this.initializeValidationRules();
  }

  /**
   * Register a new symbol in the universe
   * @throws if symbol already exists or validation fails
   */
  registerSymbol(symbol: Symbol): void {
    const canonical = this.normalizeSymbol(symbol.symbol);

    // Normalize and canonicalize fields
    const normalized: Symbol = {
      ...symbol,
      symbol: canonical,
      base: symbol.base?.toUpperCase(),
      quote: symbol.quote?.toUpperCase(),
      createdAt: symbol.createdAt || Date.now(),
    };

    // Check for duplicates using canonical form
    if (this.symbols.has(canonical)) {
      throw new Error(`Symbol already registered: ${canonical}`);
    }

    // Validate
    this.validate(normalized);

    // If instrument has already expired, mark inactive immediately
    if (normalized.metadata?.expirationDate && Date.now() > normalized.metadata.expirationDate) {
      normalized.active = false;
    }

    // Register
    this.symbols.set(canonical, normalized);

    // Index by venue
    for (const [venue, format] of Object.entries(normalized.venues)) {
      if (!this.venueMapping.has(venue)) {
        this.venueMapping.set(venue, new Map());
      }
      this.venueMapping.get(venue)!.set(format, canonical);
    }

    // Emit specific event and generic change event
    this.emit('symbol.added', { symbol: canonical, data: normalized });
    this.emitEvent({
      type: 'symbol.added',
      symbol: canonical,
      current: this.symbols.get(canonical),
      timestamp: Date.now(),
    });

    console.log(`[SymbolManager] Registered: ${canonical} (${symbol.assetClass})`);
  }

  /**
   * Register multiple symbols at once
   */
  registerBatch(symbols: Symbol[]): void {
    const errors: string[] = [];

    for (const symbol of symbols) {
      try {
        this.registerSymbol(symbol);
      } catch (error: any) {
        errors.push(error.message);
      }
    }

    if (errors.length > 0) {
      console.warn(
        `[SymbolManager] ${errors.length} registration errors:`,
        errors
      );
    }
  }

  /**
   * Get symbol by canonical name
   */
  getSymbol(canonical: string): Symbol | undefined {
    return this.symbols.get(this.normalizeSymbol(canonical));
  }

  /**
   * Resolve exchange format to canonical symbol
   * @param format Exchange-specific format (e.g., "BTCUSDT" on binance)
   * @param venue Exchange name (e.g., "binance")
   * @returns Canonical symbol or undefined
   */
  resolveVenue(format: string, venue: string): string | undefined {
    return this.venueMapping.get(venue)?.get(format);
  }

  /**
   * Get how a symbol should be formatted for a specific venue
   * @param canonical Canonical symbol (e.g., "BTC/USDT")
   * @param venue Exchange name (e.g., "binance")
   * @returns Exchange format or undefined if not available on this venue
   */
  getVenueFormat(canonical: string, venue: string): string | undefined {
    const symbol = this.getSymbol(canonical);
    return symbol?.venues[venue];
  }

  /**
   * Build a runtime state snapshot for a canonical symbol.
   * Returns `null` if symbol not found.
   */
  getRuntimeState(canonical: string, currentMode: 'LIVE' | 'REPLAY'): SymbolRuntimeState | null {
    const s = this.getSymbol(canonical);
    if (!s) return null;

    const now = Date.now();

    // Basic market-open heuristic: '24h' trading hours means always open.
    const tradingHours = s.metadata?.tradingHours ?? '24h';
    const isMarketOpen = tradingHours === '24h';

    // Venue availability unknown at this layer — assume true (data layer should override)
    const venueAvailable = true;

    // Simple liquidity heuristic using volume24h
    const vol = s.metadata?.volume24h ?? 0;
    const liquidityState: 'HIGH' | 'MEDIUM' | 'LOW' = vol >= 1_000_000 ? 'HIGH' : vol >= 10_000 ? 'MEDIUM' : 'LOW';

    const isTradeable = isMarketOpen && venueAvailable && liquidityState !== 'LOW' && !!s.active;

    const meta = {
      assetClass: s.assetClass,
      precisionPrice: s.metadata.precisionPrice,
      precisionSize: s.metadata.precisionSize,
      custody: s.metadata.custody,
      settlement: s.metadata.settlement,
      settlementCurrency: s.metadata.settlementCurrency,
      marginCurrency: s.metadata.marginCurrency,
      instrumentType: s.instrumentType,
      maxLeverage: s.metadata.maxLeverage,
      contractMultiplier: s.metadata.contractMultiplier,
      expirationDate: s.metadata.expirationDate,
      minOrderValue: s.metadata.minOrderValue,
    };

    const runtime: SymbolRuntimeState = {
      symbol: s.symbol,
      isMarketOpen,
      isTradeable,
      venueAvailable,
      liquidityState,
      mode: currentMode,
      meta,
    };

    return runtime;
  }

  /**
   * Lookup symbols by query
   */
  lookup(query: SymbolLookupQuery): SymbolLookupResult {
    let results = Array.from(this.symbols.values());

    // Filter by symbol (substring match)
    if (query.symbol) {
      const q = this.normalizeSymbol(query.symbol).toUpperCase();
      results = results.filter((s) =>
        s.symbol.toUpperCase().includes(q) ||
        s.base.toUpperCase().includes(q) ||
        s.name.toUpperCase().includes(q)
      );
    }

    // Filter by asset class
    if (query.assetClass) {
      const classes = Array.isArray(query.assetClass)
        ? query.assetClass
        : [query.assetClass];
      results = results.filter((s) => classes.includes(s.assetClass));
    }

    // Filter by venue
    if (query.venue) {
      results = results.filter((s) => query.venue! in s.venues);
    }

    // Filter by group
    if (query.group) {
      const group = this.groups.get(query.group);
      if (group) {
        const groupSymbols = new Set(group.symbols);
        results = results.filter((s) => groupSymbols.has(s.symbol));
      }
    }

    // Filter by active status
    if (query.activeOnly !== false) {
      results = results.filter((s) => s.active);
    }

    // Apply limit
    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit);
    }

    return {
      found: results.length > 0,
      symbols: results,
      totalMatches: results.length,
    };
  }

  /**
   * Create a symbol group for UI organization
   */
  createGroup(group: SymbolGroup): void {
    this.groups.set(group.id, {
      ...group,
      symbols: group.symbols.filter((s) => this.symbols.has(s)),
    });

    this.emitEvent({
      type: 'group.updated',
      timestamp: Date.now(),
    });

    console.log(`[SymbolManager] Created group: ${group.id} (${group.symbols.length} symbols)`);
  }

  /**
   * Get all groups
   */
  getGroups(): SymbolGroup[] {
    return Array.from(this.groups.values());
  }

  /**
   * Get symbols in a group
   */
  getGroupSymbols(groupId: string): Symbol[] {
    const group = this.groups.get(groupId);
    if (!group) return [];

    return group.symbols
      .map((s) => this.symbols.get(s))
      .filter((s) => s !== undefined) as Symbol[];
  }

  /**
   * Update symbol metadata (keeps it fresh)
   */
  updateSymbol(canonical: string, updates: Partial<Symbol>): void {
    const current = this.symbols.get(canonical);
    if (!current) {
      throw new Error(`Symbol not found: ${canonical}`);
    }

    const updated: Symbol = {
      ...current,
      ...updates,
      symbol: current.symbol, // Never change this
      assetClass: current.assetClass, // Never change this
    };

    this.validate(updated);
    this.symbols.set(canonical, updated);

    this.emitEvent({
      type: 'symbol.updated',
      symbol: canonical,
      previous: current,
      current: updated,
      timestamp: Date.now(),
    });

    console.log(`[SymbolManager] Updated: ${canonical}`);
  }

  /**
   * Mark symbol as inactive (but keep it in universe)
   */
  deactivateSymbol(canonical: string): void {
    this.updateSymbol(canonical, { active: false });
  }

  /**
   * Get universe state (for serialization/export)
   */
  getUniverseState(): SymbolUniverseState {
    const byAssetClass: Record<AssetClass, number> = {
      [AssetClass.CRYPTO]: 0,
      [AssetClass.FOREX]: 0,
      [AssetClass.EQUITIES]: 0,
      [AssetClass.COMMODITIES]: 0,
      [AssetClass.INDICES]: 0,
    };

    let activeCount = 0;

    for (const symbol of this.symbols.values()) {
      byAssetClass[symbol.assetClass]++;
      if (symbol.active) activeCount++;
    }

    return {
      symbols: this.symbols,
      groups: this.groups,
      uiConfig: this.uiConfig,
      validationRules: this.validationRules,
      stats: {
        totalSymbols: this.symbols.size,
        byAssetClass,
        activeSymbols: activeCount,
        lastUpdated: Date.now(),
      },
    };
  }

  /**
   * Get UI configuration
   */
  getUIConfig(): SymbolUIConfig {
    return this.uiConfig;
  }

  /**
   * Update UI configuration (affects all components)
   */
  setUIConfig(config: Partial<SymbolUIConfig>): void {
    this.uiConfig = {
      ...this.uiConfig,
      ...config,
    };

    console.log('[SymbolManager] UI configuration updated');
  }

  /**
   * Listen to universe changes
   */
  onChange(listener: (event: UniverseChangeEvent) => void): () => void {
    this.on('change', listener);
    return () => this.off('change', listener);
  }

  /**
   * Validate symbol against all rules
   * @throws if validation fails with severity 'error'
   */
  private validate(symbol: Symbol): void {
    const issues: string[] = [];

    for (const rule of this.validationRules) {
      const passed = rule.validate(symbol);

      if (!passed) {
        const issue = `[${rule.id}] ${rule.description}`;

        if (rule.severity === 'error') {
          issues.push(issue);
        } else {
          console.warn(`[SymbolManager] ${issue}`);
        }
      }
    }

    if (issues.length > 0) {
      throw new Error(`Symbol validation failed:\n${issues.join('\n')}`);
    }
  }

  /**
   * Setup default validation rules
   */
  private initializeValidationRules(): void {
    this.validationRules = [
      {
        id: 'symbol-format',
        description: 'Symbol must match expected format',
        validate: (symbol) => {
          const isPair = symbol.symbol.includes('/');
          const isEquity = !isPair;

          if (isPair) {
            const [base, quote] = symbol.symbol.split('/');
            return base.length > 0 && quote.length > 0;
          }

          return isEquity && symbol.symbol.length > 0;
        },
        severity: 'error',
      },

      {
        id: 'asset-class-match',
        description: 'Asset class must be consistent with symbol format',
        validate: (symbol) => {
          const isPair = symbol.symbol.includes('/');

          // Pairs must be crypto or forex
          if (isPair) {
            return (
              symbol.assetClass === AssetClass.CRYPTO ||
              symbol.assetClass === AssetClass.FOREX
            );
          }

          // Equities are usually single tickers
          if (symbol.assetClass === AssetClass.EQUITIES) {
            return !isPair;
          }

          return false;
        },
        severity: 'error',
      },

      {
        id: 'venues-not-empty',
        description: 'Symbol must be available on at least one venue',
        validate: (symbol) => {
          return Object.keys(symbol.venues).length > 0;
        },
        severity: 'error',
      },

      {
        id: 'precision-positive',
        description: 'Price precision must be positive',
        validate: (symbol) => {
          return symbol.metadata.precisionPrice > 0;
        },
        severity: 'error',
      },

      {
        id: 'base-quote-match',
        description: 'Base and quote must match symbol format',
        validate: (symbol) => {
          const [base, quote] = symbol.symbol.split('/');

          if (base && symbol.base !== base.toUpperCase()) {
            return false;
          }

          if (quote && symbol.quote !== quote.toUpperCase()) {
            return false;
          }

          return true;
        },
        severity: 'warn',
      },
    ];
  }

  /**
   * Normalize symbol textual form into canonical format.
   * - Uppercases
   * - Replaces common separators (-, _) with '/'
   * - Trims whitespace
   */
  private normalizeSymbol(raw: string): string {
    if (!raw) return raw;
    let s = raw.trim().toUpperCase();
    // Replace underscores and dashes with slash for pair-like symbols
    s = s.replace(/[-_]/g, '/');
    // Collapse repeated slashes
    s = s.replace(/\/+/g, '/');
    // Remove surrounding slashes
    s = s.replace(/^\/+|\/+$/g, '');
    return s;
  }

  /**
   * Public API: canonicalize a raw symbol string.
   * Backwards-compatible alias for internal normalization.
   */
  public canonicalize(raw: string): string {
    return this.normalizeSymbol(raw);
  }

  /**
   * Public alias `normalize` for convenience in callsites.
   */
  public normalize(raw: string): string {
    return this.normalizeSymbol(raw);
  }

  /**
   * Set or update popularity score (higher = more popular)
   * Used for default watchlist ordering and UI hints
   */
  setPopularity(canonical: string, score: number): void {
    const key = this.normalizeSymbol(canonical);
    this.popularity.set(key, score);
  }

  getPopularity(canonical: string): number {
    return this.popularity.get(this.normalizeSymbol(canonical)) ?? 0;
  }

  /**
   * Return a default watchlist ordered by popularity then 24h volume
   */
  getDefaultWatchlist(limit = 100): Symbol[] {
    return Array.from(this.symbols.values())
      .filter((s) => s.active)
      .sort((a, b) => {
        const pa = this.getPopularity(a.symbol) || 0;
        const pb = this.getPopularity(b.symbol) || 0;
        if (pa !== pb) return pb - pa;
        const va = a.metadata?.volume24h || 0;
        const vb = b.metadata?.volume24h || 0;
        return vb - va;
      })
      .slice(0, limit);
  }

  /**
   * Register a composite/index symbol and its components
   */
  registerCompositeSymbol(canonical: string, components: string[]): void {
    const key = this.normalizeSymbol(canonical);
    const set = new Set<string>();
    for (const comp of components) {
      const k = this.normalizeSymbol(comp);
      if (!this.symbols.has(k)) {
        throw new Error(`Component symbol not found: ${k}`);
      }
      set.add(k);
    }
    this.dependencyGraph.set(key, set);
    this.emit('symbol.composite.registered', { symbol: key, components: Array.from(set) });
  }

  getDependencies(canonical: string): string[] {
    return Array.from(this.dependencyGraph.get(this.normalizeSymbol(canonical)) || []);
  }

  /**
   * Deactivate symbols that have expired (futures/options)
   */
  pruneExpiredSymbols(): string[] {
    const now = Date.now();
    const deactivated: string[] = [];
    for (const [k, s] of this.symbols.entries()) {
      const exp = s.metadata?.expirationDate;
      if (exp && exp < now && s.active) {
        this.updateSymbol(k, { active: false });
        deactivated.push(k);
      }
    }
    return deactivated;
  }

  /**
   * Set or update the correlation group for a symbol.
   */
  setCorrelationGroup(canonical: string, groupName: string): void {
    const key = this.normalizeSymbol(canonical);
    const current = this.getSymbol(key);
    if (!current) throw new Error(`Symbol not found: ${key}`);
    this.updateSymbol(key, { metadata: { ...current.metadata, correlationGroup: groupName } });
    this.emit('symbol.correlation.updated', { symbol: key, group: groupName });
  }

  getCorrelationGroup(canonical: string): string | undefined {
    return this.getSymbol(canonical)?.metadata?.correlationGroup;
  }

  /**
   * Set or update risk classification for a symbol
   */
  setRiskClassification(canonical: string, risk: 'high-vol' | 'safe-haven' | 'speculative' | 'stable' | 'leveraged') {
    const key = this.normalizeSymbol(canonical);
    const current = this.getSymbol(key);
    if (!current) throw new Error(`Symbol not found: ${key}`);
    this.updateSymbol(key, { metadata: { ...current.metadata, riskClassification: risk } });
    this.emit('symbol.risk.updated', { symbol: key, risk });
  }

  getRiskClassification(canonical: string) {
    return this.getSymbol(canonical)?.metadata?.riskClassification;
  }

  /**
   * Emit universe change event
   */
  private emitEvent(event: UniverseChangeEvent): void {
    this.emit('change', event);
  }

  /**
   * Get statistics
   */
  getStats() {
    const state = this.getUniverseState();
    return state.stats;
  }

  /**
   * Export universe to JSON (for persistence)
   */
  toJSON(): SymbolUniverseState {
    return this.getUniverseState();
  }
}

/**
 * Global symbol manager instance
 */
export const symbolManager = new SymbolManager();
