import type { MarketFrame, Signal, Trade, Strategy, BacktestResult, InsertMarketFrame, InsertSignal, InsertTrade, InsertStrategy, InsertBacktestResult, MarketSentiment, PortfolioSummary, ModelMetric, InsertModelMetric, InsertAuditLog } from "@shared/schema";
import { randomUUID } from "crypto";
import { DbStorage } from './db-storage';

export interface IStorage {
  // Market data
  getMarketFrames(symbol: string, limit?: number): Promise<MarketFrame[]>;
  // Batch fetch market frames for multiple symbols in a single query to avoid N+1
  getMarketFramesForSymbols?(symbols: string[], limit?: number): Promise<Record<string, MarketFrame[]>>;
  createMarketFrame(frame: InsertMarketFrame): Promise<MarketFrame>;
  getLatestMarketFrame(symbol: string): Promise<MarketFrame | undefined>;
  
  // Signals
  getSignals(symbol?: string, limit?: number): Promise<Signal[]>;
  createSignal(signal: InsertSignal): Promise<Signal>;
  getLatestSignals(limit?: number): Promise<Signal[]>;
  
  // Trades
  getTrades(status?: string): Promise<Trade[]>;
  createTrade(trade: InsertTrade): Promise<Trade>;
  updateTrade(id: string, updates: Partial<Trade>): Promise<Trade>;
  
  // Strategies
  getStrategies(): Promise<Strategy[]>;
  createStrategy(strategy: InsertStrategy): Promise<Strategy>;
  updateStrategy(id: string, updates: Partial<Strategy>): Promise<Strategy>;
  
  // Backtest results
  getBacktestResults(strategyId?: string): Promise<BacktestResult[]>;
  createBacktestResult(result: InsertBacktestResult): Promise<BacktestResult>;
  deleteBacktestResult(id: string): Promise<void>;
  
  // Market metrics
  getMarketSentiment(): Promise<MarketSentiment>;
  getPortfolioSummary(): Promise<PortfolioSummary>;

  // Scan run persistence (scanner analysis)
  createScanRun?(scan: { scanId: string; timestamp: string; timeframe?: string; symbolCount?: number; payload: any; }): Promise<any>;
  getRecentScanRuns?(limit?: number): Promise<any[]>;

  // Convenience: fetch recent market frames
  getRecentFrames?(limit?: number): Promise<MarketFrame[]>;
  
  // Signal performance tracking
  createSignalPerformance(performance: any): Promise<void>;
  updateSignalPerformance(signalId: string, updates: any): Promise<void>;
  // Model metrics for drift detection
  createModelMetric(metric: InsertModelMetric): Promise<void>;
  getLatestModelMetrics(modelName: string, limit?: number): Promise<ModelMetric[]>;
  getStaleModelMetrics(): Promise<ModelMetric[]>;
  // Audit logs
  createAuditLog(log: InsertAuditLog): Promise<void>;
  getAuditLogs(entityType?: string, entityId?: string, limit?: number): Promise<InsertAuditLog[]>;
  // Trade provenance
  createTradeProvenance(record: any): Promise<void>;
  // Decision events: per-decision records for causality tracing
  createDecisionEvent(record: any): Promise<void>;
  // Decision snapshots (rich ML/agent snapshots)
  createDecisionSnapshot(record: any): Promise<void>;
  // Order audit records for execution provenance
  createOrderAudit(record: any): Promise<any>;
  updateOrderAudit(orderIdOrId: string, updates: any): Promise<void>;
  // Retrieve a trace chain by trace id
  getTraceChain(traceId: string): Promise<any>;
}

export class MemStorage implements IStorage {
  private marketFrames: Map<string, MarketFrame> = new Map();
  private signals: Map<string, Signal> = new Map();
  private trades: Map<string, Trade> = new Map();
  private strategies: Map<string, Strategy> = new Map();
  private backtestResults: Map<string, BacktestResult> = new Map();
  private modelMetrics: Map<string, ModelMetric> = new Map();
  private auditLogs: Map<string, InsertAuditLog> = new Map();
  private provenances: Map<string, any> = new Map();
  private decisionEvents: Map<string, any> = new Map();
  private decisionSnapshots: Map<string, any> = new Map();
  private orderAudits: Map<string, any> = new Map();
  private scanRuns: Map<string, any> = new Map();
  

  // Runtime limits and cleanup config
  private readonly STORAGE_CONFIG = {
    maxMarketFrames: 50000,
    maxSignals: 10000,
    maxTrades: 5000,
    maxBacktests: 2000,
    cleanupIntervalMs: 1000 * 60 * 60, // hourly
  } as const;

  async getMarketFrames(symbol: string, limit = 200): Promise<MarketFrame[]> {
    return this.query(this.marketFrames, (f: MarketFrame) => f.symbol === symbol, limit, (a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime());
  }

  async getMarketFramesForSymbols(symbols: string[], limit = 200): Promise<Record<string, MarketFrame[]>> {
    const out: Record<string, MarketFrame[]> = {};
    for (const s of symbols) {
      out[s] = await this.getMarketFrames(s, limit);
    }
    return out;
  }

  async createMarketFrame(frameData: InsertMarketFrame): Promise<MarketFrame> {
    const id = randomUUID();
    const frame: MarketFrame = {
      ...frameData,
      id,
      // Ensure timeframe is present for snapshot filtering compatibility
      timeframe: (frameData as any).timeframe ?? 3600,
      timestamp: new Date(),
    };
    this.marketFrames.set(id, frame);
    this.enforceSizeLimit(this.marketFrames, this.STORAGE_CONFIG.maxMarketFrames, (v: MarketFrame) => new Date((v as any).timestamp).getTime());
    return frame;
  }

  async createManyMarketFrames(frames: InsertMarketFrame[]): Promise<MarketFrame[]> {
    const res: MarketFrame[] = [];
    for (const f of frames) {
      res.push(await this.createMarketFrame(f));
    }
    return res;
  }

  async getLatestMarketFrame(symbol: string): Promise<MarketFrame | undefined> {
    const frames = await this.getMarketFrames(symbol, 1);
    return frames[0];
  }

  async getSignals(symbol?: string, limit = 50): Promise<Signal[]> {
    return this.query(this.signals, (s: Signal) => (symbol ? s.symbol === symbol : true), limit, (a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime());
  }

  async createSignal(signalData: InsertSignal): Promise<Signal> {
    const id = randomUUID();
    const signal = {
      ...signalData,
      id,
      timestamp: new Date(),
      momentumLabel: signalData.momentumLabel ?? null,
      regimeState: signalData.regimeState ?? null,
      legacyLabel: signalData.legacyLabel ?? null,
      signalStrengthScore: signalData.signalStrengthScore ?? null,
      classifications: signalData.classifications ?? [],
      patternDetails: signalData.patternDetails ?? [],
      timeframeAlignment: signalData.timeframeAlignment ?? 0,
      agreementScore: signalData.agreementScore ?? 50,
      positionSize: signalData.positionSize ?? null,
      correlationId: (signalData as any).correlationId ?? randomUUID(),
    } as any as Signal;
    this.signals.set(id, signal);
    this.enforceSizeLimit(this.signals, this.STORAGE_CONFIG.maxSignals, (v: Signal) => new Date((v as any).timestamp).getTime());
    return signal;
  }

  async getLatestSignals(limit = 10): Promise<Signal[]> {
    return this.query(this.signals, undefined, limit, (a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime());
  }

  async getTrades(status?: string): Promise<Trade[]> {
    return this.query(this.trades, (t: Trade) => (status ? t.status === status : true), undefined, (a, b) => new Date((b as any).entryTime).getTime() - new Date((a as any).entryTime).getTime());
  }

  async createTrade(tradeData: InsertTrade): Promise<Trade> {
    const id = randomUUID();
    const trade: Trade = {
      ...tradeData,
      id,
      status: tradeData.status || 'OPEN',
      exitTime: tradeData.exitTime || null,
      exitPrice: tradeData.exitPrice || null,
      pnl: tradeData.pnl || null,
      commission: tradeData.commission || 0,
      signalId: tradeData.signalId ?? null,
    };
    this.trades.set(id, trade);
    this.enforceSizeLimit(this.trades, this.STORAGE_CONFIG.maxTrades, (v: Trade) => new Date((v as any).entryTime).getTime());
    return trade;
  }

  async getTradesBySignalId(signalId: string): Promise<Trade[]> {
    return this.query(this.trades, (t: Trade) => t.signalId === signalId, undefined, (a, b) => new Date((b as any).entryTime).getTime() - new Date((a as any).entryTime).getTime());
  }

  async updateTrade(id: string, updates: Partial<Trade>): Promise<Trade> {
    const existingTrade = this.trades.get(id);
    if (!existingTrade) {
      throw new Error(`Trade with id ${id} not found`);
    }
    const updatedTrade = { ...existingTrade, ...updates };
    this.trades.set(id, updatedTrade);
    return updatedTrade;
  }

  async getStrategies(): Promise<Strategy[]> {
    return Array.from(this.strategies.values());
  }

  async createStrategy(strategyData: InsertStrategy): Promise<Strategy> {
    const id = randomUUID();
    const strategy: Strategy = {
      ...strategyData,
      id,
      isActive: strategyData.isActive !== undefined ? strategyData.isActive : true,
    };
    this.strategies.set(id, strategy);
    return strategy;
  }

  async updateStrategy(id: string, updates: Partial<Strategy>): Promise<Strategy> {
    const existingStrategy = this.strategies.get(id);
    if (!existingStrategy) {
      throw new Error(`Strategy with id ${id} not found`);
    }
    const updatedStrategy = { ...existingStrategy, ...updates };
    this.strategies.set(id, updatedStrategy);
    return updatedStrategy;
  }

  async getBacktestResults(strategyId?: string): Promise<BacktestResult[]> {
    let results = Array.from(this.backtestResults.values());
    if (strategyId) {
      results = results.filter(result => result.strategyId === strategyId);
    }
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async createBacktestResult(resultData: InsertBacktestResult): Promise<BacktestResult> {
    const id = randomUUID();
    const result: BacktestResult = {
      id,
      strategyId: resultData.strategyId,
      performance: resultData.performance ?? {},
      equityCurve: resultData.equityCurve ?? [],
      monthlyReturns: resultData.monthlyReturns ?? [],
      startDate: resultData.startDate ?? new Date(),
      endDate: resultData.endDate ?? new Date(),
      initialCapital: resultData.initialCapital ?? 0,
      finalCapital: resultData.finalCapital ?? 0,
      createdAt: new Date(),
      metrics: resultData.metrics ?? {},
      trades: resultData.trades ?? [],
      
    };
    this.backtestResults.set(id, result);
    this.enforceSizeLimit(this.backtestResults, this.STORAGE_CONFIG.maxBacktests, (v: BacktestResult) => new Date((v as any).createdAt).getTime());
    return result;
  }

  async deleteBacktestResult(id: string): Promise<void> {
    this.backtestResults.delete(id);
  }

  async getMarketSentiment(): Promise<MarketSentiment> {
    return {
      fearGreedIndex: 67,
      btcDominance: 51.2,
      totalMarketCap: 1680000000000, // $1.68T
      volume24h: 89200000000, // $89.2B
    };
  }

  async getPortfolioSummary(): Promise<PortfolioSummary> {
    const openTrades = await this.getTrades('OPEN');
    const totalInvested = openTrades.reduce((sum, trade) => sum + (trade.entryPrice * trade.quantity), 0);
    
    return {
      totalValue: 127543.89,
      availableCash: 23456.78,
      invested: totalInvested || 104087.11,
      dayChange: 5892.31,
      dayChangePercent: 4.84,
    };
  }

  // ScanRun persistence for MemStorage
  async createScanRun(scan: { scanId: string; timestamp: string; timeframe?: string; symbolCount?: number; payload: any; }): Promise<any> {
    const id = scan.scanId ?? randomUUID();
    const record = { ...scan, scanId: id, timestamp: new Date(scan.timestamp), createdAt: new Date() } as any;
    this.scanRuns.set(id, record);
    return record;
  }

  async getRecentScanRuns(limit = 10): Promise<any[]> {
    const items = Array.from(this.scanRuns.values()) as any[];
    items.sort((a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime());
    return items.slice(0, limit);
  }

  async getRecentFrames(limit: number = 1000): Promise<MarketFrame[]> {
    return this.query(this.marketFrames, undefined, limit, (a, b) => new Date((b as any).timestamp).getTime() - new Date((a as any).timestamp).getTime());
  }

  // Signal Performance Tracking
  private signalPerformances: Map<string, any> = new Map();

  async createSignalPerformance(performance: any): Promise<void> {
    this.signalPerformances.set(performance.signalId, performance);
  }

  async updateSignalPerformance(signalId: string, updates: any): Promise<void> {
    const existing = this.signalPerformances.get(signalId);
    if (existing) {
      this.signalPerformances.set(signalId, { ...existing, ...updates });
    }
  }

  async getSignalPerformance(signalId: string): Promise<any> {
    return this.signalPerformances.get(signalId);
  }

  async getAllSignalPerformances(): Promise<any[]> {
    return Array.from(this.signalPerformances.values());
  }

  // Audit log implementations for MemStorage
  async createAuditLog(log: InsertAuditLog): Promise<void> {
    const id = randomUUID();
    const ts = (log as any).timestamp ? new Date((log as any).timestamp) : new Date();
    const record: any = {
      ...log,
      id,
      timestamp: ts,
    };
    this.auditLogs.set(id, record);
    // No strict size limit for logs by default; keep in-memory but could be pruned by deleteOldMarketFrames or similar
  }

  async getAuditLogs(entityType?: string, entityId?: string, limit = 100): Promise<InsertAuditLog[]> {
    let items = Array.from(this.auditLogs.values()) as any[];
    if (entityType) items = items.filter(i => i.entityType === entityType);
    if (entityId) items = items.filter(i => i.entityId === entityId);
    items = items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
    return items as InsertAuditLog[];
  }

  // Trade provenance for MemStorage
  async createTradeProvenance(record: any): Promise<void> {
    const id = randomUUID();
    const rec = { id, ...record, createdAt: record.createdAt ? new Date(record.createdAt) : new Date() };
    this.provenances.set(id, rec);
  }

  // Decision event persistence for MemStorage
  async createDecisionEvent(record: any): Promise<void> {
    const id = randomUUID();
    const rec = { id, ...record, timestamp: record.timestamp ? new Date(record.timestamp) : new Date() };
    this.decisionEvents.set(id, rec);
  }

  async createDecisionSnapshot(record: any): Promise<void> {
    const id = randomUUID();
    const rec = { id, ...record, timestamp: record.timestamp ? new Date(record.timestamp) : new Date() };
    this.decisionSnapshots.set(id, rec);
  }

  async createOrderAudit(record: any): Promise<any> {
    const id = randomUUID();
    const rec = { id, ...record, createdAt: record.createdAt ? new Date(record.createdAt) : new Date(), updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date() };
    this.orderAudits.set(id, rec);
    return rec;
  }

  async updateOrderAudit(orderIdOrId: string, updates: any): Promise<void> {
    // find by id or orderId
    let foundKey: string | null = null;
    for (const [k, v] of this.orderAudits.entries()) {
      if (k === orderIdOrId || v.orderId === orderIdOrId) {
        foundKey = k;
        break;
      }
    }
    if (!foundKey) throw new Error(`OrderAudit not found for ${orderIdOrId}`);
    const existing = this.orderAudits.get(foundKey) || {};
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.orderAudits.set(foundKey, updated);
  }

  async getTraceChain(traceId: string): Promise<any> {
    const signals = Array.from(this.signals.values()).filter((s: any) => (s.correlationId === traceId || s.traceId === traceId));
    const decisionEvents = Array.from(this.decisionEvents.values()).filter((d: any) => (d.correlationId === traceId || d.traceId === traceId));
    const decisionSnapshots = Array.from(this.decisionSnapshots.values()).filter((d: any) => (d.traceId === traceId || d.correlationId === traceId));
    const orderAudits = Array.from(this.orderAudits.values()).filter((o: any) => (o.traceId === traceId || o.orderId === traceId));
    const provenances = Array.from(this.provenances.values()).filter((p: any) => (p.correlationId === traceId || p.traceId === traceId));

    // collect referenced marketFrameIds from snapshots/events
    const frameIds = new Set<string>();
    for (const d of [...decisionEvents, ...decisionSnapshots]) {
      if (d.marketFrameId) frameIds.add(d.marketFrameId);
    }
    const marketFrames = Array.from(this.marketFrames.values()).filter((f: any) => frameIds.has(f.id));

    return { traceId, signals, decisionEvents, decisionSnapshots, orderAudits, provenances, marketFrames };
  }


  // Model metric implementations for MemStorage
  async createModelMetric(metric: InsertModelMetric): Promise<void> {
    const id = randomUUID();
    const record: ModelMetric = {
      id,
      modelName: metric.modelName,
      timestamp: new Date(),
      accuracy: metric.accuracy ?? null,
      precision: metric.precision ?? null,
      recall: metric.recall ?? null,
      driftScore: metric.driftScore ?? null,
      dataPoints: metric.dataPoints ?? 0,
      isStale: metric.isStale ?? false,
    } as any;
    this.modelMetrics.set(id, record);
    // optional trimming not enforced for model metrics
  }

  async getLatestModelMetrics(modelName: string, limit = 10): Promise<ModelMetric[]> {
    let items = Array.from(this.modelMetrics.values()).filter(m => m.modelName === modelName);
    items = items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
    return items;
  }

  async getStaleModelMetrics(): Promise<ModelMetric[]> {
    return Array.from(this.modelMetrics.values()).filter(m => m.isStale === true).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  // --- Helper utilities ---
  private enforceSizeLimit<T>(map: Map<string, T>, maxSize: number, timeExtractor?: (v: T) => number) {
    if (map.size <= maxSize) return;
    // Remove oldest 1k entries or until under limit
    const removeCount = Math.max(1000, Math.floor(maxSize * 0.02));
    const entries = Array.from(map.entries());
    if (timeExtractor) {
      entries.sort((a, b) => (timeExtractor(a[1]) - timeExtractor(b[1])));
    }
    for (let i = 0; i < Math.min(removeCount, entries.length); i++) {
      map.delete(entries[i][0]);
    }
  }

  private query<T>(map: Map<string, T>, filterFn?: (item: T) => boolean, limit: number | undefined = 50, sortFn?: (a: T, b: T) => number): T[] {
    let items = Array.from(map.values()) as T[];
    if (filterFn) items = items.filter(filterFn);
    if (sortFn) items = items.sort(sortFn);
    return limit ? items.slice(0, limit) : items;
  }

  // Delete old market frames by age (days)
  async deleteOldMarketFrames(days: number): Promise<void> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const [id, f] of this.marketFrames.entries()) {
      const ts = new Date((f as any).timestamp).getTime();
      if (ts < cutoff) this.marketFrames.delete(id);
    }
  }

}

// Factory with configurable fallback
export function createStorage(): IStorage {
  try {
    const db = new DbStorage();
    console.log('[Storage] Initialized with database backend');
    return db;
  } catch (error: any) {
    console.warn('[Storage] Database initialization failed, using in-memory storage:', (error as any).message);
    return new MemStorage();
  }
}

export const storage = createStorage();
