import { RLPositionAgent } from '../../server/rl-position-agent';

let _rlAgent: RLPositionAgent | null = null;

export function getRLAgent(): RLPositionAgent {
  if (!_rlAgent) {
    _rlAgent = new RLPositionAgent();
    try {
      if (typeof (_rlAgent as any).loadQTable === 'function') {
        (_rlAgent as any).loadQTable();
      }
    } catch (e) {
      // ignore load failures here — agent will attempt later
    }
  }
  return _rlAgent;
}

export function resetRLAgent(): void {
  _rlAgent = null;
}
