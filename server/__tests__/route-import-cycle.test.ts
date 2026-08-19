/**
 * Regression guard for the import-time crash that caused ~25 route groups to be
 * commented out of server/index.ts with "DISABLED FOR DEBUG".
 *
 * rl-guard constructed its singleton at module scope and read `RLConfig` from
 * rl-system-integration in the constructor. Those two modules are in an import
 * cycle, so `RLConfig` was still in its temporal dead zone and the access threw
 * `Cannot access 'RLConfig' before initialization` — optional chaining does not
 * help against a TDZ. Every router transitively importing that chain died at
 * import.
 *
 * Caveat: Vitest's module graph resolves the cycle in a different order and does
 * NOT reproduce the TDZ, so these assertions cover the lazy-config contract, not
 * the original crash. Reproduce that with `npx tsx scripts/probe-disabled-routers.ts`,
 * which mounts each formerly disabled router the way server/index.ts does.
 */

import { describe, it, expect } from 'vitest';

describe('route import cycle', () => {
  it('imports rl-guard without touching RLConfig during module init', async () => {
    const mod = await import('../rl-guard');
    expect(mod.default).toBeDefined();
    // Config is resolved lazily, so status must still report real numbers.
    const status = mod.default.getStatus();
    expect(status.minExperience).toBeGreaterThan(0);
    expect(status.threshold).toBeGreaterThan(0);
  });

  it('imports the router chain that depends on the rl-guard singleton', async () => {
    const router = (await import('../routes/trade-execution')).default;
    expect(router).toBeDefined();
    expect(Array.isArray((router as any).stack)).toBe(true);
  }, 120_000);
});
