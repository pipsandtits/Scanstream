import pkg from '@prisma/client';
const { PrismaClient } = pkg as any;
import type { PrismaClient as PrismaClientType } from '@prisma/client';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { type IStorage } from './storage';
import { type MarketFrame, type Signal, type Trade, type Strategy, type BacktestResult, type InsertMarketFrame, type InsertSignal, type InsertTrade, type InsertStrategy, type InsertBacktestResult, type MarketSentiment, type PortfolioSummary, type ModelMetric, type InsertModelMetric } from "@shared/schema";
import { v4 as uuidv4 } from 'uuid';
import { randomUUID } from 'crypto';

// Simple in-memory fallback to avoid circular dependency
class SimpleFallbackStorage implements IStorage {
  private marketFrames: Map<string, MarketFrame> = new Map();
  private signals: Map<string, Signal> = new Map();
  private trades: Map<string, Trade> = new Map();
  private strategies: Map<string, Strategy> = new Map();
  private backtestResults: Map<string, BacktestResult> = new Map();
  private modelMetrics: Map<string, ModelMetric> = new Map();
  private auditLogs: Map<string, any> = new Map();
  private provenances: Map<string, any> = new Map();
  private decisionEvents: Map<string, any> = new Map();
  private decisionSnapshots: Map<string, any> = new Map();
  private orderAudits: Map<string, any> = new Map();

  async getMarketFrames(symbol: string, limit = 200): Promise<MarketFrame[]> {
    return Array.from(this.marketFrames.values())
      .filter(frame => frame.symbol === symbol)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
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
      // Ensure timeframe is always present in fallback storage (defaults to 1h)
      timeframe: (frameData as any).timeframe ?? 3600,
      timestamp: new Date(),
    };
    this.marketFrames.set(id, frame);
    return frame;
  }

  async getLatestMarketFrame(symbol: string): Promise<MarketFrame | undefined> {
    const frames = await this.getMarketFrames(symbol, 1);
    return frames[0];
  }

  async getSignals(symbol?: string, limit = 50): Promise<Signal[]> {
    let signals = Array.from(this.signals.values());
    if (symbol) {
      signals = signals.filter(signal => signal.symbol === symbol);
    }
    return signals
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  async createSignal(signalData: InsertSignal): Promise<Signal> {
    const id = randomUUID();
    const signal = {
      ...signalData,
      id,
      timestamp: new Date(),
      momentumLabel: signalData.momentumLabel !== undefined ? signalData.momentumLabel : null,
      regimeState: signalData.regimeState !== undefined ? signalData.regimeState : null,
      legacyLabel: signalData.legacyLabel !== undefined ? signalData.legacyLabel : null,
      signalStrengthScore: signalData.signalStrengthScore !== undefined ? signalData.signalStrengthScore : null,
      classifications: signalData.classifications ?? [],
      patternDetails: signalData.patternDetails ?? [],
      timeframeAlignment: signalData.timeframeAlignment ?? 0,
      agreementScore: signalData.agreementScore ?? 50,
      positionSize: signalData.positionSize ?? null,
      correlationId: (signalData as any).correlationId ?? uuidv4(),
    } as any as Signal;
    this.signals.set(id, signal);
    return signal;
  }

  async getLatestSignals(limit = 10): Promise<Signal[]> {
    return Array.from(this.signals.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  async getTrades(status?: string): Promise<Trade[]> {
    let trades = Array.from(this.trades.values());
    if (status) {
      trades = trades.filter(trade => trade.status === status);
    }
    return trades.sort((a, b) => new Date(b.entryTime).getTime() - new Date(a.entryTime).getTime());
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
    return trade;
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
    return result;
  }

  async deleteBacktestResult(id: string): Promise<void> {
    this.backtestResults.delete(id);
  }

  async getMarketSentiment(): Promise<MarketSentiment> {
    return {
      fearGreedIndex: 67,
      btcDominance: 51.2,
      totalMarketCap: 1680000000000,
      volume24h: 89200000000,
    };
  }

  async getPortfolioSummary(): Promise<PortfolioSummary> {
    return {
      totalValue: 0,
      availableCash: 0,
      invested: 0,
      dayChange: 0,
      dayChangePercent: 0,
    };
  }

    // Audit log persistence (in-memory fallback implementation)
    async createAuditLog(log: import("@shared/schema").InsertAuditLog): Promise<void> {
      const id = randomUUID();
      const ts = (log as any).timestamp ? new Date((log as any).timestamp) : new Date();
      const record = { ...log, id, timestamp: ts } as any;
      this.auditLogs.set(id, record);
    }

    async createTradeProvenance(record: any): Promise<void> {
      const id = randomUUID();
      const ts = record.createdAt ? new Date(record.createdAt) : new Date();
      const rec = { id, ...record, createdAt: ts };
      this.provenances.set(id, rec);
    }

    async createDecisionEvent(record: any): Promise<void> {
      const id = randomUUID();
      const ts = record.timestamp ? new Date(record.timestamp) : new Date();
      const rec = { id, ...record, timestamp: ts };
      this.decisionEvents.set(id, rec);
    }

    async createDecisionSnapshot(record: any): Promise<void> {
      const id = randomUUID();
      const ts = record.timestamp ? new Date(record.timestamp) : new Date();
      const rec = { id, ...record, timestamp: ts };
      this.decisionSnapshots.set(id, rec);
    }

    async getRecentDecisionSnapshots(limit = 200): Promise<any[]> {
      let items = Array.from(this.decisionSnapshots.values()) as any[];
      items = items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
      return items;
    }

    async createOrderAudit(record: any): Promise<any> {
      const id = randomUUID();
      const ts = record.createdAt ? new Date(record.createdAt) : new Date();
      const rec = { id, ...record, createdAt: ts, updatedAt: ts };
      this.orderAudits.set(id, rec);
      return rec;
    }

    async updateOrderAudit(orderIdOrId: string, updates: any): Promise<void> {
      // find by id or orderId
      let foundKey: string | null = null;
      for (const [k, v] of this.orderAudits.entries()) {
        if (k === orderIdOrId || v.orderId === orderIdOrId) { foundKey = k; break; }
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
      const frameIds = new Set<string>();
      for (const d of [...decisionEvents, ...decisionSnapshots]) { if (d.marketFrameId) frameIds.add(d.marketFrameId); }
      const marketFrames = Array.from(this.marketFrames.values()).filter((f: any) => frameIds.has(f.id));
      return { traceId, signals, decisionEvents, decisionSnapshots, orderAudits, provenances, marketFrames };
    }

    async getAuditLogs(entityType?: string, entityId?: string, limit = 100): Promise<import("@shared/schema").InsertAuditLog[]> {
      let items = Array.from(this.auditLogs.values()) as any[];
      if (entityType) items = items.filter(i => i.entityType === entityType);
      if (entityId) items = items.filter(i => i.entityId === entityId);
      items = items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
      return items as import("@shared/schema").InsertAuditLog[];
    }

  async createSignalPerformance(performance: any): Promise<void> {
    // No-op
  }

  async updateSignalPerformance(signalId: string, updates: any): Promise<void> {
    // No-op
  }

  // Model metrics persistence for drift detection
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
  }

  async getLatestModelMetrics(modelName: string, limit = 10): Promise<ModelMetric[]> {
    let items = Array.from(this.modelMetrics.values()).filter(m => m.modelName === modelName);
    items = items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, limit);
    return items;
  }
  async getStaleModelMetrics(): Promise<ModelMetric[]> {
    return Array.from(this.modelMetrics.values()).filter(m => m.isStale === true).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
}

export class DbStorage implements IStorage {
  private prisma: PrismaClientType | any;
  private fallback: IStorage = new SimpleFallbackStorage();
  private isConnected: boolean = false;
  private ready: Promise<void> | null = null;
  // Use Phase5 event bridge to broadcast fallback events for observability
  private eventBridge: any;

  private isReady(): boolean {
    return this.isConnected && !!this.prisma;
  }

  /**
   * Whether the real database is in use. When false, writes land in the
   * in-memory fallback and are lost on restart — a critical condition for
   * live trading, so readiness probes must surface it.
   */
  isDatabaseConnected(): boolean {
    return this.isReady();
  }

  private async tryPrismaCreate(modelNames: string[], data: any) {
    for (const name of modelNames) {
      try {
        const model = (this.prisma as any)[name];
        if (model && typeof model.create === 'function') {
          return await model.create({ data });
        }
      } catch (_) {
        // try next
      }
    }
    throw new Error('prisma_create_failed');
  }

  private async tryPrismaFindMany(modelNames: string[], args: any) {
    for (const name of modelNames) {
      try {
        const model = (this.prisma as any)[name];
        if (model && typeof model.findMany === 'function') {
          return await model.findMany(args || {});
        }
      } catch (_) {
        // try next
      }
    }
    throw new Error('prisma_findmany_failed');
  }

  constructor() {
    try {
      this.prisma = new PrismaClient({
        errorFormat: 'minimal',
      });
    } catch (e) {
      // Prisma client construction failed (e.g., missing adapter/accelerateUrl)
      this.prisma = null as any;
      this.isConnected = false;
      console.warn('[DbStorage] Prisma client construction failed, using in-memory fallback:', (e as any).message || e);
      this.reportFallback('prisma_client_construction_failed', { message: (e as any).message || String(e) });
    }
    try { this.eventBridge = require('./services/phase5-event-bridge').phase5EventBridge; } catch (e) { this.eventBridge = null; }
    // start connection check and expose readiness promise
    this.ready = this.testConnection();
    // Ensure fallback queue directory exists
    try {
      const dir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
    // Periodic connectivity check + flush when connected
    setInterval(async () => {
      try {
        if (!this.isConnected && this.prisma) {
          await this.testConnection();
        }
        if (this.isConnected) {
          await this.flushFallbackQueue().catch(() => {});
        }
      } catch (_) {}
    }, 15_000);
  }

  private getFallbackQueuePath(): string {
    return path.join(process.cwd(), 'data', 'db-fallback-queue.jsonl');
  }

  private async enqueueFallback(record: any): Promise<void> {
    try {
      const p = this.getFallbackQueuePath();
      const line = JSON.stringify(record) + '\n';
      await fsp.appendFile(p, line, { encoding: 'utf8' });
    } catch (e) {
      // last resort: write to in-memory fallback
      try { this.fallback.createAuditLog({ action: 'fallback_enqueue_failed', entityType: 'system', entityId: null, details: { err: String(e) } } as any); } catch (_) {}
    }
  }

  private async flushFallbackQueue(): Promise<void> {
    try {
      const p = this.getFallbackQueuePath();
      if (!fs.existsSync(p)) return;
      const content = await fsp.readFile(p, { encoding: 'utf8' });
      if (!content) return;
      const lines = content.split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const rec = JSON.parse(l);
          // Prefer explicit 'type' routing
          if (rec && rec.type === 'decisionSnapshot') {
            try { await (this.prisma as any).decisionSnapshot.create({ data: rec }); } catch (_) { try { await this.getFallback().createDecisionSnapshot(rec); } catch (_) {} }
            continue;
          }
          if (rec && rec.type === 'orderAudit') {
            try { await (this.prisma as any).orderAudit.create({ data: rec }); } catch (_) { try { await this.getFallback().createOrderAudit(rec); } catch (_) {} }
            continue;
          }
          // tradeProvenance may be queued with type or tradeId
          if (rec && (rec.type === 'tradeProvenance' || rec.tradeId)) {
            try { await (this.prisma as any).tradeProvenance.create({ data: rec }); } catch (_) { try { await this.getFallback().createTradeProvenance(rec); } catch (_) {} }
            continue;
          }
          if (rec && rec.type === 'orderAudit.update') {
            try {
              // attempt update by id first, then by orderId
              try { await (this.prisma as any).orderAudit.update({ where: { id: rec.id }, data: rec.updates }); } catch (_) {
                const found = await (this.prisma as any).orderAudit.findFirst({ where: { orderId: rec.id } });
                if (!found) throw new Error('OrderAudit not found');
                await (this.prisma as any).orderAudit.update({ where: { id: found.id }, data: rec.updates });
              }
            } catch (_) {
              try { await this.getFallback().updateOrderAudit(rec.id, rec.updates); } catch (_) { await this.getFallback().createAuditLog({ action: 'orderAudit.update.failed', entityType: 'orderAudit', entityId: rec.id, details: rec.updates } as any); }
            }
            continue;
          }

          // decision events (legacy) or arbitrary event with phase
          if ((rec && rec.phase && rec.phase.toString().toUpperCase().includes('DECISION')) || rec.entityType === 'decisionEvent' || rec.type === 'decisionEvent') {
            try { await (this.prisma as any).decisionEvent.create({ data: rec }); } catch (_) { try { await this.getFallback().createDecisionEvent(rec); } catch (_) {} }
            continue;
          }

          // default fallback to audit log - try singular then plural Prisma model names
          try {
            try { await (this.prisma as any).auditLog.create({ data: rec }); }
            catch (_) { await (this.prisma as any).auditLogs.create({ data: rec }); }
          } catch (_) {
            try { await this.getFallback().createAuditLog(rec); } catch (_) {}
          }
        } catch (e) {
          // skip malformed
          continue;
        }
      }
      // Truncate file after successful flush
      await fsp.writeFile(p, '', { encoding: 'utf8' });
    } catch (e) {
      // ignore flush errors
    }
  }

  private getFallback(): IStorage {
    return this.fallback;
  }

  private reportFallback(reason: string, context?: any) {
    try {
      console.warn('[DbStorage] FALLBACK ->', reason, context || {});
      if (this.eventBridge && typeof this.eventBridge.emit === 'function') {
        this.eventBridge.emit('dataSource.fallback', {
          reason,
          context: context || {},
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      // ignore reporting failures
    }
  }

  private async testConnection(): Promise<void> {
    try {
      if (!this.prisma) {
        this.isConnected = false;
        this.reportFallback('prisma_client_unavailable', {});
        return;
      }
      await this.prisma.$queryRaw`SELECT 1`;
      this.isConnected = true;
      console.log('[DbStorage] Connected to PostgreSQL');
    } catch (error) {
      this.isConnected = false;
      console.warn('[DbStorage] Cannot connect to PostgreSQL, using in-memory fallback:', (error as any).message);
      this.reportFallback('db_connection_failed', { message: (error as any).message });
    }
  }

  async getMarketFrames(symbol: string, limit = 200): Promise<MarketFrame[]> {
    if (!this.isConnected) {
      this.reportFallback('using_in_memory', { method: 'getMarketFrames', symbol, limit });
      return this.getFallback().getMarketFrames(symbol, limit);
    }
    try {
      return await this.prisma.marketFrame.findMany({
        where: { symbol },
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
    } catch (error) {
      console.warn('[DbStorage] Query failed, using fallback:', (error as any).message);
      return this.getFallback().getMarketFrames(symbol, limit);
    }
  }

  async getMarketFramesForSymbols(symbols: string[], limit = 200): Promise<Record<string, MarketFrame[]>> {
    // Batch fetch latest `limit` frames per symbol using a single query with
    // row_number partitioning to avoid N+1 queries.
    if (!this.isConnected) {
      const out: Record<string, MarketFrame[]> = {};
      for (const s of symbols) {
        out[s] = await this.getFallback().getMarketFrames(s, limit);
      }
      return out;
    }

    if (!symbols || symbols.length === 0) return {};

    // Build VALUES list for parameterized query
    const vals: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const s of symbols) {
      vals.push(`($${idx})`);
      params.push(s);
      idx += 1;
    }

    const sql = `
      WITH pairs(symbol) AS (VALUES ${vals.join(',')}),
      ranked AS (
        SELECT mf.*, ROW_NUMBER() OVER (PARTITION BY mf.symbol ORDER BY mf.timestamp DESC) rn
        FROM "MarketFrame" mf
        JOIN pairs p ON p.symbol = mf.symbol
      )
      SELECT * FROM ranked WHERE rn <= ${limit};
    `;

    try {
      const rows: any[] = await (this.prisma as any).$queryRawUnsafe(sql, ...params);
      const grouped: Record<string, MarketFrame[]> = {};
      for (const r of rows) {
        const sym = r.symbol;
        if (!grouped[sym]) grouped[sym] = [];
        grouped[sym].push(r as MarketFrame);
      }
      return grouped;
    } catch (err) {
      console.warn('[DbStorage] Batch market frames query failed, falling back:', err);
      const out: Record<string, MarketFrame[]> = {};
      for (const s of symbols) {
        out[s] = await this.getFallback().getMarketFrames(s, limit);
      }
      return out;
    }
  }

  async createMarketFrame(frame: InsertMarketFrame): Promise<MarketFrame> {
    if (!this.isConnected) {
      this.reportFallback('using_in_memory', { method: 'createMarketFrame', symbol: frame.symbol });
      return this.getFallback().createMarketFrame(frame);
    }
    try {
      // Ensure all required fields are present for Prisma
      // frame may not have all fields from Drizzle schema, so we provide defaults
      const safeFrame = {
        symbol: frame.symbol,
        timeframe: (frame as any).timeframe ?? 3600, // Default to 1h if not specified
        open: (frame as any).open ?? null,
        high: (frame as any).high ?? null,
        low: (frame as any).low ?? null,
        close: (frame as any).close ?? null,
        volume: frame.volume ?? 0,
        isFinal: (frame as any).isFinal ?? false,
        price: (frame as any).price ?? {},
        indicators: (frame as any).indicators ?? {},
        orderFlow: (frame as any).orderFlow ?? {},
        marketMicrostructure: (frame as any).marketMicrostructure ?? {},
      };

      return await this.prisma.marketFrame.create({
        data: safeFrame,
      });
    } catch (error) {
      console.warn('[DbStorage] Write failed, using fallback:', (error as any).message);
      return this.getFallback().createMarketFrame(frame);
    }
  }

  async getLatestMarketFrame(symbol: string): Promise<MarketFrame | undefined> {
    if (!this.isConnected) {
      this.reportFallback('using_in_memory', { method: 'getLatestMarketFrame', symbol });
      return this.getFallback().getLatestMarketFrame(symbol);
    }
    try {
      const frame = await this.prisma.marketFrame.findFirst({
        where: { symbol },
        orderBy: { timestamp: 'desc' },
      });
      return frame ?? undefined;
    } catch (error) {
      console.warn('[DbStorage] Query failed, using fallback:', (error as any).message);
      return this.getFallback().getLatestMarketFrame(symbol);
    }
  }

  async getSignals(symbol?: string, limit = 100): Promise<Signal[]> {
    if (!this.isConnected) {
      this.reportFallback('using_in_memory', { method: 'getSignals', symbol, limit });
      return this.getFallback().getSignals(symbol, limit);
    }
    try {
      const results = await this.prisma.signal.findMany({
        where: symbol ? { symbol } : undefined,
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
      return results.map((r: any) => ({
        ...r,
        type: r.type as "BUY" | "SELL" | "HOLD",
        classifications: r.classifications ?? [],
        patternDetails: r.patternDetails ?? [],
        timeframeAlignment: r.timeframeAlignment ?? 0,
        agreementScore: r.agreementScore ?? 50,
        positionSize: r.positionSize ?? null,
      }));
    } catch (error) {
      console.warn('[DbStorage] Query failed, using fallback:', (error as any).message);
      return this.getFallback().getSignals(symbol, limit);
    }
  }

  async createSignal(signalData: InsertSignal): Promise<Signal> {
    if (!this.isConnected) {
      this.reportFallback('using_in_memory', { method: 'createSignal', symbol: signalData.symbol });
      return this.getFallback().createSignal(signalData);
    }
    try {
      // Ensure reasoning is a valid object for Prisma JSON field
      const safeSignal = {
        symbol: signalData.symbol,
        type: signalData.type as "BUY" | "SELL" | "HOLD",
        strength: signalData.strength,
        confidence: signalData.confidence,
        price: signalData.price,
        reasoning: signalData.reasoning ?? {},
        riskReward: signalData.riskReward,
        stopLoss: signalData.stopLoss,
        takeProfit: signalData.takeProfit,
        momentumLabel: (signalData as any).momentumLabel,
        regimeState: (signalData as any).regimeState,
        legacyLabel: (signalData as any).legacyLabel,
        signalStrengthScore: (signalData as any).signalStrengthScore,
        classifications: signalData.classifications ?? [],
        patternDetails: signalData.patternDetails ?? [],
        timeframeAlignment: signalData.timeframeAlignment ?? 0,
        agreementScore: signalData.agreementScore ?? 50,
        positionSize: signalData.positionSize ?? null,
        entryPrice: (signalData as any).entryPrice ?? signalData.price ?? 0, // Use provided entryPrice, fallback to price, or default to 0
        correlationId: (signalData as any).correlationId ?? uuidv4(),
      };
      
      const result = await this.prisma.signal.create({ data: safeSignal });
      return {
        ...result,
        type: result.type as "BUY" | "SELL" | "HOLD",
        classifications: (result as any).classifications ?? [],
        patternDetails: (result as any).patternDetails ?? [],
        timeframeAlignment: (result as any).timeframeAlignment ?? 0,
        agreementScore: (result as any).agreementScore ?? 50,
        positionSize: (result as any).positionSize ?? null,
      };
    } catch (error: any) {
      console.warn('[DbStorage] Write failed, using fallback:', (error as any).message);
      return this.getFallback().createSignal(signalData);
    }
  }

  async getLatestSignals(limit = 10): Promise<Signal[]> {
    if (!this.isConnected) {
      return this.getFallback().getLatestSignals(limit);
    }
    try {
      const results = await this.prisma.signal.findMany({
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
      return results.map((r: any) => ({
        ...r,
        type: r.type as "BUY" | "SELL" | "HOLD",
        classifications: r.classifications ?? [],
        patternDetails: r.patternDetails ?? [],
        timeframeAlignment: r.timeframeAlignment ?? 0,
        agreementScore: r.agreementScore ?? 50,
        positionSize: r.positionSize ?? null,
      }));
    } catch (error) {
      console.warn('[DbStorage] Query failed, using fallback:', (error as any).message);
      return this.getFallback().getLatestSignals(limit);
    }
  }

  async createDecisionEvent(record: any): Promise<void> {
    const safe = {
      correlationId: record.correlationId ?? null,
      phase: record.phase ?? 'UNKNOWN',
      domain: record.domain ?? null,
      actionPayload: record.actionPayload ?? {},
      metrics: record.metrics ?? {},
      agentIds: record.agentIds ?? [],
      moduleVersion: record.moduleVersion ?? null,
      marketFrameId: record.marketFrameId ?? null,
      timestamp: record.timestamp ? new Date(record.timestamp) : new Date(),
      extra: record.extra ?? {}
    } as any;

    if (!this.isConnected) {
      // enqueue to durable on-disk queue
      try { await this.enqueueFallback({ type: 'decisionEvent', ...safe }); } catch (_) { try { await this.getFallback().createDecisionEvent(record); } catch (_) {} }
      return;
    }

    try {
      try {
        await (this.prisma as any).decisionEvent.create({ data: safe });
      } catch (err) {
        // Prisma model may not exist or write failed; enqueue for later durability
        try { await this.enqueueFallback({ type: 'decisionEvent', ...safe }); } catch (e) { await this.createAuditLog({ entityType: 'decisionEvent', entityId: safe.correlationId, userId: null, details: safe, severity: 'INFO', timestamp: safe.timestamp } as any); }
      }
    } catch (error) {
      console.warn('[DbStorage] Write failed for decision event, using fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'decisionEvent', ...safe }); } catch (_) { try { await this.getFallback().createDecisionEvent(record); } catch (_) {} }
    }
  }

  async createDecisionSnapshot(record: any): Promise<void> {
    const safe = {
      traceId: record.traceId ?? record.correlationId ?? null,
      timestamp: record.timestamp ? new Date(record.timestamp) : new Date(),
      agents: record.agents ?? [],
      contributions: record.contributions ?? {},
      policyOutputs: record.policyOutputs ?? {},
      positionSizing: record.positionSizing ?? {},
      marketFrameId: record.marketFrameId ?? null,
      worldTime: record.worldTime ? new Date(record.worldTime) : null,
      moduleVersion: record.moduleVersion ?? null,
      extra: record.extra ?? {}
    } as any;

    if (!this.isConnected) {
      try { await this.enqueueFallback({ type: 'decisionSnapshot', ...safe }); } catch (_) { return this.getFallback().createDecisionEvent(record); }
      return;
    }
    try {
      try { await (this.prisma as any).decisionSnapshot.create({ data: safe }); } catch (err) { await this.enqueueFallback({ type: 'decisionSnapshot', ...safe }); }
    } catch (error) {
      console.warn('[DbStorage] Write failed for decision snapshot, enqueuing fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'decisionSnapshot', ...safe }); } catch (_) { return this.getFallback().createDecisionEvent(record); }
    }
  }

  // Return recent decision snapshots for aggregation/analysis
  async getRecentDecisionSnapshots(limit = 200): Promise<any[]> {
    if (!this.isConnected) {
      // fallback to in-memory snapshots
      try { return await (this.getFallback() as any).getRecentDecisionSnapshots?.(limit) || []; } catch (_) { return []; }
    }
    try {
      const snaps = await (this.prisma as any).decisionSnapshot.findMany({ orderBy: { timestamp: 'desc' }, take: limit });
      return snaps;
    } catch (error) {
      console.warn('[DbStorage] getRecentDecisionSnapshots failed, using fallback:', (error as any).message);
      try { return await (this.getFallback() as any).getRecentDecisionSnapshots?.(limit) || []; } catch (_) { return []; }
    }
  }

  async createOrderAudit(record: any): Promise<any> {
    const safe = {
      traceId: record.traceId ?? record.correlationId ?? null,
      orderId: record.orderId ?? null,
      exchange: record.exchange ?? null,
      venue: record.venue ?? null,
      params: record.params ?? {},
      preBalances: record.preBalances ?? {},
      reservationAmounts: record.reservationAmounts ?? {},
      fills: record.fills ?? [],
      simulatedSlippage: record.simulatedSlippage ?? null,
      realSlippage: record.realSlippage ?? null,
      realizedPnl: record.realizedPnl ?? null,
      createdAt: record.createdAt ? new Date(record.createdAt) : undefined,
    } as any;

    if (!this.isReady()) {
      try {
        await this.enqueueFallback({ type: 'orderAudit', ...safe });
        return safe; // persisted to queue
      } catch (_) {
        return this.getFallback().createOrderAudit ? this.getFallback().createOrderAudit(record) : null;
      }
    }

    try {
      const res = await (this.prisma as any).orderAudit.create({ data: safe });
      return res;
    } catch (error) {
      console.warn('[DbStorage] Write failed for order audit, enqueuing fallback:', (error as any).message);
      try {
        await this.enqueueFallback({ type: 'orderAudit', ...safe });
        return safe;
      } catch (_) {
        return this.getFallback().createOrderAudit ? this.getFallback().createOrderAudit(record) : null;
      }
    }
  }

  async updateOrderAudit(orderIdOrId: string, updates: any): Promise<void> {
    if (!this.isConnected) {
      return this.getFallback().createAuditLog({ action: 'updateOrderAudit_fallback', entityType: 'orderAudit', entityId: orderIdOrId, details: updates } as any);
    }
    try {
      // try by primary id
      try {
        await (this.prisma as any).orderAudit.update({ where: { id: orderIdOrId }, data: updates });
        return;
      } catch (_) {
        // fallback: find by orderId
        const found = await (this.prisma as any).orderAudit.findFirst({ where: { orderId: orderIdOrId } });
        if (!found) throw new Error('OrderAudit not found');
        await (this.prisma as any).orderAudit.update({ where: { id: found.id }, data: updates });
        return;
      }
    } catch (error) {
      console.warn('[DbStorage] Update failed for order audit, enqueuing fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'orderAudit.update', id: orderIdOrId, updates }); } catch (_) { await this.getFallback().createAuditLog({ action: 'orderAudit.update.failed', entityType: 'orderAudit', entityId: orderIdOrId, details: updates } as any); }
    }
  }

  async getTraceChain(traceId: string): Promise<any> {
    if (!this.isConnected) {
      return this.getFallback().getTraceChain(traceId);
    }
    try {
      const signals = await this.prisma.signal.findMany({ where: { correlationId: traceId } });
      const decisionEvents = await (this.prisma as any).decisionEvent.findMany({ where: { correlationId: traceId } });
      const decisionSnapshots = await (this.prisma as any).decisionSnapshot.findMany({ where: { traceId } });
      const orderAudits = await (this.prisma as any).orderAudit.findMany({ where: { traceId } });
      const provenances = await (this.prisma as any).tradeProvenance.findMany({ where: { correlationId: traceId } });

      // gather market frames referenced
      const frameIds = new Set<string>();
      for (const d of [...decisionEvents, ...decisionSnapshots]) { if (d.marketFrameId) frameIds.add(d.marketFrameId); }
      const marketFrames = frameIds.size > 0 ? await this.prisma.marketFrame.findMany({ where: { id: { in: Array.from(frameIds) } } }) : [];

      return { traceId, signals, decisionEvents, decisionSnapshots, orderAudits, provenances, marketFrames };
    } catch (error) {
      console.warn('[DbStorage] getTraceChain failed, using fallback:', (error as any).message);
      return this.getFallback().getTraceChain(traceId);
    }
  }

  async getTrades(status?: string): Promise<Trade[]> {
    if (!this.isConnected) {
      return this.getFallback().getTrades(status);
    }
    try {
      // Use entryTime for ordering, as Trade does not have timestamp
      const results = await this.prisma.trade.findMany({
        where: status ? { status } : undefined,
        orderBy: { entryTime: 'desc' },
      });
      return results.map((r: any) => ({
        ...r,
        status: r.status as "OPEN" | "CLOSED" | "CANCELLED",
        signalId: (r as any).signalId ?? null,
      }));
    } catch (error) {
      console.warn('[DbStorage] Query failed, using fallback:', (error as any).message);
      return this.getFallback().getTrades(status);
    }
  }

  async createTrade(trade: InsertTrade): Promise<Trade> {
    if (!this.isConnected) {
      return this.getFallback().createTrade(trade);
    }
    try {
      const result = await this.prisma.trade.create({ data: trade });
      return {
        ...result,
        status: result.status as "OPEN" | "CLOSED" | "CANCELLED",
        signalId: (result as any).signalId ?? null,
      };
    } catch (error) {
      console.warn('[DbStorage] Write failed, using fallback:', (error as any).message);
      return this.getFallback().createTrade(trade);
    }
  }

  async updateTrade(id: string, updates: Partial<Trade>): Promise<Trade> {
    if (!this.isConnected) {
      return this.getFallback().updateTrade(id, updates);
    }
    try {
      const result = await this.prisma.trade.update({ where: { id }, data: updates });
      return {
        ...result,
        status: result.status as "OPEN" | "CLOSED" | "CANCELLED",
        signalId: (result as any).signalId ?? null,
      };
    } catch (error) {
      console.warn('[DbStorage] Write failed, using fallback:', (error as any).message);
      return this.getFallback().updateTrade(id, updates);
    }
  }

  async getStrategies(): Promise<Strategy[]> {
    if (!this.isConnected) {
      return this.getFallback().getStrategies();
    }
    try {
      return await this.prisma.strategy.findMany();
    } catch (error) {
      console.warn('[DbStorage] Query failed, using fallback:', (error as any).message);
      return this.getFallback().getStrategies();
    }
  }

  async createStrategy(strategy: InsertStrategy): Promise<Strategy> {
    if (!this.isConnected) {
      return this.getFallback().createStrategy(strategy);
    }
    try {
      const safeStrategy = {
        ...strategy,
        riskParams: JSON.parse(JSON.stringify(strategy.riskParams)),
        performance: JSON.parse(JSON.stringify(strategy.performance)),
      };
      return await this.prisma.strategy.create({ data: safeStrategy });
    } catch (error) {
      console.warn('[DbStorage] Write failed, using fallback:', (error as any).message);
      return this.getFallback().createStrategy(strategy);
    }
  }

  async updateStrategy(id: string, updates: Partial<Strategy>): Promise<Strategy> {
    if (!this.isConnected) {
      return this.getFallback().updateStrategy(id, updates);
    }
    try {
      // Ensure riskParams and performance are valid JSON objects for Prisma
      const safeUpdates = {
        ...updates,
        riskParams: updates.riskParams ?? {},
        performance: updates.performance ?? {},
      };
      return await this.prisma.strategy.update({ where: { id }, data: safeUpdates });
    } catch (error) {
      console.warn('[DbStorage] Write failed, using fallback:', (error as any).message);
      return this.getFallback().updateStrategy(id, updates);
    }
  }

  async getBacktestResults(strategyId?: string): Promise<BacktestResult[]> {
    if (!this.isReady()) return this.getFallback().getBacktestResults(strategyId);
    try {
      const results = await this.prisma.backtestResult.findMany({
        where: strategyId ? { strategyId } : undefined,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          strategyId: true,
          startDate: true,
          endDate: true,
          initialCapital: true,
          finalCapital: true,
          performance: true,
          equityCurve: true,
          monthlyReturns: true,
          metrics: true,
          trades: true,
          createdAt: true,
        },
      });
      return results.map((r: any) => ({
        id: r.id,
        strategyId: r.strategyId,
        startDate: r.startDate,
        endDate: r.endDate,
        initialCapital: r.initialCapital,
        finalCapital: r.finalCapital,
        performance: r.performance ?? {},
        equityCurve: r.equityCurve ?? [],
        monthlyReturns: r.monthlyReturns ?? [],
        metrics: r.metrics ?? {},
        trades: r.trades ?? [],
        createdAt: r.createdAt,
      }));
    } catch (error) {
      console.warn('[DbStorage] getBacktestResults failed, using fallback:', (error as any).message);
      return this.getFallback().getBacktestResults(strategyId);
    }
  }

  async deleteBacktestResult(id: string): Promise<void> {
    if (!this.isReady()) return this.getFallback().deleteBacktestResult(id);
    try {
      await this.prisma.backtestResult.delete({ where: { id } });
    } catch (error) {
      console.warn('[DbStorage] deleteBacktestResult failed, using fallback:', (error as any).message);
      return this.getFallback().deleteBacktestResult(id);
    }
  }

  async createBacktestResult(result: InsertBacktestResult): Promise<BacktestResult> {
    // Only pass fields that are allowed for creation; id and createdAt are generated by DB
    const safeResult = {
      strategyId: result.strategyId,
      startDate: result.startDate ?? new Date(),
      endDate: result.endDate ?? new Date(),
      initialCapital: result.initialCapital ?? 0,
      finalCapital: result.finalCapital ?? 0,
      performance: result.performance ?? {},
      equityCurve: result.equityCurve ?? [],
      monthlyReturns: result.monthlyReturns ?? [],
      metrics: result.metrics ?? {},
      trades: result.trades ?? [],
    };
    if (!this.isReady()) return this.getFallback().createBacktestResult(result);
    try {
      return await this.prisma.backtestResult.create({ data: safeResult });
    } catch (error) {
      console.warn('[DbStorage] createBacktestResult failed, using fallback:', (error as any).message);
      return this.getFallback().createBacktestResult(result);
    }
  }

  // Model metrics persistence
  async createModelMetric(metric: InsertModelMetric): Promise<void> {
    if (!this.isConnected) {
      return this.getFallback().createModelMetric(metric);
    }
    try {
      await this.tryPrismaCreate(['modelMetrics','modelMetric'], {
        modelName: metric.modelName,
        accuracy: metric.accuracy ?? null,
        precision: metric.precision ?? null,
        recall: metric.recall ?? null,
        driftScore: metric.driftScore ?? null,
        dataPoints: metric.dataPoints ?? 0,
        isStale: metric.isStale ?? false,
      });
    } catch (error) {
      console.warn('[DbStorage] Write failed for model metric, using fallback:', (error as any).message);
      return this.getFallback().createModelMetric(metric);
    }
  }

  async getLatestModelMetrics(modelName: string, limit = 10): Promise<ModelMetric[]> {
    if (!this.isConnected) {
      return this.getFallback().getLatestModelMetrics(modelName, limit);
    }
    try {
      const results = await this.tryPrismaFindMany(['modelMetrics','modelMetric'], { where: { modelName }, orderBy: { timestamp: 'desc' }, take: limit });
      return results as any;
    } catch (error) {
      console.warn('[DbStorage] Query failed for model metrics, using fallback:', (error as any).message);
      return this.getFallback().getLatestModelMetrics(modelName, limit);
    }
  }

  async getStaleModelMetrics(): Promise<ModelMetric[]> {
    if (!this.isConnected) {
      return this.getFallback().getStaleModelMetrics();
    }
    try {
      const results = await this.tryPrismaFindMany(['modelMetrics','modelMetric'], { where: { isStale: true }, orderBy: { timestamp: 'desc' } });
      return results as any;
    } catch (error) {
      console.warn('[DbStorage] Query failed for stale model metrics, using fallback:', (error as any).message);
      return this.getFallback().getStaleModelMetrics();
    }
  }

  // ScanRun persistence for scanner-analysis
  async createScanRun(scan: { scanId: string; timestamp: string; timeframe?: string; symbolCount?: number; payload: any; }): Promise<any> {
    const data = {
      scanId: scan.scanId,
      timestamp: new Date(scan.timestamp),
      timeframe: scan.timeframe ?? null,
      symbolCount: scan.symbolCount ?? (Array.isArray(scan.payload?.results) ? scan.payload.results.length : 0),
      payload: scan.payload ?? {}
    };
    if (!this.isReady()) return this.getFallback().createScanRun ? (this.getFallback() as any).createScanRun(scan) : null;
    try {
      return await this.prisma.scanRun.create({ data });
    } catch (error) {
      console.warn('[DbStorage] createScanRun failed, using fallback:', (error as any).message);
      try { return await (this.getFallback() as any).createScanRun(scan); } catch (_) { return null; }
    }
  }

  async getRecentScanRuns(limit = 10): Promise<any[]> {
    if (!this.isReady()) return this.getFallback().getRecentScanRuns ? (this.getFallback() as any).getRecentScanRuns(limit) : [];
    try {
      const results = await this.prisma.scanRun.findMany({ orderBy: { timestamp: 'desc' }, take: limit });
      return results;
    } catch (error) {
      console.warn('[DbStorage] getRecentScanRuns failed, using fallback:', (error as any).message);
      try { return await (this.getFallback() as any).getRecentScanRuns(limit); } catch (_) { return []; }
    }
  }

  async getMarketSentiment(): Promise<MarketSentiment> {
    if (!this.isReady()) return this.getFallback().getMarketSentiment();
    try {
      const sentiment = await this.prisma.marketSentiment.findFirst({ orderBy: { createdAt: 'desc' } });
      if (!sentiment) return this.getFallback().getMarketSentiment();
      const data = (sentiment as any).data || sentiment;
      return {
        fearGreedIndex: data.fearGreedIndex ?? 0,
        btcDominance: data.btcDominance ?? 0,
        totalMarketCap: data.totalMarketCap ?? 0,
        volume24h: data.volume24h ?? 0,
      };
    } catch (error) {
      console.warn('[DbStorage] getMarketSentiment failed, using fallback:', (error as any).message);
      return this.getFallback().getMarketSentiment();
    }
  }

  async getPortfolioSummary(): Promise<PortfolioSummary> {
    if (!this.isReady()) return this.getFallback().getPortfolioSummary();
    try {
      const summary = await this.prisma.portfolioSummary.findFirst({ orderBy: { createdAt: 'desc' } });
      if (!summary) return this.getFallback().getPortfolioSummary();
      const data = (summary as any).data || summary;
      return {
        totalValue: data.totalValue ?? 0,
        availableCash: data.availableCash ?? 0,
        invested: data.invested ?? 0,
        dayChange: data.dayChange ?? 0,
        dayChangePercent: data.dayChangePercent ?? 0,
      };
    } catch (error) {
      console.warn('[DbStorage] getPortfolioSummary failed, using fallback:', (error as any).message);
      return this.getFallback().getPortfolioSummary();
    }
  }

  async getRecentFrames(limit: number = 1000): Promise<MarketFrame[]> {
    if (!this.isReady()) return this.getFallback().getRecentFrames ? (this.getFallback() as any).getRecentFrames(limit) : [];
    try {
      return await this.prisma.marketFrame.findMany({ orderBy: { timestamp: 'desc' }, take: limit });
    } catch (error) {
      console.warn('[DbStorage] getRecentFrames failed, using fallback:', (error as any).message);
      try { return await (this.getFallback() as any).getRecentFrames(limit); } catch (_) { return []; }
    }
  }

  async createSignalPerformance(performance: any): Promise<void> {
    const safe = {
      signalId: performance.signalId ?? null,
      timestamp: performance.timestamp ? new Date(performance.timestamp) : new Date(),
      pnl: performance.pnl ?? null,
      realizedPnl: performance.realizedPnl ?? null,
      metrics: performance.metrics ?? {},
      features: performance.features ?? {},
      extra: performance.extra ?? {},
    } as any;

    if (!this.isConnected) {
      try { await this.enqueueFallback({ type: 'signalPerformance', ...safe }); } catch (_) { try { await this.getFallback().createSignalPerformance(performance); } catch (_) {} }
      return;
    }

    try {
      try {
        await (this.prisma as any).signalPerformance.create({ data: safe });
        return;
      } catch (_) {
        // try helper for alternative model names
        try { await this.tryPrismaCreate(['signalPerformances','signal_performance','signal_metrics'], safe); return; } catch (_) {}
      }
      // if direct write not possible enqueue for durability
      await this.enqueueFallback({ type: 'signalPerformance', ...safe });
    } catch (error) {
      console.warn('[DbStorage] Write failed for signal performance, enqueuing fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'signalPerformance', ...safe }); } catch (_) { try { await this.getFallback().createSignalPerformance(performance); } catch (_) {} }
    }
  }

  async updateSignalPerformance(signalId: string, updates: any): Promise<void> {
    if (!this.isConnected) {
      try { await this.enqueueFallback({ type: 'signalPerformance.update', id: signalId, updates }); } catch (_) { try { await this.getFallback().updateSignalPerformance(signalId, updates); } catch (_) {} }
      return;
    }
    try {
      try {
        // try update by primary id
        await (this.prisma as any).signalPerformance.update({ where: { id: signalId }, data: updates });
        return;
      } catch (_) {
        // try update by signalId
        try {
          await (this.prisma as any).signalPerformance.updateMany({ where: { signalId }, data: updates });
          return;
        } catch (_) {
          // enqueue update for later
          await this.enqueueFallback({ type: 'signalPerformance.update', id: signalId, updates });
          return;
        }
      }
    } catch (error) {
      console.warn('[DbStorage] Update failed for signal performance, enqueuing fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'signalPerformance.update', id: signalId, updates }); } catch (_) { try { await this.getFallback().updateSignalPerformance(signalId, updates); } catch (_) {} }
    }
  }

  // Audit log persistence (DB-backed when available)
  async createAuditLog(log: import("@shared/schema").InsertAuditLog): Promise<void> {
    const ts = (log as any).timestamp ? new Date((log as any).timestamp) : new Date();
    const safe = { action: log.action, entityType: log.entityType, entityId: log.entityId, userId: (log as any).userId ?? null, details: (log as any).details ?? {}, severity: (log as any).severity ?? 'INFO', timestamp: ts } as any;
    if (!this.isConnected) {
      try { await this.enqueueFallback({ type: 'auditLog', ...safe }); } catch (_) { return this.getFallback().createAuditLog(log); }
      return;
    }
    try {
      // Try singular then plural Prisma model names
      try { await (this.prisma as any).auditLog.create({ data: safe } as any); }
      catch (_) { await (this.prisma as any).auditLogs.create({ data: safe } as any); }
    } catch (error) {
      console.warn('[DbStorage] Write failed for audit log, enqueuing fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'auditLog', ...safe }); } catch (_) { return this.getFallback().createAuditLog(log); }
    }
  }

  async getAuditLogs(entityType?: string, entityId?: string, limit = 100): Promise<import("@shared/schema").InsertAuditLog[]> {
    if (!this.isConnected) {
      return this.getFallback().getAuditLogs(entityType, entityId, limit);
    }
    try {
      const where: any = {};
      if (entityType) where.entityType = entityType;
      if (entityId) where.entityId = entityId;
      // Try singular then plural Prisma model names
      try {
        const results = await (this.prisma as any).auditLog.findMany({ where, orderBy: { timestamp: 'desc' }, take: limit });
        return results as any as import("@shared/schema").InsertAuditLog[];
      } catch (_) {
        const results = await (this.prisma as any).auditLogs.findMany({ where, orderBy: { timestamp: 'desc' }, take: limit });
        return results as any as import("@shared/schema").InsertAuditLog[];
      }
    } catch (error) {
      console.warn('[DbStorage] Query failed for audit logs, using fallback:', (error as any).message);
      return this.getFallback().getAuditLogs(entityType, entityId, limit);
    }
  }

  async createTradeProvenance(record: any): Promise<void> {
    const safe = {
      tradeId: record.tradeId ?? null,
      engine: record.engine ?? 'LIVE',
      symbol: record.symbol ?? (record.execution?.symbol ?? ''),
      correlationId: record.correlationId ?? (record.signal?.correlationId ?? null),
      signalId: record.signalId ?? null,
      signal: record.signal ?? {},
      consensus: record.consensus ?? {},
      agentDecision: record.agentDecision ?? {},
      execution: record.execution ?? {},
      extra: record.extra ?? {},
      createdAt: record.createdAt ? new Date(record.createdAt) : undefined,
    } as any;

    if (!this.isConnected) {
      try { await this.enqueueFallback({ type: 'tradeProvenance', ...safe }); } catch (_) { return this.getFallback().createTradeProvenance(record); }
      return;
    }
    try {
      await (this.prisma as any).tradeProvenance.create({ data: safe });
    } catch (error) {
      console.warn('[DbStorage] Write failed for trade provenance, enqueuing fallback:', (error as any).message);
      try { await this.enqueueFallback({ type: 'tradeProvenance', ...safe }); } catch (_) { return this.getFallback().createTradeProvenance(record); }
    }
  }

  /**
   * Generic raw query method for custom SQL queries
   */
  async query(sql: string, values?: any[]): Promise<{ rows: any[] }> {
    if (!this.isConnected) {
      console.warn('[DbStorage] Database not connected, cannot execute query');
      return { rows: [] };
    }
    try {
      const result = await (this.prisma as any).$queryRawUnsafe(sql, ...(values || []));
      return { rows: Array.isArray(result) ? result : [result] };
    } catch (error) {
      console.warn('[DbStorage] Raw query failed:', (error as any).message);
      return { rows: [] };
    }
  }
}

// Export singleton instance
export const db = new DbStorage();