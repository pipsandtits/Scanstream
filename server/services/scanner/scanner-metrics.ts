// Lightweight Prometheus metrics wrapper for scanner service
// - Loads `prom-client` if available, otherwise provides no-op fallbacks

let Registry: any = null;
let Counter: any = null;
let Gauge: any = null;
let register: any = null;

let enabled = false;

try {
  // require dynamically so server can run without prom-client installed
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prom = require('prom-client');
  Registry = prom.Registry;
  Counter = prom.Counter;
  Gauge = prom.Gauge;
  register = prom.register;
  enabled = true;
} catch (e) {
  enabled = false;
}

const registry = enabled ? new Registry() : null;

// Helper to create metric or noop
function createCounter(opts: any) {
  if (!enabled) return { inc: (_v?: any) => {} };
  try { return new Counter({ ...opts, registers: [registry] }); } catch (e) { return { inc: (_v?: any) => {} }; }
}

function createGauge(opts: any) {
  if (!enabled) return { set: (_v?: any) => {} };
  try { return new Gauge({ ...opts, registers: [registry] }); } catch (e) { return { set: (_v?: any) => {} }; }
}

// Define scanner-specific metrics
const rateLimitCounter = createCounter({ name: 'scanner_rate_limit_hits_total', help: 'Rate limit (429) hits observed by scanner', labelNames: ['exchange', 'symbol'] });
const childExceptionCounter = createCounter({ name: 'scanner_child_exceptions_total', help: 'Uncaught exceptions from scanner child tasks', labelNames: ['exchange', 'symbol'] });
const unhandledRejectionCounter = createCounter({ name: 'scanner_unhandled_rejections_total', help: 'Unhandled promise rejections observed' });
const activeTasksGauge = createGauge({ name: 'scanner_active_tasks', help: 'Active long-lived scanner tasks' });

export function incRateLimit(labels?: { exchange?: string; symbol?: string }) {
  try { rateLimitCounter.inc(labels || {}, 1); } catch (e) {}
}

export function incChildException(labels?: { exchange?: string; symbol?: string }) {
  try { childExceptionCounter.inc(labels || {}, 1); } catch (e) {}
}

export function incUnhandledRejection() {
  try { unhandledRejectionCounter.inc({}, 1); } catch (e) {}
}

export function setActiveTasks(n: number) {
  try { activeTasksGauge.set(Number(n || 0)); } catch (e) {}
}

export function getRegistry(): any {
  return registry;
}

export default {
  incRateLimit,
  incChildException,
  incUnhandledRejection,
  setActiveTasks,
  getRegistry,
};
