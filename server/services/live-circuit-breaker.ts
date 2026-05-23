import { EventEmitter } from 'events';
import { storage } from '../storage';

export interface CircuitState {
  active: boolean;
  reason?: string;
  setBy?: string;
  timestamp?: number;
}

class LiveCircuitBreaker extends EventEmitter {
  private state: CircuitState = { active: false };

  constructor() {
    super();
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
    // persist event
    try { await storage.createDecisionEvent({ correlationId: null, phase: 'CIRCUIT_BREAKER_ACTIVATED', domain: 'SYSTEM', actionPayload: { reason, setBy }, metrics: {}, timestamp: Date.now() }); } catch (e) {}
    this.emit('activated', this.getState());
  }

  async clear(setBy?: string): Promise<void> {
    if (!this.state.active) return;
    const prev = { ...this.state };
    this.state = { active: false, reason: undefined, setBy: setBy || 'system', timestamp: Date.now() };
    try { await storage.createDecisionEvent({ correlationId: null, phase: 'CIRCUIT_BREAKER_CLEARED', domain: 'SYSTEM', actionPayload: { clearedBy: setBy }, metrics: {}, timestamp: Date.now() }); } catch (e) {}
    this.emit('cleared', { prev, now: this.getState() });
  }
}

export const liveCircuitBreaker = new LiveCircuitBreaker();

export default liveCircuitBreaker;
