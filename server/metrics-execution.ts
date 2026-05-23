// Lightweight execution metrics: fills, slippage, realized PnL
import * as os from 'os';

let enabled = false;
let Registry: any = null;
let Counter: any = null;
let Gauge: any = null;

let fillCounter: any = null;
let slippageHist: any = null;
let realizedPnLGauge: any = null;
export let metricsRegister: any = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prom = require('prom-client');
  Registry = prom.Registry;
  Counter = prom.Counter;
  Gauge = prom.Gauge;
  const Histogram = prom.Histogram;

  const register = new Registry();
  register.setDefaultLabels({ service: 'scanstream', host: os.hostname() });

  fillCounter = new Counter({
    name: 'execution_fills_total',
    help: 'Total number of fills',
    labelNames: ['symbol']
  });

  slippageHist = new Histogram({
    name: 'execution_slippage',
    help: 'Slippage distribution (fraction)',
    labelNames: ['symbol'],
    buckets: [0, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02]
  });

  realizedPnLGauge = new Gauge({
    name: 'execution_realized_pnl',
    help: 'Last realized PnL for closed positions (USD)',
    labelNames: ['symbol']
  });

  register.registerMetric(fillCounter);
  register.registerMetric(slippageHist);
  register.registerMetric(realizedPnLGauge);

  // Expose register for ESM consumers
  metricsRegister = register;
  enabled = true;
} catch (err) {
  enabled = false;
}

// in-memory fallback stats for health endpoints
const inMemory = {
  fills: 0,
  slippageSamples: 0,
  lastRealizedPnL: 0
};

export function recordFill(symbol: string, amount: number) {
  inMemory.fills += 1;
  try { if (enabled && fillCounter) fillCounter.inc({ symbol }, 1); } catch (e) {}
}

export function recordSlippage(symbol: string, fraction: number) {
  inMemory.slippageSamples += 1;
  try { if (enabled && slippageHist) slippageHist.observe({ symbol }, fraction); } catch (e) {}
}

export function recordRealizedPnL(symbol: string, usd: number) {
  inMemory.lastRealizedPnL = usd;
  try { if (enabled && realizedPnLGauge) realizedPnLGauge.set({ symbol }, usd); } catch (e) {}
}

export function getExecutionStats() {
  return {
    fills: inMemory.fills,
    slippageSamples: inMemory.slippageSamples,
    lastRealizedPnL: inMemory.lastRealizedPnL,
    prometheusEnabled: enabled
  };
}

export default { recordFill, recordSlippage, recordRealizedPnL, getExecutionStats };
