/**
 * Startup reconciliation barrier.
 *
 * A process that restarts after a crash, deploy or network partition does not
 * know what happened while it was gone: an order may have filled, a position
 * may have been liquidated, an operator may have traded manually. Starting to
 * place new orders before answering that question is how a restart turns a
 * recoverable incident into an unexplained position.
 *
 * So live execution is gated behind an explicit barrier:
 *
 *   local state -> exchange balances -> positions -> open orders
 *     -> compare -> resolve -> mark complete -> only then trade
 *
 * The rules that matter:
 *   - any failed or unusable exchange query leaves the barrier CLOSED;
 *   - "we could not determine" is recorded as unknown, never as absent;
 *   - the result is a pure function of the inputs, so running it twice produces
 *     the same reconciled state and never duplicates a position, order or fill.
 */

export type DiscrepancyKind =
  /** Exchange reports a position we have no local record of. */
  | 'position_unknown_locally'
  /** We hold a local position the exchange does not report. */
  | 'position_missing_on_exchange'
  /** Exchange reports an open order we have no local record of. */
  | 'order_unknown_locally'
  /** We think it is open; the exchange says it reached a terminal state. */
  | 'order_terminal_on_exchange'
  /** Order filled in part while we were gone. */
  | 'order_partially_filled'
  /** Exchange answered, but the answer was not usable. */
  | 'unusable_response'
  /** Exchange query failed outright. */
  | 'query_failed';

export interface Discrepancy {
  kind: DiscrepancyKind;
  /** Symbol when known. */
  symbol?: string;
  /** Local identifier when known. */
  localId?: string;
  /** Exchange identifier when known. */
  exchangeId?: string;
  detail: string;
  /**
   * Whether this discrepancy leaves state UNKNOWN. Unknown state keeps the
   * barrier closed; a resolved difference (we simply adopt the exchange) does
   * not.
   */
  blocking: boolean;
}

export interface LocalOrderView {
  id: string;
  exchangeOrderId?: string | null;
  clientOrderId?: string | null;
  symbol: string;
  amount: number;
  filled: number;
  status: string;
}

export interface LocalPositionView {
  id: string;
  symbol: string;
  quantity: number;
}

export interface ReconciledPosition {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  marginUsed: number;
  unrealizedPnl: number;
  /** Present locally before reconciliation. */
  knownLocally: boolean;
}

export interface ReconciledOrder {
  exchangeOrderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  filled: number;
  remaining: number;
  status: string;
  knownLocally: boolean;
}

export interface ReconciliationReport {
  /** True only when every query succeeded and nothing is left unknown. */
  complete: boolean;
  startedAt: number;
  finishedAt: number;
  balancesAvailable: boolean;
  positions: ReconciledPosition[];
  orders: ReconciledOrder[];
  discrepancies: Discrepancy[];
  /** Set when the barrier stays closed. */
  blockedReason?: string;
}

export interface ReconcilerExchange {
  fetchBalance?: () => Promise<any>;
  fetchPositions?: (symbols?: string[]) => Promise<any>;
  fetchOpenOrders?: (symbol?: string) => Promise<any>;
}

export interface ReconcileInput {
  exchange: ReconcilerExchange | null;
  localOrders: LocalOrderView[];
  localPositions: LocalPositionView[];
  /** Injected for deterministic tests. */
  now?: () => number;
}

const TERMINAL_STATUSES = new Set(['closed', 'filled', 'canceled', 'cancelled', 'expired', 'rejected']);

function isOpenLocally(status: string): boolean {
  const s = (status || '').toLowerCase();
  return s === 'open' || s === 'pending';
}

export async function reconcileAtStartup(input: ReconcileInput): Promise<ReconciliationReport> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const discrepancies: Discrepancy[] = [];
  const positions: ReconciledPosition[] = [];
  const orders: ReconciledOrder[] = [];

  if (!input.exchange) {
    return {
      complete: false,
      startedAt,
      finishedAt: now(),
      balancesAvailable: false,
      positions,
      orders,
      discrepancies: [
        { kind: 'query_failed', detail: 'no exchange connection available', blocking: true },
      ],
      blockedReason: 'exchange_unavailable',
    };
  }

  // --- balances ---------------------------------------------------------
  let balancesAvailable = false;
  try {
    const balance = input.exchange.fetchBalance ? await input.exchange.fetchBalance() : null;
    if (balance && typeof balance === 'object') balancesAvailable = true;
    else
      discrepancies.push({
        kind: 'unusable_response',
        detail: 'balance response was not usable',
        blocking: true,
      });
  } catch (err: any) {
    discrepancies.push({
      kind: 'query_failed',
      detail: `fetchBalance failed: ${err?.message ?? 'unknown error'}`,
      blocking: true,
    });
  }

  // --- positions --------------------------------------------------------
  let exchangePositions: any[] | null = null;
  try {
    const raw = input.exchange.fetchPositions ? await input.exchange.fetchPositions() : null;
    if (Array.isArray(raw)) exchangePositions = raw;
    else
      discrepancies.push({
        kind: 'unusable_response',
        detail: 'position response was not an array',
        blocking: true,
      });
  } catch (err: any) {
    discrepancies.push({
      kind: 'query_failed',
      detail: `fetchPositions failed: ${err?.message ?? 'unknown error'}`,
      blocking: true,
    });
  }

  if (exchangePositions) {
    const localBySymbol = new Map(input.localPositions.map((p) => [p.symbol, p]));

    for (const pos of exchangePositions) {
      const symbol = typeof pos?.symbol === 'string' ? pos.symbol : null;
      const quantity = Math.abs(Number(pos?.contracts ?? pos?.contractSize ?? 0));
      if (!symbol) {
        discrepancies.push({
          kind: 'unusable_response',
          detail: 'position entry without a symbol',
          blocking: true,
        });
        continue;
      }
      if (!(quantity > 0)) continue;

      const local = localBySymbol.get(symbol);
      positions.push({
        symbol,
        side: pos?.side === 'short' ? 'short' : 'long',
        quantity,
        entryPrice: Number(pos?.entryPrice) || 0,
        markPrice: Number(pos?.markPrice) || Number(pos?.entryPrice) || 0,
        leverage: Number(pos?.leverage) || 1,
        marginUsed: Number(pos?.initialMargin) || 0,
        unrealizedPnl: Number(pos?.unrealizedPnl) || 0,
        knownLocally: !!local,
      });

      if (!local) {
        // Adopting the exchange resolves this: we now track real exposure.
        discrepancies.push({
          kind: 'position_unknown_locally',
          symbol,
          detail: `exchange reports ${quantity} ${symbol} with no local record; adopting exchange state`,
          blocking: false,
        });
      }
    }

    const exchangeSymbols = new Set(positions.map((p) => p.symbol));
    for (const local of input.localPositions) {
      if (!exchangeSymbols.has(local.symbol) && Math.abs(local.quantity) > 0) {
        // Could be a position closed while we were down, or a filtered
        // response. We cannot tell, so it stays unknown and blocks.
        discrepancies.push({
          kind: 'position_missing_on_exchange',
          symbol: local.symbol,
          localId: local.id,
          detail: `local position ${local.symbol} not present in exchange response; state unknown`,
          blocking: true,
        });
      }
    }
  }

  // --- open orders ------------------------------------------------------
  let exchangeOrders: any[] | null = null;
  try {
    const raw = input.exchange.fetchOpenOrders ? await input.exchange.fetchOpenOrders() : null;
    if (Array.isArray(raw)) exchangeOrders = raw;
    else
      discrepancies.push({
        kind: 'unusable_response',
        detail: 'open order response was not an array',
        blocking: true,
      });
  } catch (err: any) {
    discrepancies.push({
      kind: 'query_failed',
      detail: `fetchOpenOrders failed: ${err?.message ?? 'unknown error'}`,
      blocking: true,
    });
  }

  if (exchangeOrders) {
    const localByExchangeId = new Map(
      input.localOrders.filter((o) => o.exchangeOrderId).map((o) => [String(o.exchangeOrderId), o])
    );
    const localByClientId = new Map(
      input.localOrders.filter((o) => o.clientOrderId).map((o) => [String(o.clientOrderId), o])
    );

    for (const ord of exchangeOrders) {
      const exchangeOrderId = ord?.id != null ? String(ord.id) : null;
      if (!exchangeOrderId) {
        discrepancies.push({
          kind: 'unusable_response',
          detail: 'open order entry without an id',
          blocking: true,
        });
        continue;
      }
      const clientOrderId = ord?.clientOrderId != null ? String(ord.clientOrderId) : null;
      const local =
        localByExchangeId.get(exchangeOrderId) ??
        (clientOrderId ? localByClientId.get(clientOrderId) : undefined);

      const amount = Number(ord?.amount) || 0;
      const filled = Number(ord?.filled) || 0;
      orders.push({
        exchangeOrderId,
        clientOrderId,
        symbol: String(ord?.symbol ?? local?.symbol ?? ''),
        side: ord?.side === 'sell' ? 'sell' : 'buy',
        amount,
        filled,
        remaining: Math.max(0, amount - filled),
        status: String(ord?.status ?? 'open'),
        knownLocally: !!local,
      });

      if (!local) {
        // An order we did not place (or lost the record of) is live capital
        // risk we cannot attribute. It must be reviewed, not traded around.
        discrepancies.push({
          kind: 'order_unknown_locally',
          symbol: String(ord?.symbol ?? ''),
          exchangeId: exchangeOrderId,
          detail: `exchange reports open order ${exchangeOrderId} with no local record`,
          blocking: true,
        });
      } else if (filled > local.filled) {
        discrepancies.push({
          kind: 'order_partially_filled',
          symbol: local.symbol,
          localId: local.id,
          exchangeId: exchangeOrderId,
          detail: `order filled ${filled} on exchange vs ${local.filled} locally; adopting exchange state`,
          blocking: false,
        });
      }
    }

    const openExchangeIds = new Set(orders.map((o) => o.exchangeOrderId));
    const openClientIds = new Set(orders.map((o) => o.clientOrderId).filter((v): v is string => !!v));
    for (const local of input.localOrders) {
      if (!isOpenLocally(local.status)) continue;
      const presentOnExchange =
        (local.exchangeOrderId && openExchangeIds.has(String(local.exchangeOrderId))) ||
        (local.clientOrderId && openClientIds.has(String(local.clientOrderId)));
      if (presentOnExchange) continue;

      // No longer open on the exchange: filled, canceled or expired while we
      // were down. Which one — and therefore what position it left — is not
      // knowable from the open-orders list alone.
      discrepancies.push({
        kind: 'order_terminal_on_exchange',
        symbol: local.symbol,
        localId: local.id,
        exchangeId: local.exchangeOrderId ? String(local.exchangeOrderId) : undefined,
        detail: `locally open order ${local.id} is not open on the exchange; final state unknown`,
        blocking: true,
      });
    }
  }

  const blocking = discrepancies.filter((d) => d.blocking);
  const complete = balancesAvailable && !!exchangePositions && !!exchangeOrders && blocking.length === 0;

  return {
    complete,
    startedAt,
    finishedAt: now(),
    balancesAvailable,
    positions,
    orders,
    discrepancies,
    blockedReason: complete
      ? undefined
      : blocking.length > 0
        ? `${blocking.length} unresolved discrepancy(ies): ${blocking[0].kind}`
        : 'exchange state could not be established',
  };
}

/** Terminal statuses, exported for callers adopting reconciled order state. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has((status || '').toLowerCase());
}
