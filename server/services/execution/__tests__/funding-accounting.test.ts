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
    let now = 1_700_000_000_000;
    const accounting = new FundingAccounting({ filePath: statePath(), clock: () => now, recheckIntervalMs: 60_000 });
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
    expect(await accounting.reconcile(exchange, 'BTC/USDT:USDT')).toMatchObject({ status: 'known' });
    now += 60_001;
    expect(await accounting.reconcile(exchange, 'BTC/USDT:USDT')).toMatchObject({ status: 'known' });
    expect(accounting.payments()).toHaveLength(1);
  });

  it('pages full responses and advances only after a short final page', async () => {
    const calls: number[] = [];
    const accounting = new FundingAccounting({
      filePath: statePath(),
      clock: () => 1_800_000_000_000,
      initialLookbackMs: 1_000,
    });
    accounting.load();
    const full = Array.from({ length: 200 }, (_, index) => ({
      id: `p-${index}`,
      amount: 1,
      currency: 'USDT',
      timestamp: 1_800_000_000_000 + index,
    }));
    const exchange = {
      markets: { BTC: { type: 'swap' } },
      fetchFundingHistory: async (_symbol: string, since: number, limit: number) => {
        calls.push(since);
        return calls.length === 1 ? full : [{ id: 'p-last', amount: 1, currency: 'USDT', timestamp: since + 1 }];
      },
    };
    const first = await accounting.reconcile(exchange, 'BTC');
    expect(first.status).toBe('unknown');
    expect(calls).toHaveLength(2);
    expect(accounting.payments()).toHaveLength(201);
    expect(calls[1]).toBeGreaterThan(calls[0]);
  });

  it('does not reuse unknown funding answers', async () => {
    let now = 1_800_000_000_000;
    let queries = 0;
    const accounting = new FundingAccounting({
      filePath: statePath(),
      clock: () => now,
      initialLookbackMs: 1_000,
      recheckIntervalMs: 60_000,
    });
    accounting.load();
    const exchange = {
      markets: { BTC: { type: 'swap' } },
      fetchFundingHistory: async () => {
        queries += 1;
        throw new Error('history unavailable');
      },
    };
    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('unknown');
    now += 1;
    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('unknown');
    expect(queries).toBe(2);
  });

  it('reuses a durable known answer only within the configured interval', async () => {
    let now = 1_800_000_000_000;
    const filePath = statePath();
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      writtenAt: new Date(now).toISOString(),
      payments: [],
      lastCheckedAt: { BTC: now - 1 },
      lastKnownAt: { BTC: now - 1 },
      initialLookbackUnknown: {},
      initialLookbackSince: {},
      baselineAttestations: {},
    }));
    const accounting = new FundingAccounting({ filePath, clock: () => now, recheckIntervalMs: 60_000 });
    expect(accounting.load().status).toBe('ok');
    let queries = 0;
    const exchange = {
      markets: { BTC: { type: 'swap' } },
      fetchFundingHistory: async () => {
        queries += 1;
        return [];
      },
    };
    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('known');
    expect(queries).toBe(0);
    now += 60_000;
    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('known');
    expect(queries).toBe(1);
  });

  it('proves initial coverage when the venue returns a short page at the boundary', async () => {
    const accounting = new FundingAccounting({
      filePath: statePath(),
      clock: () => 1_800_000_000_000,
      initialLookbackMs: 1_000,
    });
    accounting.load();
    expect(await accounting.reconcile({
      markets: { BTC: { type: 'swap' } },
      fetchFundingHistory: async () => [{
        id: 'p1',
        amount: 1,
        currency: 'USDT',
        timestamp: 1_800_000_000_000,
      }],
    }, 'BTC')).toMatchObject({ status: 'known' });
  });

  it('attests one unknown baseline and requires a new gap to block again', async () => {
    let now = 1_800_000_000_000;
    const accounting = new FundingAccounting({
      filePath: statePath(),
      clock: () => now,
      initialLookbackMs: 1_000,
      recheckIntervalMs: 0,
    });
    accounting.load();
    const full = Array.from({ length: 200 }, (_, index) => ({
      id: `p-${index}`,
      amount: 1,
      currency: 'USDT',
      timestamp: now + index,
    }));
    const calls: Record<string, number> = {};
    const exchange = {
      markets: { BTC: { type: 'swap' }, ETH: { type: 'swap' } },
      fetchFundingHistory: async (symbol: string) => {
        calls[symbol] = (calls[symbol] ?? 0) + 1;
        if (calls[symbol] <= 2) return calls[symbol] === 1 ? full : [];
        if (symbol === 'BTC' && calls[symbol] === 3) return [];
        if (symbol === 'BTC') {
          if (calls[symbol] === 4) return full;
          throw new Error('truncated history');
        }
        return [];
      },
    };

    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('unknown');
    expect((await accounting.reconcile(exchange, 'ETH')).status).toBe('unknown');
    accounting.attestInitialCoverage('BTC', 'venue export reviewed to establish baseline');
    const persisted = JSON.parse(fs.readFileSync(accounting.getPath(), 'utf8'));
    expect(persisted.initialLookbackUnknown).toMatchObject({ BTC: false, ETH: true });
    expect(persisted.baselineAttestations.BTC).toMatchObject({
      symbol: 'BTC',
      reason: 'venue export reviewed to establish baseline',
    });
    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('known');
    expect((await accounting.reconcile(exchange, 'ETH')).status).toBe('unknown');
    now += 1;
    expect((await accounting.reconcile(exchange, 'BTC')).status).toBe('unknown');
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
