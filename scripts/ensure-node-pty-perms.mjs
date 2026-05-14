#!/usr/bin/env node
// Standalone postinstall hook — chmod +x node-pty's spawn-helper prebuilds.
//
// Issue #07 follow-up: macOS `npm install` and `pnpm install` both
// frequently leave node-pty's prebuilt spawn-helper at 0o644 (no exec
// bit). When that happens, every pty.spawn() throws `posix_spawnp
// failed.` until something fixes the permissions. The daemon now also
// fixes this at startup (src/utils/node-pty-perms.ts), but doing it at
// install time means the daemon never sees the broken state in the
// first place.
//
// Standalone (no build dep, no TS compile) so it can run before tsup
// has produced dist/. Mirrors the logic in src/utils/node-pty-perms.ts.
// If you change that helper, mirror the change here.

import { existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'win32') {
  // Different exec model — nothing to do.
  process.exit(0);
}

// npm postinstall invokes this with cwd at the package root (where the
// node_modules being installed lives) — that's the canonical place to
// look. Same convention as `cortextos doctor` (src/cli/doctor.ts).
const rootDir = process.cwd();

const prebuildsDir = join(rootDir, 'node_modules', 'node-pty', 'prebuilds');
const buildRelease = join(rootDir, 'node_modules', 'node-pty', 'build', 'Release');

const candidates = [];
if (existsSync(prebuildsDir)) {
  try {
    for (const entry of readdirSync(prebuildsDir)) {
      candidates.push(join(prebuildsDir, entry, 'spawn-helper'));
    }
  } catch {
    // Directory disappeared mid-scan — postinstall race, ignore.
  }
}
if (existsSync(buildRelease)) {
  candidates.push(join(buildRelease, 'spawn-helper'));
}

let fixed = 0;
const errors = [];
for (const helperPath of candidates) {
  if (!existsSync(helperPath)) continue;
  try {
    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(helperPath, 0o755);
      fixed++;
    }
  } catch (e) {
    errors.push(`${helperPath}: ${e.message}`);
  }
}

if (fixed > 0) {
  console.log(`[postinstall] Fixed exec bits on ${fixed} node-pty spawn-helper binary(s)`);
}
if (errors.length > 0) {
  // Non-fatal — daemon's startup check + doctor will catch any survivors.
  console.error(`[postinstall] Could not fix ${errors.length} binary(s):\n  ${errors.join('\n  ')}`);
}
// Always exit 0 — never block an install on a permissions check.
process.exit(0);
