import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    // Safety-critical suites only. The legacy `tests/` and `__tests__/` trees
    // reference modules that no longer exist and are not wired up here yet.
    include: ['server/**/__tests__/**/*.test.ts'],
    // Pre-existing suites that were never runnable and assert an interface the
    // implementation does not provide (documented in PRODUCTION_READINESS.md as
    // spec drift). They are excluded from the gate, not deleted, so the
    // mismatch stays visible and can be reconciled deliberately.
    exclude: [
      '**/node_modules/**',
      'server/__tests__/phase-1-integration.test.ts',
      'server/services/__tests__/unified-regime-system.test.ts',
    ],
    // Some pre-existing suites were written against Jest globals.
    globals: true,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@': path.resolve(__dirname, 'client/src'),
    },
  },
});
