import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeRealizedClosePnl,
  RealizedPnlLedger,
} from '../realized-pnl-ledger';

function ledgerPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scanstream-realized-')), 'ledger.json');
}

describe('realized PnL ledger', () => {
  it('computes long and short closes with quote fees', () => {
    const long = computeRealizedClosePnl({
      side: 'long',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 2,
      fees: [{ currency: 'USDT', cost: 3 }],
      quoteCurrency: 'USDT',
    });
    const short = computeRealizedClosePnl({
      side: 'short',
      entryPrice: 100,
      exitPrice: 90,
      quantity: 1,
      fees: [],
      quoteCurrency: 'USDT',
    });

    expect(long).toMatchObject({ grossPnl: 20, pnl: 17, quoteFees: 3 });
    expect(short).toMatchObject({ grossPnl: 10, pnl: 10 });
  });

  it('reports non-quote fees without inventing a conversion', () => {
    const result = computeRealizedClosePnl({
      side: 'long',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 1,
      fees: [{ currency: 'BNB', cost: 0.01 }],
      quoteCurrency: 'USDT',
    });
    expect(result.pnl).toBe(10);
    expect(result.unconvertedFees).toEqual([{ currency: 'BNB', cost: 0.01 }]);
  });

  it('keeps unknown arithmetic unknown', () => {
    expect(computeRealizedClosePnl({
      side: 'long',
      entryPrice: null,
      exitPrice: 110,
      quantity: 1,
      fees: [],
      quoteCurrency: 'USDT',
    }).pnl).toBeNull();
  });

  it('persists entries, survives reload, and deduplicates IDs', () => {
    const filePath = ledgerPath();
    const first = new RealizedPnlLedger({ filePath, clock: () => 1_700_000_000_000 });
    expect(first.load().status).toBe('absent');
    expect(first.append({
      id: 'close-1',
      category: 'trade',
      at: new Date(1_700_000_000_000).toISOString(),
      symbol: 'BTC/USDT',
      quoteCurrency: 'USDT',
      pnl: 12,
      grossPnl: 13,
      quoteFees: 1,
      unconvertedFees: [],
    })).toBe(true);
    expect(first.append({
      id: 'close-1',
      category: 'trade',
      at: new Date(1_700_000_000_000).toISOString(),
      symbol: 'BTC/USDT',
      quoteCurrency: 'USDT',
      pnl: 12,
      grossPnl: 13,
      quoteFees: 1,
      unconvertedFees: [],
    })).toBe(false);

    const second = new RealizedPnlLedger({ filePath, clock: () => 1_700_000_000_000 });
    expect(second.load().status).toBe('ok');
    expect(second.summary().pnl).toBe(12);
  });

  it('treats corrupt state as unreadable', () => {
    const filePath = ledgerPath();
    fs.writeFileSync(filePath, '{truncated');
    expect(new RealizedPnlLedger({ filePath }).load()).toMatchObject({ status: 'unreadable' });
  });

  it('returns unknown daily totals when an entry is unknown', () => {
    const filePath = ledgerPath();
    const ledger = new RealizedPnlLedger({ filePath, clock: () => 1_700_000_000_000 });
    ledger.load();
    ledger.append({
      id: 'unknown-close',
      category: 'trade',
      at: new Date(1_700_000_000_000).toISOString(),
      symbol: 'BTC/USDT',
      quoteCurrency: 'USDT',
      pnl: null,
      grossPnl: null,
      quoteFees: null,
      unconvertedFees: [],
    });
    expect(ledger.summary().pnl).toBeNull();
    expect(ledger.summary().unknown).toBe(true);
  });
});
