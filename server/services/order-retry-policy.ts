export type RetryAction = 'retry' | 'reduce' | 'switch_venue' | 'abort';

export type OrderRetryConfig = {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
};

export class OrderRetryPolicy {
  private cfg: OrderRetryConfig;
  private rejectionMap: Record<string, RetryAction> = {};
  private patternMap: Array<{pattern: RegExp, action: RetryAction}> = [];

  constructor(cfg?: OrderRetryConfig) {
    this.cfg = {
      maxAttempts: 5,
      baseBackoffMs: 200,
      maxBackoffMs: 30_000,
      jitterMs: 100,
      ...cfg
    };

    // sensible defaults for common exchange errors
    this.rejectionMap = {
      'INSUFFICIENT_FUNDS': 'reduce',
      'UNSUPPORTED_ORDER_TYPE': 'abort',
      'ORDER_NOT_FILLABLE': 'retry',
      'RATE_LIMIT': 'retry',
      'EAI_AGAIN': 'retry',
      'NETWORK_ERROR': 'retry',
      'EXCHANGE_UNAVAILABLE': 'switch_venue',
      'INVALID_ORDER': 'abort'
    };
  }

  mapRejection(code: string): RetryAction {
    if (!code) return 'retry';
    // exact match
    if (this.rejectionMap[code]) return this.rejectionMap[code];
    // pattern match
    for (const p of this.patternMap) {
      if (p.pattern.test(code)) return p.action;
    }
    // fallback
    return 'retry';
  }

  // allow dynamic mappings (exact)
  addMapping(code: string, action: RetryAction) {
    this.rejectionMap[code] = action;
  }

  // add regex-based mapping (e.g. /^5\d{2}$/ -> retry)
  addPatternMapping(pattern: RegExp, action: RetryAction) {
    this.patternMap.push({ pattern, action });
  }

  // Exponential backoff with jitter
  nextDelayMs(attempt: number): number {
    const base = this.cfg.baseBackoffMs || 200;
    const max = this.cfg.maxBackoffMs || 30000;
    const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
    const jitter = (Math.random() - 0.5) * (this.cfg.jitterMs || 0);
    return Math.max(0, Math.round(raw + jitter));
  }

  shouldRetry(attempt: number): boolean {
    return attempt < (this.cfg.maxAttempts || 5);
  }
}

export default OrderRetryPolicy;
