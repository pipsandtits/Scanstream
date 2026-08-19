import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FundingAccounting } from '../funding-accounting';
import { LiveTradingEngine } from '../../../live-trading-engine';

function statePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scanstream-funding-')), 'funding.json');
}

describe('funding accounting', () => {
  it('deduplicates payments by payment ID', async () => {
    const accounting = new FundingAccounting({ filePath: statePath(), clock: () => 1_700_000_000_000 });
    accounting.load();
    const exchange = {
      markets: { 'BTC/USDT:USDT': { type: 'swap' } },
      fetchFundingHistory: async () => [{
        id: 'payment-1',
        amount: -2,
        currency: 'USDT',
        timestamp: 1_700_000_000_000,
      }],
    };
    expect((await accounting.reconcile(exchange, 'BTC/USDT:USDT')).payments).toHaveLength(1);
    expect((await accounting.reconcile(exchange, 'BTC/USDT:USDT')).payments).toHaveLength(0);
    expect(accounting.payments()).toHaveLength(1);
  });

  it('refuses unsupported and failed funding queries as unknown', async () => {
    const unsupported = new FundingAccounting({ filePath: statePath() });
    unsupported.load();
    expect(await unsupported.reconcile({ markets: { BTC: { type: 'swap' } } }, 'BTC')).toMatchObject({
      status: 'unknown',
      reason: 'funding_history_unsupported',
    });

    const failed = new FundingAccounting({ filePath: statePath() });
    failed.load();
    expect(await failed.reconcile({
      markets: { BTC: { type: 'swap' } },
      fetchFundingHistory: async () => { throw new Error('exchange unavailable'); },
    }, 'BTC')).toMatchObject({ status: 'unknown' });
  });

  it('does not require funding accounting for spot markets', async () => {
    const accounting = new FundingAccounting({ filePath: statePath() });
    accounting.load();
    expect(await accounting.reconcile({
      markets: { 'BTC/USDT': { type: 'spot' } },
    }, 'BTC/USDT')).toEqual({ status: 'not_required', payments: [] });
  });

  it('allows unknown funding only through the explicit operator escape hatch', async () => {
    const accounting = new FundingAccounting({ filePath: statePath() });
    accounting.load();
    const engine = new LiveTradingEngine(
      { enabled: true, testMode: false },
      { fundingAccounting: accounting },
    );
    const internal = engine as unknown as {
      fundingLoaded: boolean;
      fundingHealthy: boolean;
      exchange: unknown;
      ensureFundingAccounted(symbol: string): Promise<boolean>;
    };
    internal.fundingLoaded = true;
    internal.fundingHealthy = true;
    internal.exchange = { markets: { BTC: { type: 'swap' } } };

    const previous = process.env.ALLOW_UNACCOUNTED_FUNDING;
    delete process.env.ALLOW_UNACCOUNTED_FUNDING;
    await expect(internal.ensureFundingAccounted('BTC')).resolves.toBe(false);
    process.env.ALLOW_UNACCOUNTED_FUNDING = '1';
    await expect(internal.ensureFundingAccounted('BTC')).resolves.toBe(true);
    if (previous === undefined) delete process.env.ALLOW_UNACCOUNTED_FUNDING;
    else process.env.ALLOW_UNACCOUNTED_FUNDING = previous;
    engine.dispose();
  });
});
