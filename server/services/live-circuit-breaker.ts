import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { storage } from '../storage';
import { safetyEventLog } from './observability/safety-event-log';

export interface CircuitState {
  active: boolean;
  reason?: string;
  setBy?: string;
  timestamp?: number;
}

const STATE_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(STATE_DIR, 'live_circuit_breaker.json');

/**
 * Global halt for live placements.
 *
 * State is persisted to disk so a tripped breaker survives a process restart —
 * an in-memory-only breaker silently re-enables trading on the next deploy.
 */
class LiveCircuitBreaker extends EventEmitter {
  private state: CircuitState = { active: false };

  constructor() {
    super();
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (parsed && typeof parsed.active === 'boolean') {
          this.state = parsed;
        }
      }
    } catch (e) {
      // A corrupt or unreadable state file must not silently mean "trading allowed".
      this.state = { active: true, reason: 'unreadable_persisted_state', setBy: 'system', timestamp: Date.now() };
    }
  }

  private persist(): boolean {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('[LiveCircuitBreaker] Failed to persist state:', (e as any)?.message || e);
      return false;
    }
  }

  isActive(): boolean {
    return !!this.state.active;
  }

  getState(): CircuitState {
    return { ...this.state };
  }

  async activate(reason: string, setBy?: string): Promise<void> {
    if (this.state.active) return;
    this.state = { active: true, reason, setBy: setBy || 'system', timestamp: Date.now() };
    this.persist();
    // persist event
    try { await storage.createDecisionEvent({ correlationId: null, phase: 'CIRCUIT_BREAKER_ACTIVATED', domain: 'SYSTEM', actionPayload: { reason, setBy }, metrics: {}, timestamp: Date.now() }); } catch (e) {}
    safetyEventLog.record({
      type: 'circuit_breaker',
      detail: `activated: ${reason}`,
      data: { setBy: this.state.setBy },
    });
    this.emit('activated', this.getState());
  }

  async clear(setBy?: string): Promise<void> {
    if (!this.state.active) return;
    const prev = { ...this.state };
    this.state = { active: false, reason: undefined, setBy: setBy || 'system', timestamp: Date.now() };

    // A clear that cannot be persisted would diverge from disk and re-trip on
    // restart; keep the breaker active instead.
    if (!this.persist()) {
      this.state = prev;
      throw new Error('Cannot clear live circuit breaker: failed to persist cleared state');
    }
    try { await storage.createDecisionEvent({ correlationId: null, phase: 'CIRCUIT_BREAKER_CLEARED', domain: 'SYSTEM', actionPayload: { clearedBy: setBy }, metrics: {}, timestamp: Date.now() }); } catch (e) {}
    safetyEventLog.record({
      type: 'circuit_breaker',
      detail: 'cleared',
      data: { clearedBy: this.state.setBy, previousReason: prev.reason },
    });
    this.emit('cleared', { prev, now: this.getState() });
  }
}

export const liveCircuitBreaker = new LiveCircuitBreaker();

export default liveCircuitBreaker;
