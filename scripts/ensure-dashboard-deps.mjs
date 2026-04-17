#!/usr/bin/env node
// Ensures dashboard/node_modules exists before running tests.
//
// vitest.config.ts includes `dashboard/src/**/__tests__/**/*.test.ts` in
// the root test suite. Those tests import from dashboard/node_modules
// (better-sqlite3, next/server, etc.), which the root `npm install` does
// NOT populate. CI installs them in a separate step
// (`npm ci --prefix dashboard`); this script keeps local `npm test` in
// sync so a fresh clone + `npm install` + `npm test` passes without the
// contributor having to know about the two-package-lockfile layout.

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

if (!existsSync('dashboard/node_modules')) {
  console.log('[ensure-dashboard-deps] dashboard/node_modules missing — installing …');
  execSync('npm install --prefix dashboard', { stdio: 'inherit' });
}
