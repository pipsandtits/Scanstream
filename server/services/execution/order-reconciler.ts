/**
 * Order reconciliation for ambiguous exchange outcomes.
 *
 * A network timeout, socket hang-up or 5xx from `createOrder` does NOT mean the
 * order was rejected — the exchange may well have accepted it. Retrying blindly
 * in that situation duplicates real capital exposure, so callers must reconcile
 * first using the client order id they submitted.
 */

export type ReconcileState = 'exists' | 'absent' | 'unknown';

export interface ReconcileResult {
  state: ReconcileState;
  order?: any;
  /** Which lookups answered successfully (for observability). */
  checked: string[];
  errors: string[];
}

/** Errors that leave the order state undetermined. */
const AMBIGUOUS_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /etimedout/i,
  /econnreset/i,
  /econnaborted/i,
  /socket hang up/i,
  /network/i,
  /request failed/i,
  /ehostunreach/i,
  /enetunreach/i,
  /eai_again/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /\b50[0234]\b/,
];

export function isAmbiguousError(err: any): boolean {
  if (!err) return false;
  const name = String(err?.constructor?.name || '');
  if (/RequestTimeout|NetworkError|ExchangeNotAvailable|DDoSProtection|OperationFailed/i.test(name)) return true;
  const text = `${err?.code ?? ''} ${err?.message ?? err}`;
  return AMBIGUOUS_PATTERNS.some((p) => p.test(text));
}

function matchesClientId(order: any, clientOrderId: string): boolean {
  if (!order || !clientOrderId) return false;
  const candidates = [
    order.clientOrderId,
    order.info?.clientOrderId,
    order.info?.clientOid,
    order.info?.origClientOrderId,
    order.info?.newClientOrderId,
    order.info?.client_order_id,
  ];
  return candidates.some((c) => c !== undefined && c !== null && String(c) === clientOrderId);
}

/**
 * Determine whether an order carrying `clientOrderId` reached the exchange.
 *
 * Returns `absent` only when every available listing succeeded and none of them
 * contained the id. If any lookup was unavailable-but-attempted or failed, the
 * result is `unknown`, which callers must treat as "may exist" (fail closed —
 * do not retry). A partial answer is not proof of absence: an order missing
 * from `fetchOpenOrders` may still sit in `fetchClosedOrders`.
 */
export async function reconcileByClientOrderId(
  exchange: any,
  symbol: string,
  clientOrderId: string,
  options: { since?: number; limit?: number } = {}
): Promise<ReconcileResult> {
  const checked: string[] = [];
  const errors: string[] = [];

  if (!exchange || !clientOrderId) {
    return { state: 'unknown', checked, errors: ['missing exchange or clientOrderId'] };
  }

  const since = options.since ?? Date.now() - 10 * 60_000;
  const limit = options.limit ?? 50;

  const lookups: Array<{ name: string; run: () => Promise<any[]> }> = [
    { name: 'fetchOpenOrders', run: () => exchange.fetchOpenOrders(symbol, since, limit) },
    { name: 'fetchClosedOrders', run: () => exchange.fetchClosedOrders(symbol, since, limit) },
    { name: 'fetchOrders', run: () => exchange.fetchOrders(symbol, since, limit) },
    { name: 'fetchMyTrades', run: () => exchange.fetchMyTrades(symbol, since, limit) },
  ];

  for (const lookup of lookups) {
    if (typeof exchange[lookup.name] !== 'function') continue;
    try {
      const rows = (await lookup.run()) || [];
      checked.push(lookup.name);
      const hit = rows.find((row: any) => matchesClientId(row, clientOrderId) || matchesClientId(row?.order, clientOrderId));
      if (hit) return { state: 'exists', order: hit.order ?? hit, checked, errors };
    } catch (err: any) {
      errors.push(`${lookup.name}: ${err?.message || String(err)}`);
    }
  }

  // No successful lookup, or some lookup failed: state is undetermined.
  if (checked.length === 0 || errors.length > 0) return { state: 'unknown', checked, errors };
  return { state: 'absent', checked, errors };
}

/** Stable, exchange-safe client order id (alphanumeric, <= 32 chars). */
export function buildClientOrderId(prefix: string, seed?: string): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Truncate the descriptive part, never the uniqueness suffix.
  const base = `${prefix}${seed ?? ''}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32 - suffix.length);
  return `${base}${suffix}`;
}

export default reconcileByClientOrderId;
