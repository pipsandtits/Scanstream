import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { randomUUID } from 'crypto';
import { ModuleLogger } from './utils/logger';

// Type helpers
interface TradingEvent {
  type: string;
  payload: any;
  timestamp: number;
}

interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  id?: string;
  subscriptions?: Set<string>;
}

const wsConfig = {
  path: '/events',
  rawPath: '/ws',
  heartbeatIntervalMs: 30000,
  clientTimeoutMs: 60000,
  maxClients: 1000,
  enableRawWs: true,
  // allowedOrigins: undefined, // e.g. ['https://app.example.com']
} as const;

const logger = new ModuleLogger('WS-Bridge');

// Health state
let gateAvailable = false;
let lastGateAttempt: number | null = null;
let bridgeInitializedAt = Date.now();

// Lazily import/get the integrity gate so this module can be imported
// before the gate is initialized in startup code.
async function getGate(): Promise<any | null> {
  try {
    const mod = await import('./services/market-data/integrity-gate');
    const g = (mod as any).getIntegrityGate;
    if (typeof g === 'function') {
      try {
        return await g();
      } catch (e) {
        return null;
      }
    }
    return g || null;
  } catch (err) {
    return null;
  }
}

export function initializeWebsocketBridge(server: http.Server, path = wsConfig.path) {
  // Prevent double initialization if called more than once
  try {
    if ((global as any).__ws_bridge_initialized) {
      logger.warn('WebSocket bridge already initialized — skipping duplicate init');
      return (global as any).__wss_bridge?.wss || null;
    }
  } catch (e) { /* ignore */ }
  // Use noServer WebSocketServers and perform a single upgrade handler to avoid
  // race conditions when registering multiple WebSocketServer instances on the same http.Server.
  const wss = new WebSocketServer({ noServer: true });
  const rawWss = new WebSocketServer({ noServer: true });
  // expose bridge servers globally so other modules can detect and reuse them
  try {
    (global as any).__ws_bridge_initialized = true;
    (global as any).__wss_bridge = { wss, rawWss };
  } catch (e) { /* ignore */ }

  logger.info(`WebSocket bridge prepared (manual upgrade) at ${path}`);
  logger.info(`Raw WebSocket prepared (manual upgrade) at /ws`);

  // single upgrade router with optional origin check
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = req.url || '';
      const origin = (req.headers && (req.headers as any).origin) || '';
      // Basic origin check if configured
      if ((wsConfig as any).allowedOrigins && Array.isArray((wsConfig as any).allowedOrigins)) {
        const allowed = (wsConfig as any).allowedOrigins as string[];
        if (origin && !allowed.includes(origin)) {
          socket.destroy();
          return;
        }
      }

      if (url.startsWith(path)) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        return;
      }
      if (wsConfig.enableRawWs && url.startsWith(wsConfig.rawPath)) {
        rawWss.handleUpgrade(req, socket, head, (ws) => rawWss.emit('connection', ws, req));
        return;
      }
      socket.destroy();
    } catch (err) {
      try { socket.destroy(); } catch (e) {}
    }
  });

  // Map of subscribed event names
  // Exclude Phase5 events here — they are handled separately to avoid duplicate deliveries
  const eventNames = [
    'world.tick',
    'consensus.updated',
    'arb.signal',
    'execution.filled',
    'gap.detected',
    'gaps.detected',
    'aggregated.updated',
    'integrity.report',
    'candles.rejected'
  ];

  // Helper: forward message to clients
  function broadcast(obj: TradingEvent) {
    const msg = JSON.stringify(obj);
    const symbol = obj.payload && (obj.payload.symbol || obj.payload?.s || obj.payload?.ticker);

    [wss, rawWss].forEach((serverWs) => {
      serverWs.clients.forEach((c: any) => {
        try {
          const client = c as ExtendedWebSocket;
          if (client.readyState !== WebSocket.OPEN) return;

          // If payload carries a symbol and client has subscriptions, filter
          if (symbol) {
            if (client.subscriptions && client.subscriptions.size > 0) {
              if (!client.subscriptions.has(symbol)) return;
            }
          }

          client.send(msg);
        } catch (e) {
          // ignore per-client send errors
        }
      });
    });
  }

  // expose a broadcaster hook so other services (e.g. SignalWebSocketService)
  // can forward messages through the bridge to raw WS clients without
  // creating a second WebSocketServer on the same server instance.
  try {
    (global as any).__bridgeBroadcast = broadcast;
  } catch (e) { /* ignore */ }

  // Subscribe to gate when available
  // Subscribe to gate events with retry/backoff so bridge survives gate startup order
  (async () => {
    let attempts = 0;
    const maxAttempts = 12; // try for ~1 minute
    const subs: Array<{ evt: string; cb: (...a:any[])=>void }> = [];
    while (attempts < maxAttempts) {
      attempts += 1;
      const gate = await getGate();
      lastGateAttempt = Date.now();
      if (!gate) {
        // backoff
        await new Promise(r => setTimeout(r, Math.min(5000, attempts * 800)));
        continue;
      }

      try {
        gateAvailable = true;
        eventNames.forEach((evt) => {
          const cb = (payload: any) => {
            try {
              broadcast({ type: evt, payload });
            } catch (e) { /* ignore */ }
          };
          (gate as any).on(evt, cb);
          subs.push({ evt, cb });
        });

        // ensure we remove subscriptions if the bridge is closed
        const cleanup = () => subs.forEach(s => (gate as any).off(s.evt, s.cb));
        wss.on('close', cleanup);
        rawWss.on('close', cleanup);
      } catch (err) {
        logger.warn('Failed to subscribe to gate events', err);
      }
      break;
    }
    if (attempts >= maxAttempts) {
      logger.warn('Integrity gate not available after retries — gate events will not be forwarded');
    }
  })();

  // PHASE 5: Subscribe to Phase 5 real-time events
  (async () => {
    try {
      const { phase5EventBridge } = await import('./services/phase5-event-bridge');
      
      const phase5Subs: Array<{ evt: string; cb: (...a:any[])=>void }> = [];
      
      // Subscribe to Phase 5 signal events — emit both old and new event names for compatibility
      const onSignalNew = (data: any) => {
        try {
          const ev: TradingEvent = { type: 'phase5:signal:new', timestamp: Date.now(), payload: data };
          broadcast(ev);
          // new name
          const ev2: TradingEvent = { type: 'phase5:signal:created', timestamp: Date.now(), payload: data };
          broadcast(ev2);
        } catch (e) { /* ignore */ }
      };
      phase5EventBridge.on('phase5:signal:new', onSignalNew);
      phase5Subs.push({ evt: 'phase5:signal:new', cb: onSignalNew });

      // Subscribe to Phase 5 signal update events — emit both old and new event names
      const onSignalUpdate = (data: any) => {
        try {
          const ev: TradingEvent = { type: 'phase5:signal:update', timestamp: Date.now(), payload: data };
          broadcast(ev);
          const ev2: TradingEvent = { type: 'phase5:signal:updated', timestamp: Date.now(), payload: data };
          broadcast(ev2);
        } catch (e) { /* ignore */ }
      };
      phase5EventBridge.on('phase5:signal:update', onSignalUpdate);
      phase5Subs.push({ evt: 'phase5:signal:update', cb: onSignalUpdate });

      // Subscribe to Phase 5 agent update events — emit both old and new event names
      const onAgentUpdate = (data: any) => {
        try {
          const ev: TradingEvent = { type: 'phase5:agent:update', timestamp: Date.now(), payload: data };
          broadcast(ev);
          const ev2: TradingEvent = { type: 'phase5:agent:updated', timestamp: Date.now(), payload: data };
          broadcast(ev2);
        } catch (e) { /* ignore */ }
      };
      phase5EventBridge.on('phase5:agent:update', onAgentUpdate);
      phase5Subs.push({ evt: 'phase5:agent:update', cb: onAgentUpdate });

      // Subscribe to Phase 5 regime update events — emit both old and new event names
      const onRegimeUpdate = (data: any) => {
        try {
          const ev: TradingEvent = { type: 'phase5:regime:update', timestamp: Date.now(), payload: data };
          broadcast(ev);
          const ev2: TradingEvent = { type: 'phase5:regime:updated', timestamp: Date.now(), payload: data };
          broadcast(ev2);
        } catch (e) { /* ignore */ }
      };
      phase5EventBridge.on('phase5:regime:update', onRegimeUpdate);
      phase5Subs.push({ evt: 'phase5:regime:update', cb: onRegimeUpdate });

      const cleanupPhase5 = () => phase5Subs.forEach(s => phase5EventBridge.off(s.evt, s.cb));
      wss.on('close', cleanupPhase5);
      rawWss.on('close', cleanupPhase5);
      } catch (err) {
      logger.warn('Phase 5 event bridge not available', err);
    }
  })();

  // heartbeat and connection handling for both servers
  function setupConnection(wsRaw: any, req: any, label = 'WS') {
    const ws = wsRaw as ExtendedWebSocket;

    // enforce max clients across both servers
    const totalClients = wss.clients.size + rawWss.clients.size;
    if (typeof wsConfig.maxClients === 'number' && totalClients > wsConfig.maxClients) {
      try { ws.send(JSON.stringify({ type: 'error', message: 'server busy' })); } catch (e) {}
      return ws.terminate();
    }

    const id = (randomUUID && typeof randomUUID === 'function') ? randomUUID() : Math.random().toString(36).slice(2,8);
    ws.id = id;
    ws.subscriptions = new Set<string>();
    logger.info(`${label} client connected ${id} from ${req.socket?.remoteAddress}`);
    try { ws.send(JSON.stringify({ type: 'welcome', timestamp: Date.now(), msg: 'Connected to Scanstream events' })); } catch (e) {}

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data: any) => {
      try {
        const txt = (typeof data === 'string') ? data : data.toString();
        const parsed = txt ? JSON.parse(txt) : null;
        if (parsed && parsed.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (e) {}
        }

        // handle subscribe on raw ws messages
        if (parsed && parsed.type === 'subscribe' && parsed.symbol) {
          ws.subscriptions!.add(parsed.symbol);
          try { ws.send(JSON.stringify({ type: 'subscribed', symbol: parsed.symbol, message: `Subscribed to ${parsed.symbol}` })); } catch (e) {}
        }

        if (parsed && parsed.type === 'unsubscribe' && parsed.symbol) {
          ws.subscriptions!.delete(parsed.symbol);
          try { ws.send(JSON.stringify({ type: 'unsubscribed', symbol: parsed.symbol })); } catch (e) {}
        }
      } catch (err) { /* ignore invalid */ }
    });

    ws.on('close', () => logger.info(`${label} client disconnected ${id}`));
    ws.on('error', (err: any) => logger.warn(`${label} client error ${id}: ${err && err.message}`));
  }

  wss.on('connection', (ws: any, req: any) => setupConnection(ws, req, 'WSS'));
  rawWss.on('connection', (ws: any, req: any) => setupConnection(ws, req, 'RAW'));

  // periodic ping to detect dead clients
  const pingInterval = setInterval(() => {
    [wss, rawWss].forEach((serverWs) => {
      serverWs.clients.forEach((c: any) => {
        try {
          const client = c as ExtendedWebSocket;
          if (client.isAlive === false) return client.terminate();
          client.isAlive = false;
          client.ping();
        } catch (e) {
          try { c.terminate(); } catch (e) {}
        }
      });
    });
  }, wsConfig.heartbeatIntervalMs).unref();

  // graceful shutdown
  const shutdown = () => {
    clearInterval(pingInterval as any);
    try { wss.close(); } catch (e) {}
    try { rawWss.close(); } catch (e) {}
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return wss;
}

export default initializeWebsocketBridge;

// Expose a small health helper for HTTP endpoints
export function getBridgeHealth() {
  return {
    clients: typeof (global as any).__ws_clients_count === 'number' ? (global as any).__ws_clients_count : null,
    // derive from actual servers if available
    wssClients: (() => {
      try { return (global as any).__wss ? (global as any).__wss.clients.size : null; } catch (e) { return null; }
    })(),
    gateAvailable,
    lastGateAttempt: lastGateAttempt ? new Date(lastGateAttempt).toISOString() : null,
    uptimeMs: Date.now() - bridgeInitializedAt
  };
}
