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
    // Strip inherited agent-session env (CTX_*) and git hook env (GIT_DIR etc.)
    // so `npm test` behaves the same inside an agent PTY or a git hook as in a
    // plain shell, and can never touch the enclosing repository.
    setupFiles: ['tests/setup-isolate-env.ts'],
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
    ],
  },
});
