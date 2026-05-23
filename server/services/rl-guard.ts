/**
 * RLGuard — monitor RL feedback and control whether learning should proceed.
 * - Freezes learning when recent reward variance is high or sample count low
 * - Can force conservative weight multipliers for production safety
 */
import { EventEmitter } from 'events';

export class RLGuard extends EventEmitter {
  private frozen: boolean = false;
  private conservativeMode: boolean = false;
  private recentRewards: number[] = [];
  private sampleWindow = 200; // how many rewards to keep
  private varianceThreshold = Number(process.env.RL_GUARD_VARIANCE_THRESHOLD) || 4.0; // variance
  private minSamples = Number(process.env.RL_GUARD_MIN_SAMPLES) || 30;

  constructor() { super(); }

  recordReward(v: number) {
    this.recentRewards.push(v);
    if (this.recentRewards.length > this.sampleWindow) this.recentRewards.shift();
    this.evaluate();
  }

  private evaluate() {
    if (this.recentRewards.length < this.minSamples) {
      // not enough data to decide; keep conservativeMode on to be safe
      this.conservativeMode = true;
      this.frozen = false;
      this.emit('conservative', { reason: 'insufficient_samples', samples: this.recentRewards.length });
      return;
    }

    const mean = this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length;
    const variance = this.recentRewards.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.recentRewards.length;

    if (variance > this.varianceThreshold) {
      // high volatility in rewards — freeze learning briefly
      if (!this.frozen) {
        this.frozen = true;
        this.emit('frozen', { variance, mean, samples: this.recentRewards.length });
      }
      this.conservativeMode = true;
    } else {
      if (this.frozen) {
        this.frozen = false;
        this.emit('unfrozen', { variance, mean, samples: this.recentRewards.length });
      }
      // exit conservative mode only when variance is low and we have enough samples
      this.conservativeMode = false;
    }
  }

  isFrozen(): boolean { return this.frozen; }
  isConservative(): boolean { return this.conservativeMode; }

  forceFreeze() { this.frozen = true; this.emit('frozen', { reason: 'manual' }); }
  releaseFreeze() { this.frozen = false; this.emit('unfrozen', { reason: 'manual' }); }
}

export const rlGuard = new RLGuard();
