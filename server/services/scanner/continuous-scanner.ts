import EventEmitter from 'events';
import MomentumScanner from './momentum-scanner';
import { incRateLimit, incChildException, setActiveTasks } from './scanner-metrics';
import type { MomentumScoreResult } from './momentum-scanner';

// Minimal MarketFrame shape used by scanner logic. If a canonical type exists
// elsewhere (eg. server/services/gateway types), replace this import later.
export interface MarketFrame {
  timestamp: number; // unix ms
  price: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
  volume?: number;
  indicators?: Record<string, any>;
}

export interface ContinuousScannerOptions {
  pollIntervalMs?: number;
  lookbackCandles?: number;
  persistIntervalMs?: number;
}

/**
 * ContinuousMultiTimeframeScanner
 * - orchestrates periodic fetches of market frames (via a gateway/aggregator)
 * - computes indicators and momentum scores (plugs into MomentumScanner)
 * - emits results and optionally persists to storage
 *
 * This is a lightweight, framework-level skeleton intended to host the
 * port of python's ContinuousMultiTimeframeScanner logic. Core data-fetching
 * should be provided by a caller via the `fetchFrames` callback so we keep
 * concerns separated (gateway vs scanner).
 */
export class ContinuousMultiTimeframeScanner extends EventEmitter {
  private running = false;
  private timer?: NodeJS.Timeout;
  private _controllers: Set<AbortController> = new Set();
  private _tasks: Set<Promise<void>> = new Set();
  private childTasks: Set<Promise<any>> = new Set();

  constructor(
    private symbols: string[],
    private timeframes: number[],
    private fetchFrames: (symbols: string[] | string, timeframes: number[] | number, lookback?: number) => Promise<Record<string, Record<number, MarketFrame[]>>>,
    private opts: ContinuousScannerOptions = { pollIntervalMs: 5000, lookbackCandles: 50, persistIntervalMs: 60000 }
  ) {
    super();
  }

  private createTrackedTask<T = void>(p: Promise<T>) {
    this.childTasks.add(p as Promise<any>);
    setActiveTasks(this.childTasks.size);
    p.then(() => { this.childTasks.delete(p as Promise<any>); setActiveTasks(this.childTasks.size); }).catch(() => { this.childTasks.delete(p as Promise<any>); setActiveTasks(this.childTasks.size); });
  }

  private sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      const id = setTimeout(() => resolve(), Math.max(0, ms));
      if (signal) {
        signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
      }
    });
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Spawn long-lived per-symbol tasks to avoid task churn
    for (const symbol of this.symbols) {
      const controller = new AbortController();
      this._controllers.add(controller);

      const task = (async () => {
        let backoff = 200;
        while (this.running && !controller.signal.aborted) {
          try {
            const data = await this.fetchFrames([symbol], this.timeframes, this.opts.lookbackCandles);
            this.emit('snapshot', { timestamp: Date.now(), data });

            const processedForSymbol: Record<string, { score: number; reason?: string; indicators?: Record<string, any>; framesCount: number }> = {};
            const tfMap = data[symbol] ?? {};
            for (const [tfKey, frames] of Object.entries(tfMap)) {
              try {
                const arr = frames ?? [];
                let result: any = { score: 0, reason: 'NO_DATA', indicators: {} };
                if (arr.length > 0) result = MomentumScanner.computeScore(arr as any[]);
                processedForSymbol[tfKey] = { score: result.score, reason: result.reason, indicators: result.indicators, framesCount: arr.length };
              } catch (innerErr) {
                processedForSymbol[tfKey] = { score: 0, reason: `ERROR:${String(innerErr)}`, indicators: {}, framesCount: 0 };
                incChildException({ symbol, exchange: 'unknown' });
              }
            }

            this.emit('processed', { timestamp: Date.now(), data: { [symbol]: processedForSymbol } });
            backoff = 200;
          } catch (err: any) {
            const msg = String(err || '').toLowerCase();
            if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
              try { incRateLimit({ symbol, exchange: 'unknown' }); } catch (e) {}
            } else {
              try { incChildException({ symbol, exchange: 'unknown' }); } catch (e) {}
            }

            const delay = Math.min(30_000, backoff * 2 + Math.floor(Math.random() * backoff));
            backoff = Math.min(30_000, backoff * 2);
            await this.sleep(delay, controller.signal);
          }

          await this.sleep(this.opts.pollIntervalMs || 5000, controller.signal);
        }
      })();

      this._tasks.add(task);
      task.then(() => { this._tasks.delete(task); this._controllers.delete(controller); }).catch(() => { this._tasks.delete(task); this._controllers.delete(controller); });
    }
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    for (const ctl of Array.from(this._controllers)) {
      try { ctl.abort(); } catch (e) {}
    }
    try { setActiveTasks(0); } catch (e) {}

    // Wait for tracked child tasks to finish gracefully (best effort)
    try {
      const tasks = Array.from(this.childTasks);
      if (tasks.length) {
        void Promise.allSettled(tasks).catch(() => {});
      }
    } catch (e) {}
  }
}

export default ContinuousMultiTimeframeScanner;
