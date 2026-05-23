import { db } from '../db-storage';
import getReproMetadata from '../lib/repro';

type Tick = any;

class DataQualityDetector {
  private lastTick: Map<string, number> = new Map();
  private listeners: { symbolTimeframe: string; fn: any }[] = [];
  private running = false;

  start(marketDataLayer: any) {
    if (!marketDataLayer || this.running) return;
    this.running = true;
    const handler = (tick: Tick) => this.onTick(tick).catch((e) => console.warn('[DataQualityDetector] onTick error', e));
    marketDataLayer.on('world.tick', handler);
    this.listeners.push({ symbolTimeframe: 'world.tick', fn: handler });
  }

  stop(marketDataLayer: any) {
    if (!marketDataLayer) return;
    for (const l of this.listeners) marketDataLayer.off('world.tick', l.fn);
    this.listeners = [];
    this.running = false;
  }

  private async onTick(tick: Tick) {
    try {
      const symbol = tick.symbol || tick?.candle?.symbol || 'unknown';
      const timeframe = tick.timeframe ?? (tick.candle?.timeframe ?? 60);
      const ts = tick.candle?.time ?? tick.time ?? tick.timestamp ?? Date.now();
      const key = `${symbol}:${timeframe}`;
      const prev = this.lastTick.get(key);
      const now = typeof ts === 'number' ? ts : new Date(ts).getTime();
      this.lastTick.set(key, now);

      const meta = getReproMetadata();

      if (prev) {
        const deltaMs = now - prev;
        const thresholdMs = (timeframe || 60) * 1000 * (parseFloat(process.env.DQ_GAP_MULTIPLIER ?? '2.5'));
        const outageMs = (timeframe || 60) * 1000 * (parseFloat(process.env.DQ_OUTAGE_MULTIPLIER ?? '6'));

        if (deltaMs > outageMs) {
          // outage
          await db.createDecisionEvent?.({ correlationId: null, phase: 'DATA_QUALITY', domain: 'Market', actionPayload: { action: 'outage', symbol, timeframe }, metrics: { deltaMs }, moduleVersion: meta.moduleVersion, marketFrameId: tick.marketFrameId ?? null, timestamp: new Date(), extra: { commitSha: meta.commitSha } }).catch(() => {});
        } else if (deltaMs > thresholdMs) {
          // abnormal gap
          await db.createDecisionEvent?.({ correlationId: null, phase: 'DATA_QUALITY', domain: 'Market', actionPayload: { action: 'abnormal_gap', symbol, timeframe }, metrics: { deltaMs }, moduleVersion: meta.moduleVersion, marketFrameId: tick.marketFrameId ?? null, timestamp: new Date(), extra: { commitSha: meta.commitSha } }).catch(() => {});
        }
      }

      // stale tick detection relative to now
      const ageMs = Date.now() - now;
      const maxAgeMs = parseInt(process.env.DQ_STALE_MS ?? String(30_000));
      if (ageMs > maxAgeMs) {
        await db.createDecisionEvent?.({ correlationId: null, phase: 'DATA_QUALITY', domain: 'Market', actionPayload: { action: 'stale_tick', symbol, timeframe }, metrics: { ageMs }, moduleVersion: meta.moduleVersion, marketFrameId: tick.marketFrameId ?? null, timestamp: new Date(), extra: { commitSha: meta.commitSha } }).catch(() => {});
      }
    } catch (e) {
      console.warn('[DataQualityDetector] error analysing tick', e);
    }
  }

  getStatus() {
    return { running: this.running, trackedKeys: this.lastTick.size };
  }
}

export const dataQualityDetector = new DataQualityDetector();
export default dataQualityDetector;
