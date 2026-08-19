import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { durabilityGate, DURABILITY_PROBE_TTL_MS } from '../durability-gate';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe('durability gate', () => {
  beforeEach(() => {
    durabilityGate.reset();
    process.env.DATABASE_URL = 'postgresql://user:pw@localhost:5432/scanstream';
  });

  afterEach(() => {
    durabilityGate.reset();
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it('is not durable when DATABASE_URL is absent, without probing', async () => {
    delete process.env.DATABASE_URL;
    const probe = vi.fn().mockResolvedValue(true);
    durabilityGate.setProbe(probe);

    const status = await durabilityGate.check();

    expect(status.durable).toBe(false);
    expect(status.reason).toBe('database_url_missing');
    expect(probe).not.toHaveBeenCalled();
  });

  it('is not durable when no probe is registered', async () => {
    const status = await durabilityGate.check();
    expect(status.durable).toBe(false);
    expect(status.reason).toBe('probe_failed');
  });

  it('is durable when the probe confirms the database', async () => {
    durabilityGate.setProbe(vi.fn().mockResolvedValue(true));
    const status = await durabilityGate.check();
    expect(status.durable).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  it('is not durable when the database is unavailable', async () => {
    durabilityGate.setProbe(vi.fn().mockResolvedValue(false));
    const status = await durabilityGate.check();
    expect(status.durable).toBe(false);
    expect(status.reason).toBe('database_unavailable');
  });

  it('treats a throwing probe as not durable rather than assuming health', async () => {
    durabilityGate.setProbe(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const status = await durabilityGate.check();
    expect(status.durable).toBe(false);
    expect(status.reason).toBe('probe_failed');
    expect(status.detail).toContain('ECONNREFUSED');
  });

  it('caches a healthy result for the probe TTL and re-probes afterwards', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    durabilityGate.setProbe(probe);

    const t0 = 1_000_000;
    await durabilityGate.check(t0);
    await durabilityGate.check(t0 + DURABILITY_PROBE_TTL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(1);

    await durabilityGate.check(t0 + DURABILITY_PROBE_TTL_MS + 1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('never caches an unhealthy result', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    durabilityGate.setProbe(probe);

    const t0 = 2_000_000;
    await durabilityGate.check(t0);
    await durabilityGate.check(t0 + 1);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('notices a database that disappears after a healthy check', async () => {
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    durabilityGate.setProbe(probe);

    const t0 = 3_000_000;
    expect((await durabilityGate.check(t0)).durable).toBe(true);
    expect((await durabilityGate.check(t0 + DURABILITY_PROBE_TTL_MS + 1)).durable).toBe(false);
  });

  it('shares one probe between concurrent checks instead of stampeding', async () => {
    let resolveProbe: (v: boolean) => void = () => {};
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        })
    );
    durabilityGate.setProbe(probe);

    const checks = Promise.all([durabilityGate.check(), durabilityGate.check(), durabilityGate.check()]);
    resolveProbe(true);
    const results = await checks;

    expect(probe).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.durable)).toBe(true);
  });

  it('invalidate() marks state non-durable after a failed durable write', async () => {
    durabilityGate.setProbe(vi.fn().mockResolvedValue(true));
    expect((await durabilityGate.check()).durable).toBe(true);

    durabilityGate.invalidate('createTrade failed');

    const status = durabilityGate.peek();
    expect(status?.durable).toBe(false);
    expect(status?.reason).toBe('persistence_failure');
  });

  it('allows test/paper mode to run on non-durable storage', async () => {
    delete process.env.DATABASE_URL;
    const status = await durabilityGate.requireForLive(true);
    expect(status.durable).toBe(true);
  });

  it('requires durability for live mode', async () => {
    delete process.env.DATABASE_URL;
    const status = await durabilityGate.requireForLive(false);
    expect(status.durable).toBe(false);
    expect(status.reason).toBe('database_url_missing');
  });
});
