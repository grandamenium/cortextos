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
    // On Windows, vitest's default thread pool causes interference between
    // files that use vi.useFakeTimers() and perf-budget tests under load
    // (heartbeat watchdog, p95 latency assertions, concurrent disk writes).
    // Forks give each file its own process and reduce cross-file contention.
    // On other platforms we keep the default thread pool (faster).
    ...(process.platform === 'win32'
      ? {
          pool: 'forks' as const,
          // Throttle parallelism on Windows. Default would be 1-per-core which
          // overwhelms the I/O subsystem when multiple integration tests do
          // heavy disk work concurrently.
          poolOptions: { forks: { maxForks: 2, minForks: 1 } },
        }
      : {}),
  },
});
