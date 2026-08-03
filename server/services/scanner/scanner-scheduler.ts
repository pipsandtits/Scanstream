import { MultiExchangeScanner } from './multi-exchange-scanner';
import ScannerPersistenceService from './scanner-persistence';
import { symbolRegistry } from '../../../src/core/SymbolRegistry';
import type { ExchangeAggregator } from '../gateway/exchange-aggregator';
import { CacheManager } from '../gateway/cache-manager';

export class ScannerScheduler {
  private aggregator: ExchangeAggregator;
  private cacheManager: CacheManager;
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(aggregator: ExchangeAggregator, cacheManager: CacheManager) {
    this.aggregator = aggregator;
    this.cacheManager = cacheManager;
  }

  start(intervalMinutes: number = 10) {
    if (this.running) return;
    this.running = true;
    const ms = Math.max(1, intervalMinutes) * 60 * 1000;
    console.log(`[ScannerScheduler] Starting periodic scans every ${intervalMinutes} minute(s)`);
    // Run immediately then schedule
    this.runOnce().catch(err => console.error('[ScannerScheduler] Initial run failed:', err));
    this.intervalId = setInterval(() => {
      this.runOnce().catch(err => console.error('[ScannerScheduler] Scheduled run failed:', err));
    }, ms);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
    console.log('[ScannerScheduler] Stopped');
  }

  async runOnce() {
    if (!this.aggregator) throw new Error('Aggregator not available');
    const scanner = new MultiExchangeScanner(this.aggregator, this.cacheManager);
    const persistence = new ScannerPersistenceService();

    // Build symbol list from registry
    const all = symbolRegistry.getAll().filter(s => s.active).map(s => s.symbol);
    if (!all || all.length === 0) {
      console.log('[ScannerScheduler] No symbols registered in SymbolRegistry — skipping scan');
      return;
    }

    // Limit work to a reasonable number to avoid overloading during one run
    const MAX_SYMBOLS = Number(process.env.SCANNER_MAX_SYMBOLS || '200');
    const symbols = all.slice(0, MAX_SYMBOLS);

    console.log(`[ScannerScheduler] ScanRun start — symbols=${symbols.length}`);

    const exchangesMap = this.aggregator.getExchangeInstances();
    const exchanges = Array.from(exchangesMap.keys());

    let session: any = null;
    try {
      session = await persistence.createScanSession(exchanges, symbols.length);
    } catch (e) {
      console.warn('[ScannerScheduler] Could not create scan session in DB, running without session persistence');
    }

    try {
      const results = await scanner.scanExchanges(symbols, undefined, { timeframe: '1h', limit: 120, minVolume: 1000, topN: 50 });

      // Flatten allResults
      const allResults = results.allResults || [];

      if (session) {
        try {
          await persistence.storeScanResults(allResults, session.id);
          await persistence.completeScanSession(session.id, allResults.length, (allResults.reduce((s:any,r:any)=>s+r.confidence,0) / Math.max(1, allResults.length)));
        } catch (e) {
          console.error('[ScannerScheduler] Failed to persist scan results:', e);
        }
      }

      console.log(`[ScannerScheduler] ScanRun complete — results=${allResults.length}, top=${results.topAssets?.slice(0,5).map((r:any)=>r.symbol).join(',')}`);
    } catch (err) {
      console.error('[ScannerScheduler] Scan run failed:', err);
      if (session) {
        try {
          await persistence.completeScanSession(session.id, 0, 0);
        } catch (e) {}
      }
    }
  }
}

export default ScannerScheduler;
