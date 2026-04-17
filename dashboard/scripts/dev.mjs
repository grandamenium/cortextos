// Dashboard dev server launcher.
//
// Why this exists:
//   On Windows, Next 16's default Turbopack dev server panics when it tries
//   to create NTFS junction points for native modules under .next/dev/node_modules.
//   `better-sqlite3` (used by the auth layer) reliably triggers this. The result
//   is HTML 500s on every API route and an unusable login flow.
//
//   Webpack does not use junction points, so on Windows we transparently fall
//   back to `next dev --webpack`. Mac/Linux keeps Turbopack speed.
//
// Escape hatches (if you want to force a mode):
//   - npm run dev:turbopack
//   - npm run dev:webpack

import { spawn } from 'node:child_process';

const useWebpack = process.platform === 'win32';
const args = useWebpack
  ? ['next', 'dev', '--webpack']
  : ['next', 'dev'];

console.log(
  `[dev.mjs] platform=${process.platform} → ${useWebpack ? 'webpack (Windows fallback)' : 'turbopack (default)'}`
);

const child = spawn('npx', args, { stdio: 'inherit', shell: true });

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('[dev.mjs] failed to spawn next dev:', err);
  process.exit(1);
});
