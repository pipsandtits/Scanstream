/**
 * Route-level coverage for the health router, which was restored from the
 * disabled block in server/index.ts. Readiness is the endpoint an operator uses
 * to decide whether storage is durable, so it must fail (503) rather than
 * report a comforting 200 when it is not, and it must never publish
 * connectivity it has not observed.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { AddressInfo } from 'net';

vi.mock('../../db-storage', () => ({
  db: {
    isDatabaseConnected: () => (process.env.__TEST_DB_CONNECTED === 'true'),
  },
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const healthRouter = (await import('../health')).default;
  const app = express();
  app.use('/api/health', healthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
});

afterAll(async () => {
  delete process.env.__TEST_DB_CONNECTED;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('health router', () => {
  it('mounts and answers the informational endpoint', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.health.system.uptime).toBeGreaterThan(0);
  });

  it('does not claim exchange connectivity or data freshness it never probed', async () => {
    const body = await (await fetch(base)).json();
    expect(body.health.exchanges.status).toBe('unknown');
    expect(body.health.exchanges.connectedExchanges).toBeNull();
    expect(body.health.exchanges.dataFreshness).toBeNull();

    const exchanges = await (await fetch(`${base}/exchanges`)).json();
    expect(exchanges.summary.probed).toBe(false);
    for (const exchange of exchanges.exchanges) {
      expect(exchange.status).toBe('unknown');
      expect(exchange.lastCheck).toBeNull();
    }
  });

  it('fails readiness with 503 while storage is not durable', async () => {
    process.env.__TEST_DB_CONNECTED = 'false';
    const res = await fetch(`${base}/readiness`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.status).toBe('DOWN');
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.database.detail).toContain('in-memory');
  });

  it('passes readiness once storage is durable', async () => {
    process.env.__TEST_DB_CONNECTED = 'true';
    const res = await fetch(`${base}/readiness`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.checks.database.ok).toBe(true);
  });
});
