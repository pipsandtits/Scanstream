/**
 * 🔄 MODE DETECTOR — Distinguish REPLAY | MIXED | LIVE
 * 
 * This service tracks:
 * 1. Backfill completion (REST API exhausted)
 * 2. WebSocket percentage (% of ticks from WS vs REST)
 * 3. Emit-lag threshold (< 1-2s = LIVE, > 60s = REPLAY)
 * 4. Memory fill level (OrderFlow, microstructure ready)
 * 
 * Result: Explicit mode for each World Tick
 */

import { OperationMode } from '../../types/market-data';

export interface ModeMetrics {
  /** Total ticks from WebSocket */
  wsTickCount: number;

  /** Total ticks from REST backfill */
  restTickCount: number;

  /** Percentage of ticks from WS (0-100) */
  wsPercentage: number;

  /** Is REST backfill complete? */
  backfillComplete: boolean;

  /** Milliseconds since last data arrival */
  timeSinceLastTick: number;

  /** Average emit-lag (ms) */
  avgEmitLag: number;

  /** Memory fill level (0-100) */
  memoryFillLevel: number;

  /** Has market microstructure started? */
  microstructureActive: boolean;

  /** Current mode */
  mode: OperationMode;
}

export class ModeDetector {
  private static instance: ModeDetector;

  private wsTickCount = 0;
  private restTickCount = 0;
  private backfillComplete = false;
  private lastTickTime = Date.now();
  private emitLags: number[] = [];
  private memoryFillLevel = 0;
  private microstructureActive = false;

  private readonly emitLagWindow = 100; // Keep last 100 emit-lags
  private readonly liveThreshold = 2000; // < 2s = LIVE
  private readonly replayThreshold = 60000; // > 60s = REPLAY
  private readonly wsThreshold = 80; // > 80% WS = LIVE (if recent)
  // Hysteresis to avoid rapid flip-flopping
  private previousStableMode: OperationMode | null = null;
  private stabilityCounter = 0;
  private hysteresisThreshold = 3; // require N consecutive detections to flip

  private constructor() {}

  static getInstance(): ModeDetector {
    if (!ModeDetector.instance) {
      ModeDetector.instance = new ModeDetector();
    }
    return ModeDetector.instance;
  }

  setHysteresisThreshold(n: number): void {
    this.hysteresisThreshold = Math.max(1, Math.floor(n));
  }

  /**
   * Record a tick source
   */
  recordTick(source: 'ws' | 'rest'): void {
    if (source === 'ws') {
      this.wsTickCount++;
    } else {
      this.restTickCount++;
    }
    this.lastTickTime = Date.now();
  }

  /**
   * Record emit-lag for averaging
   */
  recordEmitLag(lag: number): void {
    this.emitLags.push(lag);
    if (this.emitLags.length > this.emitLagWindow) {
      this.emitLags.shift();
    }
  }

  /**
   * Mark backfill as complete
   */
  setBackfillComplete(complete: boolean): void {
    this.backfillComplete = complete;
    if (complete) {
      console.log('[ModeDetector] ✅ REST backfill complete');
      
      // Initialize LIVE epoch when backfill finishes
      // Use dynamic import to avoid circular require issues in ESM contexts
      (async () => {
        try {
          const mod = await import('./integrity-gate');
          if (mod && typeof mod.getLiveEpoch === 'function') {
            const liveEpoch = mod.getLiveEpoch();
            try { liveEpoch.initializeLiveStart(); } catch (e) { /* ignore init errors */ }
          }
        } catch (e) {
          // Non-fatal: initialization best-effort
        }
      })();
    }
  }

  /**
   * Update memory fill level (0-100)
   */
  setMemoryFillLevel(level: number): void {
    this.memoryFillLevel = Math.max(0, Math.min(100, level));
  }

  /**
   * Mark microstructure as active
   */
  setMicrostructureActive(active: boolean): void {
    this.microstructureActive = active;
  }

  /**
   * Detect current operation mode (WITHOUT calling getMetrics to avoid infinite recursion)
   * 
   * Simplified logic: Just check data source proportion
   * - If > 50% of ticks are from WS → LIVE
   * - Otherwise → MIXED
   */
  detectMode(): OperationMode {
    const total = this.wsTickCount + this.restTickCount;
    const wsPercentage = total > 0 ? Math.round((this.wsTickCount / total) * 100) : 0;
    const avgEmitLag =
      this.emitLags.length > 0 ? Math.round(this.emitLags.reduce((a, b) => a + b, 0) / this.emitLags.length) : Infinity;

    // More nuanced detection using backfill status, WS percentage and emit-lag
    let candidate: OperationMode;

    if (this.backfillComplete && wsPercentage > 75 && avgEmitLag < 1500) {
      candidate = OperationMode.LIVE;
    } else if (this.backfillComplete || wsPercentage > 40) {
      candidate = OperationMode.MIXED;
    } else {
      candidate = OperationMode.REPLAY;
    }

    // Hysteresis: require stability across several assessments before flipping
    if (this.previousStableMode === candidate) {
      this.stabilityCounter = Math.min(this.hysteresisThreshold, this.stabilityCounter + 1);
    } else {
      this.stabilityCounter = 1;
    }

    if (this.stabilityCounter >= this.hysteresisThreshold) {
      this.previousStableMode = candidate;
    }

    return this.previousStableMode || candidate;
  }

  /**
   * Get current metrics (read-only)
   * Calls detectMode() to compute current mode
   */
  getMetrics(): ModeMetrics {
    const total = this.wsTickCount + this.restTickCount;
    const wsPercentage = total > 0 ? Math.round((this.wsTickCount / total) * 100) : 0;
    const avgEmitLag =
      this.emitLags.length > 0 ? Math.round(this.emitLags.reduce((a, b) => a + b, 0) / this.emitLags.length) : 0;

    return {
      wsTickCount: this.wsTickCount,
      restTickCount: this.restTickCount,
      wsPercentage,
      backfillComplete: this.backfillComplete,
      timeSinceLastTick: Date.now() - this.lastTickTime,
      avgEmitLag,
      memoryFillLevel: this.memoryFillLevel,
      microstructureActive: this.microstructureActive,
      mode: this.detectMode(),
    };
  }

  /**
   * Diagnostic: Print mode detection state
   */
  diagnostics(): string {
    const m = this.getMetrics();
    return [
      `[ModeDetector] Current Mode: ${m.mode}`,
      `  WS: ${m.wsTickCount} | REST: ${m.restTickCount} | WS%: ${m.wsPercentage}%`,
      `  Backfill: ${m.backfillComplete ? 'COMPLETE' : 'IN PROGRESS'}`,
      `  Avg Emit-lag: ${m.avgEmitLag}ms`,
      `  Memory: ${m.memoryFillLevel}%`,
      `  Microstructure: ${m.microstructureActive ? 'ACTIVE' : 'INACTIVE'}`,
    ].join('\n');
  }

  /**
   * Reset (for testing)
   */
  reset(): void {
    this.wsTickCount = 0;
    this.restTickCount = 0;
    this.backfillComplete = false;
    this.lastTickTime = Date.now();
    this.emitLags = [];
    this.memoryFillLevel = 0;
    this.microstructureActive = false;
  }
}

export function getModeDetector(): ModeDetector {
  return ModeDetector.getInstance();
}
