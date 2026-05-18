#!/usr/bin/env node
import { spawn } from 'node:child_process';

const shouldRun = process.env.CI === 'true' || process.env.RUN_DASHBOARD_MOBILE_SMOKE === '1';

if (!shouldRun) {
  console.log('[dashboard-mobile-smoke] skipped outside CI; set RUN_DASHBOARD_MOBILE_SMOKE=1 to run locally');
  process.exit(0);
}

if (process.platform === 'darwin' && (
  process.env.ALLOW_MAC_BROWSER_AUTOMATION !== '1' || !process.env.ORGO_FAILURE_ARTIFACT
)) {
  console.error('[dashboard-mobile-smoke] refused on macOS. Run this on CI/Codex-CU/Orgo, or set ALLOW_MAC_BROWSER_AUTOMATION=1 and ORGO_FAILURE_ARTIFACT only with an approved Mac fallback.');
  process.exit(78);
}

const env = {
  ...process.env,
  AUTH_SECRET: process.env.AUTH_SECRET || 'ci-fallback-do-not-use-in-prod',
  AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST || 'true',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'ci-fallback',
  SYNC_ADMIN_PASSWORD: process.env.SYNC_ADMIN_PASSWORD || 'true',
  NEXTAUTH_URL: process.env.NEXTAUTH_URL || 'http://localhost:39182',
  DASHBOARD_URL: process.env.DASHBOARD_URL || 'http://localhost:39182',
  CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID || 'ci-mobile-smoke',
  CTX_ROOT: process.env.CTX_ROOT || '/tmp/cortextos-ci-mobile-smoke',
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env,
      ...options,
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function waitForDashboard() {
  const url = `${env.DASHBOARD_URL}/login`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Dashboard did not become ready at ${url}`);
}

await run('npx', ['playwright', 'install', 'chromium']);
await run('npm', ['run', 'build', '--prefix', 'dashboard']);

const server = spawn('npm', ['run', 'start', '--prefix', 'dashboard', '--', '--hostname', '127.0.0.1', '--port', '39182'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});

try {
  await waitForDashboard();
  await run('npx', ['playwright', 'test', 'tests/playwright/dashboard-mobile-smoke.spec.ts']);
} finally {
  server.kill('SIGTERM');
}
