
import * as ccxt from 'ccxt';
import { EventEmitter } from 'events';
import { systemKillSwitch } from './services/system-kill-switch';
import { portfolioRiskManager } from './services/portfolio-risk-manager';
import { liveCircuitBreaker } from './services/live-circuit-breaker';
import { getAccountBalanceUsd } from './services/exchange-utils';
import { db } from './db-storage';
import type { Signal } from '@shared/schema';
import { RLFeedbackCallbacks } from './rl-system-integration';
import { randomUUID } from 'crypto';
import { ModuleLogger, formatError } from './utils/logger';
import { getConfidenceScorer } from './services/market-data/confidence-scorer';
import executionMetrics from './metrics-execution';
import SlippageModel from './services/slippage-model';
import PartialFillSimulator from './services/partial-fill-simulator';
import MockNetwork from './services/mock-network';
import VenueRouter from './services/venue-router';
import OrderRetryPolicy from './services/order-retry-policy';

// Small helper to bound a promise with a timeout. Returns null on timeout or error.
async function promiseWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);

    p.then((v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    }).catch((_err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

interface LiveOrder {
  id: string;
  exchangeOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  price?: number;
  amount: number;
  status: 'pending' | 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';
  filled: number;
  remaining: number;
  cost: number;
  fee?: {
    cost: number;
    currency: string;
  };
  timestamp: number;
  signalId?: string;
}

interface LivePosition {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  leverage: number;
  pnl: number;
  pnlPercent: number;
  stopLoss?: number;
  takeProfit?: number;
  openTime: number;
  marginUsed: number;
  liquidationPrice?: number;
  orders: LiveOrder[];
}

interface ExecutionConfig {
  enabled: boolean;
  exchange: string;
  testMode: boolean; // Use exchange sandbox
  maxPositionSize: number; // Max USD per position
  maxTotalExposure: number; // Max total USD exposure
  defaultLeverage: number;
  slippageTolerance: number; // Max acceptable slippage %
  minConfidence: number;
}

export class LiveTradingEngine extends EventEmitter {
  private exchange: ccxt.Exchange | null = null;
  private positions: Map<string, LivePosition> = new Map();
  private orders: Map<string, LiveOrder> = new Map();
  private isRunning: boolean = false;
  private monitorInterval?: NodeJS.Timeout;
  private config: ExecutionConfig;
  // Shadow execution / simulation helpers
  private slippageModel: SlippageModel;
  private partialFillSim: PartialFillSimulator;
  private mockNetwork: MockNetwork;
  private venueRouter: VenueRouter;
  private retryPolicy: OrderRetryPolicy;
  private consecutiveFailures: number = 0;
  private circuitBreakerThreshold: number = 5; // pause after N consecutive failures

  constructor(config?: Partial<ExecutionConfig>) {
    super();
    this.config = {
      enabled: false,
      exchange: 'binance',
      testMode: true, // Always start in test mode
      maxPositionSize: 1000,
      maxTotalExposure: 5000,
      defaultLeverage: 5,
      slippageTolerance: 0.5,
      minConfidence: 0.7,
      ...config
    };

    // Listen for global kill-switch events
    try {
      systemKillSwitch.on('kill', async (state) => {
        const logger = new ModuleLogger('LiveTrading');
        logger.warn('Global kill-switch activated, pausing trading', state);
        // Pause engine immediately
        this.pause();

        // If operator requested forced close, attempt safe closes if configured
        const forceClose = process.env.KILL_FORCE_CLOSE === '1';
        if (forceClose) {
          logger.warn('Force-close on kill enabled: attempting to close open positions');
          try {
            const status = this.getStatus();
            for (const pos of status.positions) {
              try { await this.closePosition(pos.id); } catch (e) { logger.warn('Force close failed', e); }
            }
          } catch (e) {
            logger.error('Error while attempting force-close after kill', e);
          }
        }
      });

      // Listen for global circuit breaker activation
      try {
        liveCircuitBreaker.on('activated', async (s: any) => {
          const logger = new ModuleLogger('LiveTrading');
          logger.warn('Global circuit breaker activated, halting new placements', s);
          // Prevent new placements
          this.config.enabled = false;
          // Attempt to cancel open orders
          if (this.exchange) {
            for (const [id, ord] of Array.from(this.orders.entries())) {
              try {
                await this.exchange.cancelOrder(ord.exchangeOrderId, ord.symbol);
                logger.info(`Cancelled order due to circuit break: ${ord.exchangeOrderId}`);
              } catch (e) {
                logger.warn('Failed to cancel order during circuit break', e);
              }
            }
          }
        });
        liveCircuitBreaker.on('cleared', (s: any) => {
          const logger = new ModuleLogger('LiveTrading');
          logger.info('Global circuit breaker cleared', s);
          // allow placements again
          this.config.enabled = true;
        });
      } catch (e) {}
      systemKillSwitch.on('clear', (state) => {
        const logger = new ModuleLogger('LiveTrading');
        logger.info('Global kill-switch cleared', state);
      });
    } catch (e) {
      // ignore if kill-switch unavailable
    }
    // initialize simulation helpers with sensible defaults
    this.slippageModel = new SlippageModel({ percent: 0.2, mode: 'percentage' });
    this.partialFillSim = new PartialFillSimulator({ typicalDepth: 1000, aggressiveness: 0.6 });
    this.mockNetwork = new MockNetwork({ meanLatencyMs: 50, jitterMs: 30, rateLimitPerSec: 1000 });
    this.venueRouter = new VenueRouter();
    this.retryPolicy = new OrderRetryPolicy();
  }

  /**
   * Initialize exchange connection
   */
  async initialize(): Promise<void> {
    try {
      
      const exchangeName = this.config.exchange;
      const ExchangeClass = ccxt[exchangeName as keyof typeof ccxt] as any;
      
      if (!ExchangeClass) {
        throw new Error(`Exchange ${exchangeName} not supported`);
      }

      this.exchange = new ExchangeClass({
        apiKey: process.env[`${exchangeName.toUpperCase()}_API_KEY`],
        secret: process.env[`${exchangeName.toUpperCase()}_SECRET`],
        enableRateLimit: true,
        options: {
          defaultType: 'future', // Use futures for leverage
          ...(this.config.testMode && { sandbox: true })
        }
      });

      if (!this.exchange) {
        throw new Error(`Failed to initialize exchange ${exchangeName}`);
      }
      await this.exchange.loadMarkets();
      
      const logger = new ModuleLogger('LiveTrading');
      logger.info(`Connected to ${exchangeName} (${this.config.testMode ? 'TESTNET' : 'LIVE'})`);

      this.emit('initialized', { exchange: exchangeName, testMode: this.config.testMode });

      // Immediately sync positions on startup to avoid missing open positions
      try {
        await this.updatePositions();
      } catch (err) {
        const logger = new ModuleLogger('LiveTrading');
        logger.warn('initial position sync failed', err);
      }
    } catch (error: any) {
      const logger = new ModuleLogger('LiveTrading');
      const fe = formatError(error);
      logger.error(`Initialization failed: ${fe.message}`, { stack: fe.stack });
      throw error;
    }
  }

  /**
   * Attempt to switch active exchange/venue by name (ccxt key). Returns true on success.
   */
  async switchVenue(venueName: string): Promise<boolean> {
    const logger = new ModuleLogger('LiveTrading');
    if (!venueName) return false;
    try {
      const ExchangeClass = ccxt[venueName as keyof typeof ccxt] as any;
      if (!ExchangeClass) {
        logger.warn(`switchVenue: exchange ${venueName} not supported`);
        return false;
      }
      const ex = new ExchangeClass({
        apiKey: process.env[`${venueName.toUpperCase()}_API_KEY`],
        secret: process.env[`${venueName.toUpperCase()}_SECRET`],
        enableRateLimit: true,
        options: { defaultType: 'future', ...(this.config.testMode && { sandbox: true }) }
      });
      await ex.loadMarkets();
      this.exchange = ex;
      this.config.exchange = venueName;
      logger.info(`Switched venue to ${venueName}`);
      return true;
    } catch (e) {
      logger.warn('Failed to switch venue', e);
      return false;
    }
  }

  /**
   * Start live trading engine
   */
  async start(): Promise<void> {
    if (!this.exchange) {
      await this.initialize();
    }

    this.isRunning = true;
    this.config.enabled = true;

    // Monitor positions and orders every 5 seconds
    this.monitorInterval = setInterval(() => {
      this.updatePositions();
      this.checkOrders();
    }, 5000);

    this.emit('started');
    new ModuleLogger('LiveTrading').info('Engine started');
  }

  /**
   * Stop live trading engine
   */
  stop(): void {
    this.isRunning = false;
    this.config.enabled = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    this.emit('stopped');
    new ModuleLogger('LiveTrading').info('Engine stopped');
  }

  /**
   * Execute a signal on the live exchange
   */
  async executeSignal(signal: Signal): Promise<LiveOrder | null> {
    const logger = new ModuleLogger('LiveTrading');
    if (liveCircuitBreaker.isActive()) {
      logger.warn('Execution blocked: global circuit breaker active');
      this.emit('executionBlocked', { type: 'circuit_breaker', reason: liveCircuitBreaker.getState() });
      return null;
    }
    if (!this.exchange || !this.config.enabled) {
      logger.info('Engine not enabled');
      return null;
    }

    // Safety checks
    try {
      const scorer = getConfidenceScorer();
      const scored = scorer.scoreWithCurrentMode(signal.confidence, 'execution');
      if (!scored.canTrade) {
        logger.info(`Signal blocked by mode-aware scorer: ${scored.reason}`);
        return null;
      }
      // Use adjusted confidence for execution threshold checks
      if (scored.adjusted < this.config.minConfidence) {
        logger.info(`Signal confidence too low after adjustment: ${scored.adjusted}`);
        return null;
      }
      // update signal confidence to adjusted
      signal.confidence = scored.adjusted;
    } catch (e) {
      // fallback to legacy check
      if (signal.confidence < this.config.minConfidence) {
        logger.info(`Signal confidence too low: ${signal.confidence}`);
        return null;
      }
    }

    // Enforce portfolio-level limits from PortfolioRiskManager
    let accountBalance = Number(process.env.PORTFOLIO_CAPITAL) || 10000;
    let consensus: any = null;
    let rlDecision: any = null;
    let reservationTokens: string[] | null = null;

    try {
      const fetched = await getAccountBalanceUsd(this.exchange);
      if (typeof fetched === 'number') accountBalance = fetched;

      const limits = portfolioRiskManager.getLimits();
      const metrics = portfolioRiskManager.getPortfolioMetrics(accountBalance);

      if (metrics.dailyPnlPercent < -limits.maxDailyLoss) {
        const reason = `dailyLoss:${metrics.dailyPnlPercent.toFixed(2)}%`;
        logger.warn(`Blocked by daily loss limit: ${metrics.dailyPnlPercent.toFixed(2)}% <= -${limits.maxDailyLoss}%`);
        this.emit('executionBlocked', { 
          type: 'portfolio_limit',
          reason,
          timestamp: Date.now(),
          signalId: signal.id,
          symbol: signal.symbol,
          accountBalance,
          limits,
          metrics
        });
        return null;
      }

      if (metrics.currentDrawdown >= limits.maxPortfolioDrawdown) {
        const reason = `drawdown:${metrics.currentDrawdown.toFixed(2)}%`;
        logger.warn(`Blocked by portfolio drawdown limit: ${metrics.currentDrawdown.toFixed(2)}% >= ${limits.maxPortfolioDrawdown}%`);
        this.emit('executionBlocked', {
          type: 'portfolio_limit',
          reason,
          timestamp: Date.now(),
          signalId: signal.id,
          symbol: signal.symbol,
          accountBalance,
          limits,
          metrics
        });
        return null;
      }
    } catch (pmErr) {
      // non-fatal: continue if portfolio manager unavailable
      logger.warn('PortfolioRiskManager check failed, continuing', pmErr);
    }

    const totalExposure = this.getTotalExposure();
    if (totalExposure >= this.config.maxTotalExposure) {
      logger.info(`Max exposure reached: $${totalExposure}`);
      return null;
    }

    // Ensure market data is healthy for this symbol via TruthEngine
    try {
      const truth = (global as any).truthEngine as any;
      if (truth && typeof truth.isTradeable === 'function') {
        const tradeable = truth.isTradeable(signal.symbol, {
          minSources: Number(process.env.MIN_TRUTH_SOURCES) || 2,
          minConfidence: Number(process.env.MIN_TRUTH_CONFIDENCE) || 60,
          maxAgeMs: Number(process.env.TRUTH_MAX_AGE_MS) || undefined
        });
        if (!tradeable.ok) {
          logger.warn(`Blocked by TruthEngine: ${tradeable.reason}`);
          this.emit('executionBlocked', {
            type: 'truth',
            reason: tradeable.reason,
            timestamp: Date.now(),
            signalId: signal.id,
            symbol: signal.symbol
          });
          if (process.env.ROUTE_TO_PAPER_ON_TRUTH_FAIL === '1') {
            this.emit('executionRoutedToPaper', { signal, reason: tradeable.reason });
          }
          return null;
        }
      }
    } catch (e) {
      // non-fatal: proceed if TruthEngine not available or check fails
    }

    try {
      // Position sizing: prefer RL agent if available, otherwise fallback to simple sizing
      let positionSizeUSD = Math.min(
        this.config.maxPositionSize,
        this.config.maxTotalExposure - totalExposure
      );

      // Ask PortfolioRiskManager for consensus sizing and approval (best-effort)
      try {
        const atr = (signal.price || 0) * 0.02;
        const consensus = await portfolioRiskManager.getPositionSizingConsensus(
          signal.symbol,
          signal.confidence || 0,
          signal.type === 'BUY' ? 'BUY' : 'SELL',
          accountBalance,
          signal.price || 0,
          atr,
          'TRENDING',
          ''
        );

        if (!consensus.approved || consensus.finalSize <= 0) {
            const reason = `consensus_reject`;
            logger.info(`Execution blocked by PortfolioRiskManager: ${consensus.reasoning.join('; ')}`);
            this.emit('executionBlocked', {
              type: 'consensus',
              reason,
              timestamp: Date.now(),
              signalId: signal.id,
              symbol: signal.symbol,
              consensus
            });
            return null;
          }

        positionSizeUSD = Math.min(positionSizeUSD, consensus.finalSize);
      } catch (pmErr) {
        // ignore failures in portfolio manager and continue with local sizing
        logger.warn('PortfolioRiskManager sizing failed, using fallback sizing', pmErr);
      }

      try {
        const rlAgent = (global as any).rlPositionAgent;
        if (rlAgent && typeof rlAgent.getFullDecision === 'function') {
          try {
            const timeoutMs = Number(process.env.RL_DECISION_TIMEOUT_MS) || 200;
            const decision: any | null = await promiseWithTimeout((rlAgent as any).getFullDecision(signal), timeoutMs);
            if (!decision) {
              logger.warn(`RL decision timed out or failed after ${timeoutMs}ms, using fallback sizing`);
            } else if (decision && decision.sizing && typeof decision.sizing.positionSize === 'number') {
              positionSizeUSD = Math.min(positionSizeUSD, decision.sizing.positionSize);
            }
            // Persist a decision snapshot for RL decision
            try {
              if (decision) {
                await db.createDecisionSnapshot({
                  traceId: (signal as any).correlationId ?? null,
                  agents: ['rlPositionAgent'],
                  contributions: decision.contributions ?? {},
                  policyOutputs: decision.policyOutputs ?? decision.sizing ?? {},
                  positionSizing: { accountBalance, requested: positionSizeUSD, resolved: decision.sizing?.positionSize ?? null },
                  marketFrameId: (await db.getLatestMarketFrame(signal.symbol))?.id ?? null,
                  worldTime: (await db.getLatestMarketFrame(signal.symbol))?.timestamp ?? null,
                  moduleVersion: process.env.COMMIT_SHA || process.env.MODEL_VERSION || null,
                });
              }
            } catch (e) { logger.warn('Failed to persist RL decision snapshot', e); }
          } catch (err) {
            logger.warn('RL decision wrapper error, using fallback sizing', err);
          }
        }
      } catch (e) {
        // ignore RL sizing failures and fallback to default sizing
      }

      let amount = positionSizeUSD / Math.max(1, signal.price);
      // If TruthEngine consensus price exists, prefer it for amount calculation
      try {
        const truth = (global as any).truthEngine as any;
        if (truth && typeof truth.getConsensus === 'function') {
          const cons = truth.getConsensus(signal.symbol);
          if (cons && typeof cons.price === 'number' && cons.price > 0) {
            // basic staleness check (if available)
            const isStale = typeof truth.isStale === 'function' ? truth.isStale(signal.symbol) : false;
            if (!isStale) {
              // check slippage tolerance vs consensus
              const refPrice = cons.price;
              const sigPrice = signal.price || refPrice;
              const slippagePct = Math.abs((sigPrice - refPrice) / Math.max(1, refPrice)) * 100;
              if (slippagePct > this.config.slippageTolerance) {
                logger.info(`Blocked execution: signal price ${sigPrice} deviates ${slippagePct.toFixed(2)}% from consensus ${refPrice}`);
                return null;
              }
              // use consensus for amount
              const amt = positionSizeUSD / Math.max(1, refPrice);
              // prefer consensus-based amount (safer sizing)
              if (amt > 0) {
                amount = Math.min(amount, amt);
              }
            }
          }
        }
      } catch (e) { /* non-fatal */ }

      // Ensure leverage is set for futures exchanges when supported
      try {
        if (this.config.defaultLeverage && (this.exchange as any).setLeverage) {
          try {
            await (this.exchange as any).setLeverage(this.config.defaultLeverage, signal.symbol);
          } catch (e) {
            // not all exchanges support per-symbol setLeverage; ignore failures
          }
        }
      } catch (e) { /* ignore */ }

      // Reserve capital atomically before placement
      let reservationToken: string | null = null;
      try {
        const reserveAmount = positionSizeUSD;
        reservationToken = portfolioRiskManager.reserveCapital(reserveAmount, (signal as any).correlationId ?? null);
      } catch (reserveErr) {
        logger.warn('Reservation failed, blocking execution', reserveErr);
        this.emit('executionBlocked', { type: 'reservation', reason: String(reserveErr), signalId: signal.id, symbol: signal.symbol });
        return null;
      }

      // Place market order with simulated network, slippage and retry/failover behavior
      let order: any = null;
      const enableShadow = (process.env.SHADOW_FIDELITY === '1') || this.config.testMode;
      let attempt = 0;
      let lastError: any = null;
      let currentAmount = amount;
      let currentVenue = this.config.exchange;

      while (true) {
        try {
          // rate-limit and latency injection
          try { this.mockNetwork.checkRateLimit(); } catch (rlErr) { throw rlErr; }
          await this.mockNetwork.delay();

          order = await (this.exchange as any).createOrder(
            signal.symbol,
            'market',
            signal.type.toLowerCase() as 'buy' | 'sell',
            currentAmount
          );

          // success
          break;
        } catch (err: any) {
          lastError = err;
          attempt += 1;
          const code = err && err.code ? String(err.code) : (err && err.message ? String(err.message) : 'UNKNOWN');
          const action = this.retryPolicy.mapRejection(code || 'UNKNOWN');

          const logger2 = new ModuleLogger('LiveTrading');
          logger2.warn(`Order placement failed (attempt ${attempt}): action=${action} code=${code}`);

          // Record retry decision for traceability
          try {
            await db.createDecisionEvent({
              correlationId: (signal as any).correlationId ?? null,
              phase: 'ORDER_RETRY_DECISION',
              domain: 'OrderRetryPolicy',
              actionPayload: { action, code },
              metrics: { attempt },
              agentIds: ['OrderRetryPolicy'],
              moduleVersion: process.env.COMMIT_SHA || null,
              timestamp: new Date()
            });
          } catch (e) { logger2.warn('Failed to persist retry decision event', e); }

          if (action === 'reduce') {
            currentAmount = Math.max(1, Math.floor(currentAmount * 0.75));
          } else if (action === 'switch_venue') {
            // mark current venue unhealthy and attempt to failover
            this.venueRouter.markFailure(currentVenue, 20);
            const next = this.venueRouter.getNextVenue(currentVenue);
            if (next) {
              logger2.info(`Failover: switching to next venue ${next.id}`);
              const switched = await this.switchVenue(next.id);
              if (switched) {
                currentVenue = next.id;
                // reset attempt counter to allow new venue attempts
                attempt = 0;
                currentAmount = amount; // reset amount to original on new venue
                continue; // try placement again on new venue
              } else {
                logger2.warn(`Failover: switch to ${next.id} unsuccessful`);
              }
            }
          } else if (action === 'abort') {
            throw err;
          }

          if (!this.retryPolicy.shouldRetry(attempt)) {
            throw err;
          }

          const waitMs = this.retryPolicy.nextDelayMs(attempt);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }

      if (!order) {
        throw lastError || new Error('Order placement failed without exception');
      }

      // If shadow fidelity enabled, apply slippage and simulate partial fills
      if (enableShadow) {
        try {
          // determine execution price
          let execPrice = order.price || signal.price || 0;
          if ((!execPrice || execPrice <= 0) && this.exchange && typeof (this.exchange as any).fetchTicker === 'function') {
            try {
              const tk: any = await (this.exchange as any).fetchTicker(signal.symbol);
              execPrice = Number(tk && (tk.last || tk.close) ? (tk.last || tk.close) : execPrice) || execPrice;
            } catch (_) {}
          }

          const adjustedPrice = this.slippageModel.applySlippage(execPrice || 0, currentAmount, undefined, signal.type.toLowerCase() as 'buy' | 'sell');
          const fills = this.partialFillSim.simulateProgressiveFills(Math.ceil(currentAmount), 5);
          const totalFilled = fills.reduce((s, f) => s + f, 0);

          order.filled = totalFilled;
          order.remaining = Math.max(0, currentAmount - totalFilled);
          order.cost = totalFilled * adjustedPrice;
          order.price = adjustedPrice;
          order.status = order.filled >= currentAmount ? 'closed' : 'open';
        } catch (simErr) {
          const logger2 = new ModuleLogger('LiveTrading');
          logger2.warn('Shadow fidelity simulation failed', simErr);
        }
      }

      const liveOrder: LiveOrder = {
        id: typeof randomUUID === 'function' ? randomUUID() : `order-${Date.now()}`,
        exchangeOrderId: order.id,
        symbol: signal.symbol,
        side: signal.type.toLowerCase() as 'buy' | 'sell',
        type: 'market',
        amount: currentAmount,
        status: order.status as any,
        filled: order.filled || 0,
        remaining: order.remaining || currentAmount,
        cost: order.cost || 0,
        fee: order.fee ? {
          cost: typeof order.fee.cost === 'number' ? order.fee.cost : Number(order.fee.cost) || 0,
          currency: String(order.fee.currency || 'USDT')
        } : undefined,
        timestamp: order.timestamp || Date.now(),
        signalId: signal.id
      };

      // Persist trade provenance
      try {
        const provenance = {
          tradeId: liveOrder.exchangeOrderId || liveOrder.id,
          engine: 'LIVE',
          symbol: liveOrder.symbol,
          signalId: signal.id ?? null,
          correlationId: (signal as any).correlationId ?? null,
          signal: {
            id: signal.id,
            timestamp: signal.timestamp,
            symbol: signal.symbol,
            type: signal.type,
            confidence: signal.confidence,
            price: signal.price,
            reasoning: signal.reasoning
          },
          consensus: (typeof (portfolioRiskManager as any).getPositionSizingConsensus === 'function') ? undefined : undefined,
          agentDecision: (global as any).rlPositionAgent ? (await (global as any).rlPositionAgent.getFullDecision(signal)).sizing : undefined,
          execution: {
            orderId: liveOrder.exchangeOrderId,
            amount: liveOrder.amount,
            cost: liveOrder.cost,
            fee: liveOrder.fee
          },
          extra: {
            env: process.env.NODE_ENV || 'development',
            host: process.env.HOSTNAME || null
          }
        };

        try { await db.createTradeProvenance(provenance); } catch (e) { logger.warn('Failed to persist trade provenance', e); }
      } catch (e) {
        logger.warn('Provenance capture failed', e);
      }
      // Persist order audit record (execution provenance)
      let orderAuditRecord: any = null;
      try {
        const preBalances = { accountBalanceUsd: accountBalance };
        const audit = {
          traceId: (signal as any).correlationId ?? null,
          orderId: liveOrder.exchangeOrderId || liveOrder.id,
          exchange: this.config.exchange,
          venue: currentVenue,
          params: { type: 'market', amount: currentAmount },
          preBalances,
          reservationAmounts: reservationTokens ?? [],
          fills: [],
          simulatedSlippage: null,
          realSlippage: null,
          realizedPnl: null,
        };
        try { orderAuditRecord = await db.createOrderAudit(audit); } catch (e) { logger.warn('Failed to persist order audit', e); }
      } catch (e) {
        logger.warn('Order audit capture failed', e);
      }
      // Hold reservation until child orders (SL/TP) are placed; commit/release as a unit
      reservationTokens = [];
      if (reservationToken) reservationTokens.push(reservationToken);
      // Register position with portfolio manager (best-effort)
      try {
        const avgPrice = (liveOrder.cost || 0) / Math.max(1, liveOrder.filled || amount);
        const sizeUsd = (avgPrice || signal.price || 0) * amount;
        portfolioRiskManager.addPosition({
          symbol: liveOrder.symbol,
          side: liveOrder.side === 'buy' ? 'BUY' : 'SELL',
          size: sizeUsd,
          entryPrice: avgPrice || signal.price || 0,
          currentPrice: avgPrice || signal.price || 0,
          pnl: 0,
          pnlPercent: 0
        });
      } catch (pmErr) {
        logger.warn('Failed to add position to PortfolioRiskManager', pmErr);
      }
      this.orders.set(liveOrder.id, liveOrder);
      this.emit('orderPlaced', liveOrder);

      // Detect potential self-influencing trades (feedback loop) and tag audit
      try {
        const executedPrice = liveOrder.price || signal.price || 0;
        const tradeUsd = (liveOrder.amount || 0) * executedPrice;
        const feedbackThresholdUsd = Number(process.env.FEEDBACK_THRESHOLD_USD) || (accountBalance * 0.05);
        if (tradeUsd >= feedbackThresholdUsd) {
          try {
            await db.createDecisionEvent({
              correlationId: (signal as any).correlationId ?? null,
              phase: 'FEEDBACK_LOOP_DETECTION',
              domain: 'ExecutionEngine',
              actionPayload: { tradeUsd, threshold: feedbackThresholdUsd },
              metrics: { tradeUsd, accountBalance },
              agentIds: ['ExecutionEngine'],
              moduleVersion: process.env.COMMIT_SHA ?? null,
              timestamp: new Date()
            });
            await db.updateOrderAudit(liveOrder.exchangeOrderId || liveOrder.id, { extra: { selfInfluencing: true } });
          } catch (e) { logger.warn('Failed to mark trace as self-influencing', e); }
        }
      } catch (e) { logger.warn('Feedback detection error', e); }

      // record a fill placeholder (actual fill recorded in checkOrders when closed)
      try { executionMetrics.recordFill(signal.symbol, liveOrder.filled); } catch (e) {}

      // success -> reset circuit breaker
      this.consecutiveFailures = 0;

      // Place stop-loss and take-profit orders; collect any extra reservations for multi-leg orders
      let childPlacementOk = true;
      try {
        if (signal.stopLoss) {
          const ok = await this.placeStopLoss(signal.symbol, signal.type, amount, signal.stopLoss, reservationTokens, signal.symbol);
          if (!ok) childPlacementOk = false;
        }
        if (signal.takeProfit) {
          const ok = await this.placeTakeProfit(signal.symbol, signal.type, amount, signal.takeProfit, reservationTokens, signal.symbol);
          if (!ok) childPlacementOk = false;
        }
      } catch (childErr) {
        logger.warn('Child order placement error', childErr);
        childPlacementOk = false;
      }

      // Commit or release all reservations based on child placements
      try {
        if (childPlacementOk) {
          for (const t of reservationTokens) {
            try { portfolioRiskManager.commitReservation(t); } catch (e) { logger.warn('Failed to commit reservation', e); }
          }
        } else {
          for (const t of reservationTokens) {
            try { portfolioRiskManager.releaseReservation(t); } catch (e) { logger.warn('Failed to release reservation', e); }
          }
        }
      } catch (e) {
        logger.warn('Reservation finalization error', e);
      }

      logger.info(`Order placed: ${signal.type} ${amount.toFixed(4)} ${signal.symbol} @ market (signal confidence: ${(signal.confidence * 100).toFixed(0)}%)`);

      // ✅ RL CALLBACK: Register trade with RL system for learning
      try {
        const frames = await db.getMarketFrames(signal.symbol, 20) || [];
        RLFeedbackCallbacks.onTradeOpen({
          tradeId: liveOrder.id,
          symbol: signal.symbol,
          side: signal.type === 'BUY' ? 'BUY' : 'SELL',
          entryPrice: (liveOrder.cost || 0) / (liveOrder.filled || 1),
          entryTime: new Date(),
          quantity: liveOrder.filled,
          frames: frames as any,
          mlConfidence: signal.confidence || 0.5,
          source: 'LIVE'
        });
      } catch (rlError) {
        logger.warn('RL onTradeOpen callback error', rlError);
      }

      return liveOrder;
    } catch (error: any) {
      logger.error('Order execution failed', error);
      this.emit('orderError', { signal, error: error.message });

      // release reservation on failure
      try {
        if (reservationTokens && reservationTokens.length > 0) {
          for (const t of reservationTokens) {
            try { portfolioRiskManager.releaseReservation(t); } catch (e) { logger.warn('Failed to release reservation after error', e); }
          }
        } else if (typeof reservationTokens === 'string' && reservationTokens) {
          portfolioRiskManager.releaseReservation(reservationTokens);
        }
      } catch (e) {
        logger.warn('Failed to release reservation after error', e);
      }

      // circuit breaker: increment and possibly pause
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
        this.config.enabled = false;
        this.emit('pausedByCircuitBreaker', { threshold: this.circuitBreakerThreshold });
        logger.warn('Pausing execution due to repeated failures');
      }

      return null;
    }
  }

  /**
   * Place stop-loss order
   */
  private async placeStopLoss(symbol: string, side: string, amount: number, stopPrice: number, reservationTokens?: string[], parentSymbol?: string): Promise<boolean> {
    if (!this.exchange) return false;

    const logger = new ModuleLogger('LiveTrading');
    let extraToken: string | null = null;
    try {
      // If this stop-loss is on a different symbol (multi-leg), reserve capital for that leg.
      // Estimate required USD exposure as price * amount (with optional buffer) and reserve via PortfolioRiskManager.
      if (parentSymbol && parentSymbol !== symbol) {
        // determine reference price: prefer explicit stopPrice, otherwise try ticker
        let refPrice = typeof stopPrice === 'number' && stopPrice > 0 ? stopPrice : 0;
        if ((!refPrice || refPrice <= 0) && this.exchange && typeof (this.exchange as any).fetchTicker === 'function') {
          try {
            const tk: any = await (this.exchange as any).fetchTicker(symbol);
            if (tk && (tk.last || tk.close || tk.price)) {
              refPrice = Number(tk.last || tk.close || tk.price) || refPrice;
            }
          } catch (_) {
            // ignore ticker fetch failure; we'll fall back to zero and let reserveCapital handle it
          }
        }

        const bufferPct = Number(process.env.CHILD_RESERVATION_BUFFER_PCT) || 2; // percent
        const multiplier = 1 + bufferPct / 100;
        const estimatedUsd = Math.abs(amount) * (refPrice || 0) * multiplier;

        if (estimatedUsd > 0) {
          try {
            extraToken = portfolioRiskManager.reserveCapital(estimatedUsd, `child-leg:${symbol}`);
            if (extraToken && reservationTokens) reservationTokens.push(extraToken);
            // if caller did not provide reservationTokens, commit immediately (we'll release on error below)
            if (!reservationTokens && extraToken) {
              try { portfolioRiskManager.commitReservation(extraToken); } catch (_) {}
            }
          } catch (resErr) {
            logger.warn('Failed to reserve capital for child stop-loss leg', resErr);
            // if we cannot reserve for the child leg, fail-safe: do not place the child order
            return false;
          }
        }
      }

      const stopSide = side === 'BUY' ? 'sell' : 'buy';
      await this.exchange.createOrder(
        symbol,
        'stop',
        stopSide,
        amount,
        undefined,
        { stopPrice }
      );
      logger.info(`Stop-loss placed at $${stopPrice.toFixed(2)}`);
      if (extraToken && reservationTokens && !reservationTokens.includes(extraToken)) reservationTokens.push(extraToken);
      return true;
    } catch (error) {
      logger.error('Failed to place stop-loss', error);
      // release any extra reservation we may have created immediately
      if (extraToken) {
        try { portfolioRiskManager.releaseReservation(extraToken); } catch (_) {}
      }
      return false;
    }
  }

  /**
   * Place take-profit order
   */
  private async placeTakeProfit(symbol: string, side: string, amount: number, tpPrice: number, reservationTokens?: string[], parentSymbol?: string): Promise<boolean> {
    if (!this.exchange) return false;

    const logger = new ModuleLogger('LiveTrading');
    let extraToken: string | null = null;
    try {
      // If this TP leg is on a different symbol (multi-leg), reserve capital for that leg.
      if (parentSymbol && parentSymbol !== symbol) {
        let refPrice = typeof tpPrice === 'number' && tpPrice > 0 ? tpPrice : 0;
        if ((!refPrice || refPrice <= 0) && this.exchange && typeof (this.exchange as any).fetchTicker === 'function') {
          try {
            const tk: any = await (this.exchange as any).fetchTicker(symbol);
            if (tk && (tk.last || tk.close || tk.price)) {
              refPrice = Number(tk.last || tk.close || tk.price) || refPrice;
            }
          } catch (_) {}
        }

        const bufferPct = Number(process.env.CHILD_RESERVATION_BUFFER_PCT) || 2; // percent
        const multiplier = 1 + bufferPct / 100;
        const estimatedUsd = Math.abs(amount) * (refPrice || 0) * multiplier;

        if (estimatedUsd > 0) {
          try {
            extraToken = portfolioRiskManager.reserveCapital(estimatedUsd, `child-leg:${symbol}`);
            if (extraToken && reservationTokens) reservationTokens.push(extraToken);
            if (!reservationTokens && extraToken) {
              try { portfolioRiskManager.commitReservation(extraToken); } catch (_) {}
            }
          } catch (resErr) {
            logger.warn('Failed to reserve capital for child take-profit leg', resErr);
            return false;
          }
        }
      }

      const tpSide = side === 'BUY' ? 'sell' : 'buy';
      await this.exchange.createOrder(
        symbol,
        'limit',
        tpSide,
        amount,
        tpPrice
      );
      logger.info(`Take-profit placed at $${tpPrice.toFixed(2)}`);
      if (extraToken && reservationTokens && !reservationTokens.includes(extraToken)) reservationTokens.push(extraToken);
      return true;
    } catch (error) {
      logger.error('Failed to place take-profit', error);
      if (extraToken) {
        try { portfolioRiskManager.releaseReservation(extraToken); } catch (_) {}
      }
      return false;
    }
  }

  /**
   * Update positions with current prices
   */
  private async updatePositions(): Promise<void> {
    if (!this.exchange) return;

    try {
      const positions = await this.exchange.fetchPositions();
      
      for (const pos of positions) {
        if (Math.abs(pos.contracts || 0) > 0) {
          const livePos: LivePosition = {
            id: `${pos.symbol}-${pos.timestamp}`,
            symbol: pos.symbol,
            side: (pos.side as 'long' | 'short') || 'long',
            entryPrice: pos.entryPrice || 0,
            currentPrice: pos.markPrice || 0,
            quantity: Math.abs(pos.contracts || 0),
            leverage: pos.leverage || 1,
            pnl: pos.unrealizedPnl || 0,
            pnlPercent: pos.percentage || 0,
            stopLoss: undefined,
            takeProfit: undefined,
            openTime: pos.timestamp || Date.now(),
            marginUsed: pos.initialMargin || 0,
            liquidationPrice: pos.liquidationPrice,
            orders: []
          };

          this.positions.set(livePos.id, livePos);

          // Update portfolio risk manager with latest price
          try {
            portfolioRiskManager.updatePositionPrice(livePos.symbol, livePos.currentPrice);
          } catch (pmErr) {
            new ModuleLogger('LiveTrading').warn('Failed to update PortfolioRiskManager position price', pmErr);
          }
          // RL CALLBACK: Track live position metrics (MFE/MAE on every update)
          try {
            RLFeedbackCallbacks.onTradeTick(livePos.id, pos.markPrice || 0);
          } catch (rlError) {
            new ModuleLogger('LiveTrading').warn(`RL onTradeTick callback error: ${rlError}`);
          }
        }
      }

      this.emit('positionsUpdated', Array.from(this.positions.values()));
    } catch (error) {
      new ModuleLogger('LiveTrading').error('Failed to update positions', error);
    }
  }

  /**
   * Check order status
   */
  private async checkOrders(): Promise<void> {
    if (!this.exchange) return;

    for (const [orderId, order] of this.orders.entries()) {
      if (order.status === 'open' || order.status === 'pending') {
        try {
          const updated = await this.exchange.fetchOrder(order.exchangeOrderId, order.symbol);
          
          if (updated.status !== order.status) {
            order.status = updated.status as any;
            order.filled = updated.filled || 0;
            order.remaining = updated.remaining || 0;
            order.cost = updated.cost || 0;

            this.emit('orderUpdated', order);
            
            if (order.status === 'closed') {
              const info = `${order.side} ${order.filled.toFixed(4)} ${order.symbol} @ $${(order.cost / order.filled).toFixed(2)}`;
              new ModuleLogger('LiveTrading').info(`Order filled: ${info}`);
              // record execution metrics
              try {
                const avgPrice = (order.cost || 0) / Math.max(1, order.filled || 1);
                // slippage is unknown here; record 0 as placeholder
                executionMetrics.recordFill(order.symbol, order.filled || 0);
                executionMetrics.recordSlippage(order.symbol, 0);
                // Update portfolio risk manager price for this symbol
                try {
                  portfolioRiskManager.updatePositionPrice(order.symbol, avgPrice);
                } catch (pmErr) {
                  new ModuleLogger('LiveTrading').warn('Failed to update PortfolioRiskManager after order fill', pmErr);
                }
                // Update order audit with fills and realized pnl if available
                try {
                  const fills = [{ filled: order.filled, cost: order.cost, avgPrice }];
                  const realizedPnl = null; // compute later with position info
                  await db.updateOrderAudit(order.exchangeOrderId || order.id, { fills, realSlippage: 0, realizedPnl });
                } catch (e) {
                  new ModuleLogger('LiveTrading').warn('Failed to update order audit after fill', e);
                }
              } catch (e) {}
            }
          }
        } catch (error) {
          // Order might be cancelled or expired
          console.warn(`[Live Trading] Could not fetch order ${order.exchangeOrderId}`);
        }
      }
    }
  }

  /**
   * Close a position
   */
  async closePosition(positionId: string): Promise<boolean> {
    const position = this.positions.get(positionId);
    if (!position || !this.exchange) return false;

    try {
      const side = position.side === 'long' ? 'sell' : 'buy';
      await this.exchange.createOrder(
        position.symbol,
        'market',
        side,
        position.quantity
      );

      this.positions.delete(positionId);
      this.emit('positionClosed', position);

      // Remove from portfolio risk manager
      try {
        portfolioRiskManager.removePosition(position.symbol);
      } catch (pmErr) {
        console.warn('[Live Trading] Failed to remove position from PortfolioRiskManager', pmErr);
      }
      //  RL CALLBACK: Calculate rewards and trigger learning
      try {
        RLFeedbackCallbacks.onTradeClose(positionId, {
          exitPrice: position.currentPrice,
          exitTime: new Date(),
          exitReason: 'MANUAL',
          pnl: position.pnl,
          pnlPercent: position.pnlPercent,
          maxProfit: 0,
          maxLoss: 0
        });
      } catch (rlError) {
        console.warn(`[Live Trading] RL onTradeClose callback error: ${rlError}`);
      }
      
      console.log(`[Live Trading] Position closed: ${position.symbol}`);
      return true;
    } catch (error) {
      const fe = formatError(error);
      console.error('[Live Trading] Failed to close position:', fe.message, { stack: fe.stack });
      return false;
    }
  }

  /**
   * Get total exposure across all positions
   */
  private getTotalExposure(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      total += position.marginUsed;
    }
    return total;
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      exchange: this.config.exchange,
      testMode: this.config.testMode,
      positions: Array.from(this.positions.values()),
      openOrders: Array.from(this.orders.values()).filter(o => o.status === 'open'),
      totalExposure: this.getTotalExposure(),
      config: this.config
    };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<ExecutionConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('configUpdated', this.config);
  }

  getDiagnostics() {
    return {
      ...this.getStatus(),
      consecutiveFailures: this.consecutiveFailures,
      circuitBreakerThreshold: this.circuitBreakerThreshold,
      rlPositionAgentConnected: !!(global as any).rlPositionAgent,
      uptimeSec: Math.floor(process.uptime())
    };
  }

  pause() {
    this.config.enabled = false;
    this.isRunning = false;
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    this.emit('paused');
  }

  resume() {
    if (!this.isRunning) this.start().catch(() => {});
    this.emit('resumed');
  }
}

// Singleton instance (disabled by default for safety)
export const liveTradingEngine = new LiveTradingEngine({
  enabled: false,
  testMode: true
});
