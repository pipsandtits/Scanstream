/**
 * Fill accounting.
 *
 * The engine previously derived executed quantity, average price and slippage
 * ad hoc from whatever the last exchange snapshot happened to contain. That
 * produced several concrete errors:
 *
 *   - order updates were only applied when `status` changed, so growing
 *     partial fills on an order that stayed `open` were never accumulated;
 *   - average price was computed as `cost / max(1, filled)`, which silently
 *     returns the raw cost (not a price) whenever filled < 1 — i.e. for every
 *     BTC-sized order;
 *   - fees were captured once at placement and never updated as fills arrived,
 *     and multi-currency fees were collapsed onto a single number;
 *   - slippage was recorded as a hard-coded 0.
 *
 * This module is the single place where fills are turned into state. It is
 * deliberately pure and idempotent: applying the same exchange trade twice, or
 * applying trades out of order, must not change the result. That is what makes
 * restart/late-fill/duplicate-event reconciliation safe.
 */

export interface ExchangeFill {
  /** Exchange trade id. The idempotency key — required. */
  id: string;
  /** Fill quantity in base units. */
  amount: number;
  /** Fill price. */
  price: number;
  /** Exchange-reported cost. Derived from amount*price when absent. */
  cost?: number;
  fee?: { cost?: number | string | null; currency?: string | null } | null;
  /** Maker/taker, when the exchange reports it. */
  takerOrMaker?: 'taker' | 'maker' | null;
  timestamp?: number | null;
}

export interface FeeTotal {
  currency: string;
  cost: number;
}

export interface FillAccount {
  /** Applied trade ids, for idempotency across restarts. */
  fillIds: string[];
  /** Total executed base quantity. */
  filled: number;
  /** Total quote cost of the executed quantity. */
  cost: number;
  /** Volume-weighted average execution price. Null while nothing is filled. */
  avgPrice: number | null;
  /** Requested amount minus executed amount, floored at 0. */
  remaining: number;
  /** Fees kept per currency — never summed across currencies. */
  fees: FeeTotal[];
  makerFilled: number;
  takerFilled: number;
  /** Latest fill timestamp seen. */
  lastFillAt: number | null;
}

export function createFillAccount(): FillAccount {
  return {
    fillIds: [],
    filled: 0,
    cost: 0,
    avgPrice: null,
    remaining: 0,
    fees: [],
    makerFilled: 0,
    takerFilled: 0,
    lastFillAt: null,
  };
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A fill we cannot trust is not silently treated as zero — it is reported. */
export type FillRejectReason = 'missing_id' | 'invalid_amount' | 'invalid_price' | 'duplicate';

export interface ApplyFillsResult {
  account: FillAccount;
  applied: number;
  rejected: Array<{ fill: ExchangeFill; reason: FillRejectReason }>;
}

/**
 * Fold exchange fills into an account. Pure: returns a new account.
 *
 * `requestedAmount` is the amount we asked the exchange for, used only for
 * `remaining` — we never infer executed quantity from it.
 */
export function applyFills(
  account: FillAccount,
  fills: ExchangeFill[],
  requestedAmount: number
): ApplyFillsResult {
  const seen = new Set(account.fillIds);
  const next: FillAccount = {
    ...account,
    fillIds: [...account.fillIds],
    fees: account.fees.map((f) => ({ ...f })),
  };
  const rejected: ApplyFillsResult['rejected'] = [];
  let applied = 0;

  for (const fill of fills) {
    if (!fill || typeof fill.id !== 'string' || fill.id === '') {
      rejected.push({ fill, reason: 'missing_id' });
      continue;
    }
    if (seen.has(fill.id)) {
      // Duplicate delivery (websocket replay, poll overlap, restart) is
      // expected, not an error condition.
      rejected.push({ fill, reason: 'duplicate' });
      continue;
    }
    const amount = toNumber(fill.amount);
    if (!isPositiveFinite(amount)) {
      rejected.push({ fill, reason: 'invalid_amount' });
      continue;
    }
    const price = toNumber(fill.price);
    if (!isPositiveFinite(price)) {
      rejected.push({ fill, reason: 'invalid_price' });
      continue;
    }

    const cost = toNumber(fill.cost);
    // Trust the exchange's cost when it is sane; otherwise derive it.
    const fillCost = isPositiveFinite(cost) ? cost : amount * price;

    seen.add(fill.id);
    next.fillIds.push(fill.id);
    next.filled += amount;
    next.cost += fillCost;
    applied += 1;

    if (fill.takerOrMaker === 'maker') next.makerFilled += amount;
    else if (fill.takerOrMaker === 'taker') next.takerFilled += amount;

    const feeCost = toNumber(fill.fee?.cost);
    if (feeCost !== null && feeCost !== 0) {
      const currency = String(fill.fee?.currency || 'UNKNOWN').toUpperCase();
      const bucket = next.fees.find((f) => f.currency === currency);
      if (bucket) bucket.cost += feeCost;
      else next.fees.push({ currency, cost: feeCost });
    }

    const ts = toNumber(fill.timestamp);
    // Out-of-order arrival must not rewind the watermark.
    if (ts !== null && (next.lastFillAt === null || ts > next.lastFillAt)) next.lastFillAt = ts;
  }

  next.avgPrice = next.filled > 0 ? next.cost / next.filled : null;
  const requested = toNumber(requestedAmount) ?? 0;
  next.remaining = Math.max(0, requested - next.filled);

  return { account: next, applied, rejected };
}

/**
 * Slippage of the actual execution against the price the decision was made on,
 * in percent, signed so that a worse-than-requested execution is positive.
 * Returns null when it cannot be computed — callers must not substitute 0.
 */
export function computeSlippagePct(
  requestedPrice: number | null | undefined,
  avgPrice: number | null | undefined,
  side: 'buy' | 'sell'
): number | null {
  const req = toNumber(requestedPrice);
  const avg = toNumber(avgPrice);
  if (!isPositiveFinite(req) || !isPositiveFinite(avg)) return null;
  const raw = ((avg - req) / req) * 100;
  return side === 'buy' ? raw : -raw;
}

/**
 * Realized PnL of a closing execution, net of the fees charged in the quote
 * currency. Fees denominated in another currency are returned separately rather
 * than converted at a guessed rate.
 */
export function realizedPnl(params: {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees: FeeTotal[];
  quoteCurrency: string;
}): { gross: number; net: number; unconvertedFees: FeeTotal[] } {
  const { side, entryPrice, exitPrice, quantity } = params;
  const direction = side === 'long' ? 1 : -1;
  const gross = (exitPrice - entryPrice) * quantity * direction;

  const quote = params.quoteCurrency.toUpperCase();
  let quoteFees = 0;
  const unconvertedFees: FeeTotal[] = [];
  for (const fee of params.fees) {
    if (fee.currency.toUpperCase() === quote) quoteFees += fee.cost;
    else unconvertedFees.push({ ...fee });
  }

  return { gross, net: gross - quoteFees, unconvertedFees };
}

/**
 * Terminal state classification. `canceled` with partial fills is a real
 * position, so it is reported distinctly from a clean cancel.
 */
export type OrderOutcome =
  | 'unfilled'
  | 'partially_filled'
  | 'filled'
  | 'canceled_unfilled'
  | 'canceled_partially_filled';

export function classifyOutcome(
  exchangeStatus: string | null | undefined,
  account: FillAccount,
  requestedAmount: number
): OrderOutcome {
  const status = (exchangeStatus || '').toLowerCase();
  const terminalCancel = status === 'canceled' || status === 'cancelled' || status === 'expired' || status === 'rejected';
  const filled = account.filled;
  // Exchanges report tiny residuals; treat <=1e-9 of the request as complete.
  const complete = requestedAmount > 0 && filled >= requestedAmount - Math.max(1e-12, requestedAmount * 1e-9);

  if (terminalCancel) return filled > 0 ? 'canceled_partially_filled' : 'canceled_unfilled';
  if (complete || status === 'closed' && filled > 0 && account.remaining === 0) return 'filled';
  if (filled > 0) return 'partially_filled';
  return 'unfilled';
}
