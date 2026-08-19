import { RLConfig } from './rl-system-integration';

// Simple phase5 event bridge loader (optional)
let phase5EventBridge: any = null;
try { phase5EventBridge = require('./services/phase5-event-bridge').phase5EventBridge; } catch (e) { phase5EventBridge = null; }

export class RLGuard {
  private rewards: number[] = [];
  private lastFrozenState = false;
  private readonly opts: { windowSize?: number; varianceThreshold?: number; minExperience?: number };

  constructor(opts?: { windowSize?: number; varianceThreshold?: number; minExperience?: number }) {
    // Config is NOT read here. This module is constructed at import time and
    // sits inside an import cycle with rl-system-integration, where `RLConfig`
    // is still in its temporal dead zone: touching it — even with `?.` — throws
    // "Cannot access 'RLConfig' before initialization" and takes down every
    // route group transitively importing it. Config is resolved on first use
    // instead, once the cycle has settled.
    this.opts = opts ?? {};
  }

  private static config(): any {
    try {
      return (RLConfig as any) ?? {};
    } catch {
      return {};
    }
  }

  private get windowSize(): number {
    const cfg = RLGuard.config().rlGuard ?? {};
    return this.opts.windowSize ?? cfg.windowSize ?? 50;
  }

  private get varianceThreshold(): number {
    const cfg = RLGuard.config().rlGuard ?? {};
    return (
      this.opts.varianceThreshold ??
      cfg.varianceThreshold ??
      (Number(process.env.RL_GUARD_VARIANCE_THRESHOLD) || 8)
    );
  }

  private get minExperience(): number {
    const config = RLGuard.config();
    const cfg = config.rlGuard ?? {};
    return this.opts.minExperience ?? cfg.minExperience ?? config.minExperienceForRL ?? 50;
  }

  recordReward(r: number, state?: any): void {
    if (!Number.isFinite(r)) return;
    this.rewards.push(r);
    if (this.rewards.length > this.windowSize) this.rewards.shift();
    // check for state change and emit events if toggled
    const frozen = this.isFrozen();
    if (frozen !== this.lastFrozenState) {
      this.lastFrozenState = frozen;
      try {
        if (phase5EventBridge && typeof phase5EventBridge.emit === 'function') {
          const payload = { frozen, variance: this.variance, samples: this.rewards.length, state: state ?? null, timestamp: Date.now() };
          phase5EventBridge.emit(frozen ? 'rl.guard.frozen' : 'rl.guard.unfrozen', payload);
          // best-effort persistence of guard toggle
          try {
            const db = require('./db-storage').db;
            if (db && typeof db.createDecisionEvent === 'function') {
              db.createDecisionEvent({ correlationId: null, phase: 'RL_GUARD', domain: 'RL_GUARD', actionPayload: { frozen }, metrics: { variance: this.variance, samples: this.rewards.length }, timestamp: payload.timestamp });
            }
          } catch (e) {
            // ignore persistence errors
          }
        }
      } catch (e) {
        // ignore emit errors
      }
    }
  }

  get variance(): number {
    if (this.rewards.length === 0) return 0;
    const mean = this.rewards.reduce((a, b) => a + b, 0) / this.rewards.length;
    const v = this.rewards.reduce((s, x) => s + (x - mean) * (x - mean), 0) / this.rewards.length;
    return v;
  }

  get sampleCount(): number {
    return this.rewards.length;
  }

  isFrozen(): boolean {
    // Freeze if not enough experience OR variance exceeds threshold
    if (this.sampleCount < this.minExperience) return true;
    if (this.variance > this.varianceThreshold) return true;
    return false;
  }

  // Force unfreeze (admin oper)
  forceUnfreeze(): void {
    this.rewards = [];
    this.lastFrozenState = false;
    try { if (phase5EventBridge && typeof phase5EventBridge.emit === 'function') phase5EventBridge.emit('rl.guard.forced_unfreeze', { timestamp: Date.now() }); } catch (_) {}
  }

  getStatus() {
    return { frozen: this.isFrozen(), variance: this.variance, samples: this.sampleCount, threshold: this.varianceThreshold, minExperience: this.minExperience };
  }
}

export const rlGuard = new RLGuard();

export default rlGuard;
