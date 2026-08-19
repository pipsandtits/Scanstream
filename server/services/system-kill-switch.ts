import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { safetyEventLog } from './observability/safety-event-log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface KillState {
  killed: boolean;
  reason?: string;
  setBy?: string;
  timestamp?: string;
}

const PERSIST_PATH = path.resolve(__dirname, '..', '..', 'data', 'kill_switch.json');

function ensureDataDir() {
  const dir = path.dirname(PERSIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class SystemKillSwitch extends EventEmitter {
  private state: KillState = { killed: false };

  constructor() {
    super();
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(PERSIST_PATH)) {
        const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
        this.state = JSON.parse(raw) as KillState;
      }
    } catch (err) {
      // Fail closed: a kill state we cannot read may well be "killed", and
      // assuming otherwise would silently re-enable trading after a restart.
      console.error('[SystemKillSwitch] failed to load state, failing closed', err);
      this.state = {
        killed: true,
        reason: 'unreadable_persisted_state',
        setBy: 'system',
        timestamp: new Date().toISOString()
      };
    }
  }

  private persist(): boolean {
    try {
      ensureDataDir();
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(this.state, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[SystemKillSwitch] failed to persist state', err);
      return false;
    }
  }

  isKilled(): boolean {
    return !!this.state.killed;
  }

  getState(): KillState {
    return { ...this.state };
  }

  setKill(reason?: string, setBy?: string) {
    this.state = {
      killed: true,
      reason: reason || 'manual',
      setBy: setBy || 'system',
      timestamp: new Date().toISOString()
    };
    this.persist();
    safetyEventLog.record({
      type: 'kill_switch',
      detail: `activated: ${this.state.reason}`,
      data: { setBy: this.state.setBy },
    });
    this.emit('kill', this.getState());
    console.warn('[SystemKillSwitch] system killed:', this.state);
  }

  clearKill(clearedBy?: string) {
    const previous = this.state;
    this.state = {
      killed: false,
      reason: undefined,
      setBy: clearedBy || 'system',
      timestamp: new Date().toISOString()
    };

    // Clearing must be durable: an in-memory-only clear would silently diverge
    // from the persisted kill state and flip back on restart.
    if (!this.persist()) {
      this.state = previous;
      throw new Error('Cannot clear kill switch: failed to persist cleared state');
    }

    safetyEventLog.record({
      type: 'kill_switch',
      detail: 'cleared',
      data: { clearedBy: this.state.setBy, previousReason: previous.reason },
    });
    this.emit('clear', this.getState());
    console.info('[SystemKillSwitch] kill cleared');
  }
}

export const systemKillSwitch = new SystemKillSwitch();

// Ensure file exists for visibility
systemKillSwitch.getState();

export default systemKillSwitch;
