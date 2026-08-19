/**
 * Durability gate.
 *
 * Live trading requires durable persistence. Without it the process appears
 * healthy while every order, fill and position it records is lost on restart,
 * leaving real exchange exposure that no local state can explain.
 *
 * Readiness reporting is not enough — an operator can start live trading
 * without looking at it. This gate is enforced in the execution path itself:
 *
 *   live mode -> durable database required -> otherwise fail closed
 *
 * Paper/test mode may legitimately run on the in-memory fallback, so the mode
 * is an explicit input rather than an assumption.
 */

export type DurabilityReason =
  | 'database_url_missing'
  | 'database_unavailable'
  | 'probe_failed'
  | 'persistence_failure';

export interface DurabilityStatus {
  durable: boolean;
  reason?: DurabilityReason;
  detail?: string;
  checkedAt: number;
}

/** Probe result cache window. Keeps per-order latency bounded while still
 *  noticing a database that disappeared after startup. */
export const DURABILITY_PROBE_TTL_MS = 5_000;

export type DurabilityProbe = () => Promise<boolean>;

class DurabilityGate {
  private probe: DurabilityProbe | null = null;
  private cached: DurabilityStatus | null = null;
  private inFlight: Promise<DurabilityStatus> | null = null;

  /** Injected by the storage layer (and by tests) so this module does not
   *  depend on a concrete storage implementation. */
  setProbe(probe: DurabilityProbe | null): void {
    this.probe = probe;
    this.cached = null;
  }

  /**
   * Force the next check to re-probe. Call this when a write to durable
   * storage fails: the cached "durable" answer is no longer trustworthy.
   */
  invalidate(detail?: string): void {
    this.cached = {
      durable: false,
      reason: 'persistence_failure',
      detail: detail ?? 'a durable write failed',
      checkedAt: Date.now(),
    };
  }

  /** Test seam. */
  reset(): void {
    this.probe = null;
    this.cached = null;
    this.inFlight = null;
  }

  async check(now: number = Date.now()): Promise<DurabilityStatus> {
    if (this.cached && this.cached.durable && now - this.cached.checkedAt < DURABILITY_PROBE_TTL_MS) {
      return this.cached;
    }

    if (!process.env.DATABASE_URL) {
      this.cached = {
        durable: false,
        reason: 'database_url_missing',
        detail: 'DATABASE_URL is not configured; storage is not durable',
        checkedAt: now,
      };
      return this.cached;
    }

    if (!this.probe) {
      this.cached = {
        durable: false,
        reason: 'probe_failed',
        detail: 'no durability probe registered',
        checkedAt: now,
      };
      return this.cached;
    }

    // Concurrent executions share one probe rather than stampeding the database.
    if (!this.inFlight) {
      const probe = this.probe;
      this.inFlight = (async (): Promise<DurabilityStatus> => {
        try {
          const ok = await probe();
          return ok
            ? { durable: true, checkedAt: now }
            : {
                durable: false,
                reason: 'database_unavailable',
                detail: 'database probe reported the connection is not usable',
                checkedAt: now,
              };
        } catch (err: any) {
          // A probe that throws means unknown, and unknown is not durable.
          return {
            durable: false,
            reason: 'probe_failed',
            detail: err?.message ? String(err.message) : 'durability probe threw',
            checkedAt: now,
          };
        }
      })().finally(() => {
        this.inFlight = null;
      });
    }

    this.cached = await this.inFlight;
    return this.cached;
  }

  /**
   * The single question the execution path asks. `testMode` covers paper and
   * sandbox operation, where non-durable storage is an accepted trade-off.
   */
  async requireForLive(testMode: boolean): Promise<DurabilityStatus> {
    if (testMode) return { durable: true, detail: 'test/paper mode', checkedAt: Date.now() };
    return this.check();
  }

  /** Last known status without probing, for health reporting. */
  peek(): DurabilityStatus | null {
    return this.cached;
  }
}

export const durabilityGate = new DurabilityGate();
