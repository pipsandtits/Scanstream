import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

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
      // ignore and keep defaults
      console.error('[SystemKillSwitch] failed to load state', err);
    }
  }

  private persist() {
    try {
      ensureDataDir();
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.error('[SystemKillSwitch] failed to persist state', err);
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
    this.emit('kill', this.getState());
    console.warn('[SystemKillSwitch] system killed:', this.state);
  }

  clearKill(clearedBy?: string) {
    this.state = {
      killed: false,
      reason: undefined,
      setBy: clearedBy || 'system',
      timestamp: new Date().toISOString()
    };
    this.persist();
    this.emit('clear', this.getState());
    console.info('[SystemKillSwitch] kill cleared');
  }
}

export const systemKillSwitch = new SystemKillSwitch();

// Ensure file exists for visibility
systemKillSwitch.getState();

export default systemKillSwitch;
