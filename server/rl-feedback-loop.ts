/**
 * RL Feedback Loop — Trade Lifecycle Manager
 *
 * Bridges closed trade outcomes → RLPositionAgent Q-table updates
 * across all 5 decision domains:
 *
 *   POSITION_SIZING   → was the size/SL/TP correct for this state?
 *   ENTRY_TIMING      → did waiting/limit order improve the fill?
 *   SOURCE_WEIGHTING  → did the weighted consensus actually predict the outcome?
 *   EXIT_SEQUENCING   → how much of the available move did we capture?
 *   CLUSTER_THRESHOLD → was the cluster gate calibrated correctly?
 *
 * Flow:
 *   1. onTradeOpen()   — snapshot entry state + all domain actions taken
 *   2. onTradeTick()   — track MFE/MAE + running PnL each bar
 *   3. onTradeClose()  — calculate all domain rewards → update Q-tables → replay
 */

import {
  RLPositionAgent,
  RLState,
  RLAction,
  DomainExperience,
  RLDecisionDomain,
  EntryTimingAction,
  SourceWeightAction,
  ExitSequenceAction,
  ClusterThresholdAction,
  PositionSizingAction,
} from './rl-position-agent';
import { rlGuard } from './rl-guard';
import { recordEpisode, recordDomainReward, metricsEnabled as rlMetricsEnabled } from './rl-metrics';

// Module defaults for functions that run outside class instance
const DEFAULT_SLIPPAGE_MULTIPLIER = 50;

// ─── Types ────────────────────────────────────────────────────────────────────

export type TradeDirection = 'BUY' | 'SELL';
export type ExitReason = 'TP_HIT' | 'SL_HIT' | 'CLUSTER_BREAKDOWN' | 'MICROSTRUCTURE' | 'TIME_LIMIT' | 'MANUAL';

/**
 * Snapshot taken at trade open — everything the RL agent decided
 */
export interface TradeOpenSnapshot {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;

  // Market state at entry
  entryState: RLState;

  // Prices
  signalPrice: number;      // Price when signal fired
  entryFillPrice: number;   // Actual fill (may differ due to limit/wait)
  entryTime: number;        // Unix ms

  // RL decisions made at entry (one per domain)
  domainActions: {
    positionSizing:    PositionSizingAction;
    entryTiming:       EntryTimingAction;
    sourceWeights:     SourceWeightAction;
    exitSequence:      ExitSequenceAction;
    clusterThreshold:  ClusterThresholdAction;
  };

  // Context needed for domain reward calculation
  consensusScoreAtEntry: number;   // 0-1 weighted consensus score
  clusterPassedGate: boolean;      // Did signal pass cluster threshold?
  basePositionSize: number;        // Kelly base before RL multiplier
  atr: number;
}

/**
 * Updated each bar while trade is open
 */
export interface TradeLiveMetrics {
  currentPrice: number;
  currentTime: number;
  runningPnlPct: number;  // +/- %
  mfe: number;            // Max Favorable Excursion (best price reached)
  mae: number;            // Max Adverse Excursion (worst price reached)
}

/**
 * Final record after trade closes
 */
export interface TradeCloseRecord {
  exitPrice: number;
  exitTime: number;
  exitReason: ExitReason;

  pnlDollars: number;
  pnlPercent: number;

  mfe: number;   // Best unrealised profit reached (absolute price)
  mae: number;   // Worst unrealised loss reached (absolute price)

  maxPossiblePnlPct: number;  // PnL if exited exactly at MFE
  riskRewardAchieved: number; // actual RR vs planned
  holdingBars: number;

  // Exit-specific context
  clusterStrengthAtExit?: number;  // for EXIT_SEQUENCING capture ratio
}

/**
 * Full trade record stored in memory until feedback is delivered
 */
interface PendingTrade {
  open: TradeOpenSnapshot;
  live: TradeLiveMetrics;
  feedbackDelivered: boolean;
}

// ─── Reward calculators (per domain) ─────────────────────────────────────────

function rewardPositionSizing(
  open: TradeOpenSnapshot,
  close: TradeCloseRecord,
  action: PositionSizingAction
): number {
  let r = 0;

  // Primary: PnL scaled
  r += close.pnlPercent * 10;

  // RR quality bonus
  if (close.riskRewardAchieved >= 2.0) r += 5;
  else if (close.riskRewardAchieved >= 1.5) r += 2;
  else r -= 2;

  // Drawdown penalty
  const maePct = open.direction === 'BUY'
    ? (open.entryFillPrice - close.mae) / open.entryFillPrice
    : (close.mae - open.entryFillPrice) / open.entryFillPrice;
  if (maePct > 0.05) r -= 10;
  else if (maePct > 0.03) r -= 5;

  // Efficiency penalty for over-sized SL that was never needed
  const slWasted = action.stopLossMultiplier > 2.5 && close.exitReason === 'TP_HIT';
  if (slWasted) r -= 1; // held capital hostage unnecessarily

  // Holding efficiency
  if (close.holdingBars > 100) r -= 2;

  return Math.max(-10, Math.min(10, r));
}

function rewardEntryTiming(
  open: TradeOpenSnapshot,
  close: TradeCloseRecord
): number {
  // Slippage cost: how far fill was from signal price
  const slippagePct = Math.abs(open.entryFillPrice - open.signalPrice) / open.signalPrice;
  // scale slippage relative to ATR if available to avoid punishing micro-slippage on low-vol assets
  const relativeAtr = open.atr && open.entryFillPrice > 0 ? (open.atr / open.entryFillPrice) : 0;
  const atrScale = relativeAtr > 0 ? Math.max(0.001, relativeAtr) : 0.001;
  const slippagePenalty = -Math.min(20, (slippagePct / atrScale) * DEFAULT_SLIPPAGE_MULTIPLIER);

  // Did the trade win?
  const pnlBonus = close.pnlPercent > 0 ? +2 : -2;

  // Limit order bonus: if we waited and got a better fill than market
  const gotBetterFill = open.domainActions.entryTiming.entryType === 'LIMIT' &&
    ((open.direction === 'BUY' && open.entryFillPrice < open.signalPrice) ||
     (open.direction === 'SELL' && open.entryFillPrice > open.signalPrice));
  const limitBonus = gotBetterFill ? +1.5 : 0;

  // Penalty if we waited (waitBars > 0) and missed the move (trade never opened)
  // Not applicable here since we only call this on closed trades

  return Math.max(-10, Math.min(10, slippagePenalty + pnlBonus + limitBonus));
}

function rewardSourceWeighting(
  open: TradeOpenSnapshot,
  close: TradeCloseRecord
): number {
  const score = open.consensusScoreAtEntry;
  const won = close.pnlPercent > 0;

  // Correct prediction bonus
  const correctHigh   = score > 0.70 && won;   // confident + won
  const correctLow    = score < 0.45 && !won;  // uncertain + lost (well calibrated)
  const wrongHigh     = score > 0.70 && !won;  // overconfident
  const wrongLow      = score < 0.45 && won;   // underconfident (missed conviction)

  if (correctHigh)  return +4;
  if (correctLow)   return +2;
  if (wrongHigh)    return -5; // most expensive error
  if (wrongLow)     return -1;
  return 0; // neutral zone
}

function rewardExitSequencing(
  close: TradeCloseRecord
): number {
  // Capture ratio: what % of the max available move did we actually capture?
  const captureRatio = close.maxPossiblePnlPct > 0
    ? Math.min(1, close.pnlPercent / close.maxPossiblePnlPct)
    : 0;

  // Scale: 0% capture = -5, 50% = 0, 100% = +5
  const baseReward = (captureRatio - 0.5) * 10;

  // Bonus for exiting before a reversal (SL not hit, but exited proactively)
  const proactiveExitBonus = close.exitReason !== 'SL_HIT' && close.pnlPercent > 0 ? +1 : 0;

  return Math.max(-5, Math.min(5, baseReward + proactiveExitBonus));
}

function rewardClusterThreshold(
  open: TradeOpenSnapshot,
  close: TradeCloseRecord
): number {
  const passed = open.clusterPassedGate;
  const won    = close.pnlPercent > 0;

  // Correct pass: gate let through a winner     → +4
  // False positive: gate let through a loser    → -6 (expensive)
  // False negative: gate blocked a winner       → -2 (opportunity cost)
  // Correct block: gate blocked a loser         → +1
  if (passed && won)   return +4;
  if (passed && !won)  return -6;
  if (!passed && won)  return -2;
  return +1;
}

// ─── Next-state builder ───────────────────────────────────────────────────────

function buildNextState(entryState: RLState, close: TradeCloseRecord, currentMarketState?: Partial<RLState>): RLState {
  // Approximate the state after this trade completes
  // Drawdown shifts based on outcome
  const base = currentMarketState ? { ...entryState, ...currentMarketState } : { ...entryState };
  const newDrawdown = close.pnlPercent < 0
    ? Math.min(1, base.drawdown + Math.abs(close.pnlPercent) / 100)
    : Math.max(0, base.drawdown - close.pnlPercent / 200);

  // Loss streak estimate
  const currentLossStreak = entryState.lossStreak ?? 0;
  const newLossStreak = close.pnlPercent < 0
    ? currentLossStreak + 1
    : 0;

  // Equity slope shifts
  const currentSlope = base.equitySlope ?? 0;
  const newSlope = Math.max(-1, Math.min(1,
    currentSlope * 0.8 + (close.pnlPercent > 0 ? 0.2 : -0.2)
  ));

  return {
    ...base,
    drawdown:    newDrawdown,
    lossStreak:  newLossStreak,
    equitySlope: newSlope,
    // regime, volatility, trend etc are market facts — carry forward from entry
    // (in production you'd pass fresh state here, but for Q-update the approximation is fine)
  };
}

// ─── TradeLifecycleManager ────────────────────────────────────────────────────

export class TradeLifecycleManager {
  private pendingTrades: Map<string, PendingTrade> = new Map();
  private totalClosedTrades = 0;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly config = {
    rewardClamp: [-10, 10] as const,
    replayFrequency: 32,
    maxPendingAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    slippageMultiplier: 50,
    slippageUseAtr: true,
    cleanupIntervalMs: 60 * 60 * 1000, // hourly cleanup
  } as const;

  constructor(private readonly rlAgent: RLPositionAgent, opts?: { logger?: any; config?: Partial<any> }) {
    if (opts?.logger) {
      // replace console logging if provided
      (this as any).logger = opts.logger;
    }
    if (opts?.config) {
      Object.assign((this as any).config, opts.config);
    }

    // Periodic cleanup to prevent memory leaks from stuck trades
    this.cleanupTimer = setInterval(() => this.cleanupPendingTrades(), this.config.cleanupIntervalMs);
  }

  // ── 1. Called when a trade opens ─────────────────────────────────────────

  onTradeOpen(snapshot: TradeOpenSnapshot): void {
    if (this.pendingTrades.has(snapshot.tradeId)) {
      console.warn(`[RLFeedback] onTradeOpen called twice for ${snapshot.tradeId}`);
      return;
    }

    this.pendingTrades.set(snapshot.tradeId, {
      open: snapshot,
      live: {
        currentPrice:   snapshot.entryFillPrice,
        currentTime:    snapshot.entryTime,
        runningPnlPct:  0,
        mfe:            snapshot.entryFillPrice,
        mae:            snapshot.entryFillPrice,
      },
      feedbackDelivered: false,
    });

    console.log(`[RLFeedback] Trade opened: ${snapshot.tradeId} | ${snapshot.symbol} ${snapshot.direction} @ ${snapshot.entryFillPrice}`);
  }

  // ── 2. Called each bar while trade is open ────────────────────────────────

  onTradeTick(tradeId: string, currentPrice: number, currentTime: number): void {
    const trade = this.pendingTrades.get(tradeId);
    if (!trade) return;

    const { open, live } = trade;
    const isBuy = open.direction === 'BUY';

    // Running PnL %
    const pnlPct = isBuy
      ? (currentPrice - open.entryFillPrice) / open.entryFillPrice * 100
      : (open.entryFillPrice - currentPrice) / open.entryFillPrice * 100;

    // MFE: best price reached
    const mfe = isBuy
      ? Math.max(live.mfe, currentPrice)
      : Math.min(live.mfe, currentPrice);

    // MAE: worst price reached
    const mae = isBuy
      ? Math.min(live.mae, currentPrice)
      : Math.max(live.mae, currentPrice);

    trade.live = { currentPrice, currentTime, runningPnlPct: pnlPct, mfe, mae };
  }

  // ── 3. Called when trade closes — triggers all RL updates ─────────────────

  onTradeClose(tradeId: string, record: TradeCloseRecord): void {
    const trade = this.pendingTrades.get(tradeId);
    if (!trade) {
      console.error(`[RLFeedback] onTradeClose: no pending trade found for ${tradeId}`);
      return;
    }

    if (trade.feedbackDelivered) {
      console.warn(`[RLFeedback] feedback already delivered for ${tradeId}`);
      return;
    }

    const { open } = trade;
    // validate record
    if (typeof record.exitPrice !== 'number' || typeof record.pnlPercent !== 'number') {
      console.error(`[RLFeedback] onTradeClose: invalid close record for ${tradeId}`, record);
      // still evict to prevent leaks
      this.pendingTrades.delete(tradeId);
      return;
    }

    const nextState = buildNextState(open.entryState, record, undefined);

    // Derive maxPossiblePnlPct from live MFE if not provided
    if (!record.maxPossiblePnlPct) {
      const isBuy = open.direction === 'BUY';
      record.maxPossiblePnlPct = isBuy
        ? (trade.live.mfe - open.entryFillPrice) / open.entryFillPrice * 100
        : (open.entryFillPrice - trade.live.mae) / open.entryFillPrice * 100;
    }

    // ── Update each domain ──────────────────────────────────────────────────

    // Compute per-domain rewards so we can emit metrics alongside learning updates
    const r_positionSizing = rewardPositionSizing(open, record, open.domainActions.positionSizing);
    const r_entryTiming = rewardEntryTiming(open, record);
    const r_sourceWeighting = rewardSourceWeighting(open, record);
    const r_exitSequencing = rewardExitSequencing(record);
    const r_clusterThreshold = rewardClusterThreshold(open, record);

    this.updateDomain('POSITION_SIZING', open.entryState, nextState, open.domainActions.positionSizing, r_positionSizing, record);
    this.updateDomain('ENTRY_TIMING', open.entryState, nextState, open.domainActions.entryTiming, r_entryTiming, record);
    this.updateDomain('SOURCE_WEIGHTING', open.entryState, nextState, open.domainActions.sourceWeights, r_sourceWeighting, record);
    this.updateDomain('EXIT_SEQUENCING', open.entryState, nextState, open.domainActions.exitSequence, r_exitSequencing, record);
    this.updateDomain('CLUSTER_THRESHOLD', open.entryState, nextState, open.domainActions.clusterThreshold, r_clusterThreshold, record);

    // Emit RL metrics (best-effort)
    try {
      const totalDomainReward = r_positionSizing + r_entryTiming + r_sourceWeighting + r_exitSequencing + r_clusterThreshold;
      // Record reward into RL guard so it can decide whether learning should be frozen
      try { rlGuard.recordReward(totalDomainReward, { regime: nextState.regime, drawdown: nextState.drawdown }); } catch (e) { /* ignore */ }
      const outcome = record.pnlPercent > 0 ? 'win' : (record.pnlPercent < 0 ? 'loss' : 'neutral');
      if (rlMetricsEnabled()) {
        recordDomainReward('POSITION_SIZING', r_positionSizing);
        recordDomainReward('ENTRY_TIMING', r_entryTiming);
        recordDomainReward('SOURCE_WEIGHTING', r_sourceWeighting);
        recordDomainReward('EXIT_SEQUENCING', r_exitSequencing);
        recordDomainReward('CLUSTER_THRESHOLD', r_clusterThreshold);
        recordEpisode(outcome as 'win' | 'loss' | 'neutral', totalDomainReward, record.holdingBars || 0);
      }
    } catch (metricErr) {
      // swallow metric errors
    }

    this.totalClosedTrades++;

    // ── Trigger replay every 32 trades ─────────────────────────────────────

    if (this.totalClosedTrades % 32 === 0) {
      this.replayAllDomains();
    }

    trade.feedbackDelivered = true;

    this.logOutcome(open, record);

    // Evict from memory once feedback is done
      this.pendingTrades.delete(tradeId);
  }

    /** Periodic cleanup to evict very old pending trades to avoid memory leaks */
    private cleanupPendingTrades(): void {
      const now = Date.now();
      const maxAge = (this as any).config?.maxPendingAgeMs ?? 7 * 24 * 60 * 60 * 1000;
      for (const [id, t] of this.pendingTrades.entries()) {
        const age = now - (t.open.entryTime ?? now);
        if (age > maxAge) {
          console.warn(`[RLFeedback] Evicting aged pending trade ${id} (ageMs=${age})`);
          this.pendingTrades.delete(id);
        }
      }
    }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private updateDomain(
    domain: RLDecisionDomain,
    entryState: RLState,
    nextState: RLState,
    domainAction: RLAction,
    reward: number,
    record: TradeCloseRecord
  ): void {
    const exp: DomainExperience = {
      domain,
      state:        entryState,
      nextState,
      action:       domainAction as any,  // the actual domain action (legacy field kept for compat)
      domainAction,
      reward:       Math.max(this.config.rewardClamp[0], Math.min(this.config.rewardClamp[1], reward)), // clamp by config
      done:         true,
    };

    // Check RL guard before updating Q-tables. If frozen, skip learning and emit a diagnostic event.
    try {
      if (rlGuard && rlGuard.isFrozen && rlGuard.isFrozen()) {
        // best-effort event emission for observability
        try {
          const phase5 = require('./services/phase5-event-bridge').phase5EventBridge;
          if (phase5 && typeof phase5.emit === 'function') {
            phase5.emit('rl.guard.blocked', { domain, reward: exp.reward, samples: (rlGuard as any).sampleCount, variance: (rlGuard as any).variance, timestamp: Date.now() });
          }
          try {
            const db = require('./db-storage').db;
            if (db && typeof db.createDecisionEvent === 'function') {
              db.createDecisionEvent({ correlationId: null, phase: 'RL_GUARD_BLOCKED', domain, actionPayload: domainAction, metrics: { reward: exp.reward, samples: (rlGuard as any).sampleCount, variance: (rlGuard as any).variance }, timestamp: Date.now() });
            }
          } catch (_) {}
        } catch (_) {
          // ignore
        }
        // Skip learning
        return;
      }
    } catch (guardErr) {
      // if guard check fails, proceed with learning to avoid silent loss
    }

    this.rlAgent.learnDomain(exp);
  }

  private replayAllDomains(): void {
    const domains: RLDecisionDomain[] = [
      'POSITION_SIZING',
      'ENTRY_TIMING',
      'SOURCE_WEIGHTING',
      'EXIT_SEQUENCING',
      'CLUSTER_THRESHOLD',
    ];

    // Also run the legacy global replay for backward compat
    this.rlAgent.replayExperience(32);

    console.log('[RLFeedback] Batch replay triggered across all domains');
  }

  private logOutcome(open: TradeOpenSnapshot, record: TradeCloseRecord): void {
    const won = record.pnlPercent > 0;
    const captureRatio = record.maxPossiblePnlPct > 0
      ? (record.pnlPercent / record.maxPossiblePnlPct * 100).toFixed(0)
      : 'N/A';

    console.log(
      `[RLFeedback] ${open.tradeId} | ${won ? '✓ WIN' : '✗ LOSS'} | ` +
      `PnL: ${record.pnlPercent.toFixed(2)}% | ` +
      `Capture: ${captureRatio}% of MFE | ` +
      `RR: ${record.riskRewardAchieved.toFixed(2)} | ` +
      `Exit: ${record.exitReason} | ` +
      `Regime: ${open.entryState.regime}`
    );

    // Log domain experience counts
    const stats = this.rlAgent.getDomainStats();
    for (const [domain, s] of stats.entries()) {
      const count = this.rlAgent.getDomainExperienceCount(domain, open.entryState.regime);
      console.log(`  [${domain}] regime=${open.entryState.regime} samples=${count} qSize=${s.qTableSize}`);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /** How many trades are currently open and being tracked */
  get openTradeCount(): number {
    return this.pendingTrades.size;
  }

  /** Total trades closed and learned from */
  get closedTradeCount(): number {
    return this.totalClosedTrades;
  }

  /** Snapshot of all pending trade IDs */
  get pendingTradeIds(): string[] {
    return Array.from(this.pendingTrades.keys());
  }

  /** Force-close a stuck trade record without RL update (emergency use only) */
  evictStuckTrade(tradeId: string): void {
    if (this.pendingTrades.has(tradeId)) {
      console.warn(`[RLFeedback] Evicting stuck trade ${tradeId} without feedback`);
      this.pendingTrades.delete(tradeId);
    }
  }
}
