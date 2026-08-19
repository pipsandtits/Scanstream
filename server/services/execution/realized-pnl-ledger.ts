import fs from 'fs';
import path from 'path';
import { realizedPnl, type FeeTotal } from './fill-accounting';

export const REALIZED_PNL_SCHEMA_VERSION = 1;

export type RealizedPnlCategory = 'trade' | 'funding';

export interface RealizedPnlEntry {
  id: string;
  category: RealizedPnlCategory;
  at: string;
  symbol: string;
  quoteCurrency: string;
  pnl: number | null;
  grossPnl: number | null;
  quoteFees: number | null;
  unconvertedFees: FeeTotal[];
  quantity?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  fundingAmount?: number | null;
  fundingCurrency?: string | null;
}

export interface RealizedPnlState {
  schemaVersion: number;
  writtenAt: string;
  entries: RealizedPnlEntry[];
}

export type RealizedPnlLoadResult =
  | { status: 'absent' }
  | { status: 'ok'; state: RealizedPnlState }
  | { status: 'unreadable'; reason: string };

export interface RealizedPnlLedgerOptions {
  filePath?: string;
  clock?: () => number;
}

export interface RealizedPnlSummary {
  pnl: number | null;
  unknown: boolean;
  unconvertedFees: FeeTotal[];
  tradePnl: number | null;
  fundingPnl: number | null;
  entries: number;
}

export interface RealizedClosePnlInput {
  side: 'long' | 'short';
  entryPrice: number | null | undefined;
  exitPrice: number | null | undefined;
  quantity: number | null | undefined;
  fees: FeeTotal[] | null | undefined;
  quoteCurrency: string | null | undefined;
}

export interface RealizedClosePnl {
  grossPnl: number | null;
  pnl: number | null;
  quoteFees: number | null;
  unconvertedFees: FeeTotal[];
  reason?: string;
}

const DEFAULT_FILE_PATH = path.join(process.cwd(), 'data', 'realized-pnl-ledger.json');

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function dateKey(at: string): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function computeRealizedClosePnl(input: RealizedClosePnlInput): RealizedClosePnl {
  if (!positive(input.entryPrice)) return { grossPnl: null, pnl: null, quoteFees: null, unconvertedFees: [], reason: 'entry_price_unknown' };
  if (!positive(input.exitPrice)) return { grossPnl: null, pnl: null, quoteFees: null, unconvertedFees: [], reason: 'exit_price_unknown' };
  if (!positive(input.quantity)) return { grossPnl: null, pnl: null, quoteFees: null, unconvertedFees: [], reason: 'close_quantity_unknown' };
  if (!input.quoteCurrency || !Array.isArray(input.fees)) {
    return { grossPnl: null, pnl: null, quoteFees: null, unconvertedFees: [], reason: 'fee_or_quote_currency_unknown' };
  }
  if (input.fees.some((fee) => !fee || typeof fee.currency !== 'string' || !finite(fee.cost))) {
    return { grossPnl: null, pnl: null, quoteFees: null, unconvertedFees: [], reason: 'fee_record_unknown' };
  }

  const result = realizedPnl({
    side: input.side,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    quantity: input.quantity,
    fees: input.fees,
    quoteCurrency: input.quoteCurrency,
  });
  const quote = input.quoteCurrency.toUpperCase();
  const quoteFees = input.fees
    .filter((fee) => fee.currency.toUpperCase() === quote)
    .reduce((sum, fee) => sum + fee.cost, 0);
  return {
    grossPnl: result.gross,
    pnl: result.net,
    quoteFees,
    unconvertedFees: result.unconvertedFees,
  };
}

export class RealizedPnlLedger {
  private readonly filePath: string;
  private readonly clock: () => number;
  private state: RealizedPnlState = {
    schemaVersion: REALIZED_PNL_SCHEMA_VERSION,
    writtenAt: new Date(0).toISOString(),
    entries: [],
  };

  constructor(options: RealizedPnlLedgerOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_FILE_PATH;
    this.clock = options.clock ?? Date.now;
  }

  getPath(): string {
    return this.filePath;
  }

  load(): RealizedPnlLoadResult {
    if (!fs.existsSync(this.filePath)) {
      this.state = {
        schemaVersion: REALIZED_PNL_SCHEMA_VERSION,
        writtenAt: new Date(0).toISOString(),
        entries: [],
      };
      return { status: 'absent' };
    }

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!this.isValidState(parsed)) {
        return { status: 'unreadable', reason: 'unknown or invalid realized PnL schema' };
      }
      this.state = parsed;
      return { status: 'ok', state: parsed };
    } catch (error: any) {
      return {
        status: 'unreadable',
        reason: error?.message ? String(error.message) : 'realized PnL ledger could not be parsed',
      };
    }
  }

  append(entry: RealizedPnlEntry): boolean {
    if (this.state.entries.some((existing) => existing.id === entry.id)) return false;
    const nextEntries = [...this.state.entries, { ...entry, unconvertedFees: entry.unconvertedFees.map((fee) => ({ ...fee })) }];
    const next: RealizedPnlState = {
      schemaVersion: REALIZED_PNL_SCHEMA_VERSION,
      writtenAt: new Date(this.clock()).toISOString(),
      entries: nextEntries,
    };
    this.write(next);
    this.state = next;
    return true;
  }

  summary(now: number = this.clock()): RealizedPnlSummary {
    const today = new Date(now).toISOString().slice(0, 10);
    const entries = this.state.entries.filter((entry) => {
      try {
        return dateKey(entry.at) === today;
      } catch {
        return false;
      }
    });
    let pnl = 0;
    let tradePnl = 0;
    let fundingPnl = 0;
    let unknown = false;
    const unconvertedFees: FeeTotal[] = [];

    for (const entry of entries) {
      if (entry.pnl === null || !finite(entry.pnl)) unknown = true;
      else {
        pnl += entry.pnl;
        if (entry.category === 'trade') tradePnl += entry.pnl;
        else fundingPnl += entry.pnl;
      }
      for (const fee of entry.unconvertedFees) {
        const existing = unconvertedFees.find((candidate) => candidate.currency === fee.currency);
        if (existing) existing.cost += fee.cost;
        else unconvertedFees.push({ ...fee });
      }
    }

    return {
      pnl: unknown ? null : pnl,
      unknown,
      unconvertedFees,
      tradePnl: unknown ? null : tradePnl,
      fundingPnl: unknown ? null : fundingPnl,
      entries: entries.length,
    };
  }

  entries(): RealizedPnlEntry[] {
    return this.state.entries.map((entry) => ({
      ...entry,
      unconvertedFees: entry.unconvertedFees.map((fee) => ({ ...fee })),
    }));
  }

  private write(next: RealizedPnlState): void {
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
        // The previous ledger remains authoritative if cleanup also fails.
      }
      throw error;
    }
  }

  private isValidState(value: unknown): value is RealizedPnlState {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<RealizedPnlState>;
    return (
      state.schemaVersion === REALIZED_PNL_SCHEMA_VERSION &&
      typeof state.writtenAt === 'string' &&
      Array.isArray(state.entries) &&
      state.entries.every((entry) => this.isValidEntry(entry))
    );
  }

  private isValidEntry(value: unknown): value is RealizedPnlEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<RealizedPnlEntry>;
    return (
      typeof entry.id === 'string' &&
      (entry.category === 'trade' || entry.category === 'funding') &&
      typeof entry.at === 'string' &&
      typeof entry.symbol === 'string' &&
      typeof entry.quoteCurrency === 'string' &&
      (entry.pnl === null || finite(entry.pnl)) &&
      (entry.grossPnl === null || finite(entry.grossPnl)) &&
      (entry.quoteFees === null || finite(entry.quoteFees)) &&
      Array.isArray(entry.unconvertedFees) &&
      entry.unconvertedFees.every((fee) => fee && typeof fee.currency === 'string' && finite(fee.cost))
    );
  }
}

export default RealizedPnlLedger;
