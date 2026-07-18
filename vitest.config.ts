import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
    // Performance integration tests measure wall-clock timing and fail under
    // test-runner load (1700+ concurrent tests competing for CPU). Excluded
    // from the default run so red means something in the default suite.
    //
    // HOW THEY GET RUN (not excluded-and-forgotten):
    //   - CI: .github/workflows/ci.yml `perf` job — runs on every push/PR on
    //     an isolated ubuntu-latest runner, plus weekly schedule (Sun 03:00 UTC).
    //   - Manually: npm run test:perf  (requires idle machine — no other load)
    //
    // If you touch dashboard/src/app/api/workflows/crons/** or
    // src/daemon/cron-execution-log.ts, the CI perf job is your gate.
    exclude: [
      'node_modules/**',
      'dist/**',
      'tests/integration/phase4-performance.test.ts',
      'tests/integration/phase5-performance.test.ts',
    ],
  },
});
