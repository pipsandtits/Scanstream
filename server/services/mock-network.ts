export type MockNetworkOptions = {
  meanLatencyMs?: number;
  jitterMs?: number;
  rateLimitPerSec?: number; // max requests per second
};

export class MockNetwork {
  private opts: MockNetworkOptions;
  private tokens: number;
  private lastRefill: number;

  constructor(opts?: MockNetworkOptions) {
    this.opts = {
      meanLatencyMs: 50,
      jitterMs: 30,
      rateLimitPerSec: 1000,
      ...opts
    };
    this.tokens = this.opts.rateLimitPerSec || 1000;
    this.lastRefill = Date.now();
  }

  // Promise that delays according to configured latency + jitter
  async delay(): Promise<void> {
    const mean = this.opts.meanLatencyMs || 0;
    const jitter = this.opts.jitterMs || 0;
    const delta = (Math.random() - 0.5) * jitter * 2;
    const ms = Math.max(0, Math.round(mean + delta));
    return new Promise((r) => setTimeout(r, ms));
  }

  // Simple token-bucket rate limiter; throws on limit exceeded
  checkRateLimit(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    const perSec = this.opts.rateLimitPerSec || 1000;
    // refill
    const refill = Math.floor((elapsed / 1000) * perSec);
    if (refill > 0) {
      this.tokens = Math.min(perSec, this.tokens + refill);
      this.lastRefill = now;
    }

    if (this.tokens <= 0) {
      const e: any = new Error('MockNetwork: rate limit exceeded');
      e.code = 'RATE_LIMIT';
      throw e;
    }
    this.tokens -= 1;
  }
}

export default MockNetwork;
