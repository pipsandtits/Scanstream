// Minimal response normalizer for frontend-backend contract
export function normalizeResponse(json: any) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (json.data && Array.isArray(json.data)) return json.data;
  if (json.performers && Array.isArray(json.performers)) return json.performers;
  if (json.topAssets && Array.isArray(json.topAssets)) return json.topAssets;
  if (json.top && Array.isArray(json.top)) return json.top;
  return [];
}

export function normalizeTimestamp(t: any): number {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const parsed = Date.parse(t);
    return isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

export function normalizeAgentSignal(s: any) {
  if (!s) return s;
  const confidence = (typeof s.confidence === 'number') ? (s.confidence > 1 ? s.confidence / 100 : s.confidence) : 0;
  const accuracy = s.accuracy ?? s.historicalAccuracy ?? s.recentWinRate ?? null;
  const timestamp = s.timestamp ? normalizeTimestamp(s.timestamp) : Date.now();
  return { ...s, confidence, accuracy, timestamp };
}

export function normalizeAssetConsensus(a: any) {
  if (!a) return a;
  const avgConfidence = (typeof a.avgConfidence === 'number') ? (a.avgConfidence > 1 ? a.avgConfidence : a.avgConfidence * 100) : 0;
  // normalize nested signals
  const signals = Array.isArray(a.signals) ? a.signals.map(normalizeAgentSignal) : [];
  return { ...a, avgConfidence, signals };
}

export function makeUiAlertFromDivergence(d: any) {
  const buy = d.buyAgents ?? 0;
  const sell = d.sellAgents ?? 0;
  const score = typeof d.divergenceScore === 'number' ? d.divergenceScore : Math.abs(buy - sell) / Math.max(1, (d.totalAgents || (buy + sell)));
  const severity = score > 0.6 ? 'CRITICAL' : score > 0.3 ? 'WARNING' : 'INFO';
  return {
    id: `div-${d.symbol}-${d.timestamp || Date.now()}`,
    symbol: d.symbol,
    type: 'DIVERGENCE',
    message: `${buy} buy vs ${sell} sell (score ${Math.round(score * 100)}%)`,
    severity,
    timestamp: normalizeTimestamp(d.timestamp),
    actionable: true
  };
}

export default {
  normalizeResponse,
  normalizeAgentSignal,
  normalizeAssetConsensus,
  normalizeTimestamp,
  makeUiAlertFromDivergence
};
import { ZodSchema } from 'zod';

type FetchJsonOptions = RequestInit & { retries?: number; retryDelayMs?: number };

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function fetchJson<T = any>(
  url: string,
  options: FetchJsonOptions = {},
  schema?: ZodSchema<T>
): Promise<T> {
  const { retries = 2, retryDelayMs = 300, ...fetchOptions } = options;

  let attempt = 0;
  let lastErr: any = null;

  while (attempt <= retries) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) },
        ...fetchOptions,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${text}`);
      }

      const json = await res.json().catch(() => {
        throw new Error('Invalid JSON response');
      });

      if (schema) {
        const parsed = schema.parse(json);
        return parsed;
      }

      return json as T;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > retries) break;
      const backoff = retryDelayMs * Math.pow(2, attempt - 1);
      // jitter
      const jitter = Math.floor(Math.random() * 100);
      await sleep(backoff + jitter);
    }
  }

  throw lastErr;
}

// Note: fetchJson is exported as a named export above; do not default-export it here.
