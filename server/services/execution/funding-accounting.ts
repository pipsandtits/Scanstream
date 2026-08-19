import fs from 'fs';
import path from 'path';

export const FUNDING_STATE_SCHEMA_VERSION = 1;

export interface FundingPayment {
  id: string;
  symbol: string;
  amount: number;
  currency: string;
  timestamp: number;
}

interface FundingState {
  schemaVersion: number;
  writtenAt: string;
  payments: FundingPayment[];
  lastCheckedAt: Record<string, number>;
}

export type FundingLoadResult =
  | { status: 'absent' }
  | { status: 'ok'; state: FundingState }
  | { status: 'unreadable'; reason: string };

export type FundingAccountingResult =
  | { status: 'not_required'; payments: FundingPayment[] }
  | { status: 'known'; payments: FundingPayment[] }
  | { status: 'unknown'; reason: string; payments: FundingPayment[] };

export interface FundingAccountingOptions {
  filePath?: string;
  clock?: () => number;
}

const DEFAULT_FILE_PATH = path.join(process.cwd(), 'data', 'funding-accounting.json');

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function marketType(exchange: any, symbol: string): string | null {
  const market = exchange?.markets?.[symbol];
  if (!market) return null;
  if (market.type) return String(market.type).toLowerCase();
  if (market.info?.contractType) return String(market.info.contractType).toLowerCase();
  return null;
}

function isSpotMarket(exchange: any, symbol: string): boolean {
  const market = exchange?.markets?.[symbol];
  return market?.type === 'spot' || market?.spot === true;
}

function isSwapMarket(exchange: any, symbol: string): boolean {
  const market = exchange?.markets?.[symbol];
  const contractType = String(market?.info?.contractType ?? '').toLowerCase();
  return (
    marketType(exchange, symbol) === 'swap' ||
    market?.swap === true ||
    contractType === 'perpetual' ||
    contractType === 'swap'
  );
}

export class FundingAccounting {
  private readonly filePath: string;
  private readonly clock: () => number;
  private state: FundingState = {
    schemaVersion: FUNDING_STATE_SCHEMA_VERSION,
    writtenAt: new Date(0).toISOString(),
    payments: [],
    lastCheckedAt: {},
  };

  constructor(options: FundingAccountingOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_FILE_PATH;
    this.clock = options.clock ?? Date.now;
  }

  getPath(): string {
    return this.filePath;
  }

  load(): FundingLoadResult {
    if (!fs.existsSync(this.filePath)) {
      this.state = {
        schemaVersion: FUNDING_STATE_SCHEMA_VERSION,
        writtenAt: new Date(0).toISOString(),
        payments: [],
        lastCheckedAt: {},
      };
      return { status: 'absent' };
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!this.isValidState(parsed)) {
        return { status: 'unreadable', reason: 'unknown or invalid funding state schema' };
      }
      this.state = parsed;
      return { status: 'ok', state: parsed };
    } catch (error: any) {
      return {
        status: 'unreadable',
        reason: error?.message ? String(error.message) : 'funding state could not be parsed',
      };
    }
  }

  async reconcile(exchange: any, symbol: string): Promise<FundingAccountingResult> {
    if (isSpotMarket(exchange, symbol)) return { status: 'not_required', payments: [] };
    if (!isSwapMarket(exchange, symbol)) return { status: 'unknown', reason: 'market_type_unknown', payments: [] };
    if (typeof exchange?.fetchFundingHistory !== 'function') {
      return { status: 'unknown', reason: 'funding_history_unsupported', payments: [] };
    }

    const since = this.state.lastCheckedAt[symbol] ?? this.clock() - 24 * 60 * 60 * 1000;
    let rows: any[];
    try {
      const response = await exchange.fetchFundingHistory(symbol, since, 200);
      if (!Array.isArray(response)) return { status: 'unknown', reason: 'funding_history_unusable', payments: [] };
      rows = response;
    } catch (error: any) {
      return {
        status: 'unknown',
        reason: error?.message ? `funding_history_query_failed:${error.message}` : 'funding_history_query_failed',
        payments: [],
      };
    }

    const additions: FundingPayment[] = [];
    for (const row of rows) {
      const id = row?.id ?? row?.info?.id ?? row?.info?.paymentId;
      const amount = row?.amount ?? row?.cost ?? row?.info?.amount;
      const currency = row?.currency ?? row?.info?.currency;
      const timestamp = row?.timestamp ?? (row?.datetime ? Date.parse(row.datetime) : null);
      if (typeof id !== 'string' && typeof id !== 'number') {
        return { status: 'unknown', reason: 'funding_payment_id_unknown', payments: additions };
      }
      if (!finite(Number(amount)) || typeof currency !== 'string' || !currency || !finite(Number(timestamp))) {
        return { status: 'unknown', reason: 'funding_payment_fields_unknown', payments: additions };
      }
      const payment: FundingPayment = {
        id: String(id),
        symbol,
        amount: Number(amount),
        currency: currency.toUpperCase(),
        timestamp: Number(timestamp),
      };
      if (!this.state.payments.some((existing) => existing.id === payment.id)) additions.push(payment);
    }

    const paymentState = [...this.state.payments, ...additions];
    const next: FundingState = {
      schemaVersion: FUNDING_STATE_SCHEMA_VERSION,
      writtenAt: new Date(this.clock()).toISOString(),
      payments: paymentState,
      lastCheckedAt: { ...this.state.lastCheckedAt, [symbol]: this.clock() },
    };
    try {
      this.write(next);
      this.state = next;
    } catch {
      return { status: 'unknown', reason: 'funding_state_persistence_failed', payments: additions };
    }
    return { status: 'known', payments: additions };
  }

  payments(): FundingPayment[] {
    return this.state.payments.map((payment) => ({ ...payment }));
  }

  private write(next: FundingState): void {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${this.clock()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      const fd = fs.openSync(temporaryPath, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporaryPath, this.filePath);
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The previous funding state remains authoritative if cleanup fails.
      }
      throw error;
    }
  }

  private isValidState(value: unknown): value is FundingState {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<FundingState>;
    return (
      state.schemaVersion === FUNDING_STATE_SCHEMA_VERSION &&
      typeof state.writtenAt === 'string' &&
      Array.isArray(state.payments) &&
      !!state.lastCheckedAt &&
      typeof state.lastCheckedAt === 'object' &&
      Object.values(state.lastCheckedAt).every((timestamp) => finite(timestamp)) &&
      state.payments.every((payment) =>
        payment &&
        typeof payment.id === 'string' &&
        typeof payment.symbol === 'string' &&
        finite(payment.amount) &&
        typeof payment.currency === 'string' &&
        finite(payment.timestamp)
      )
    );
  }
}

export default FundingAccounting;
