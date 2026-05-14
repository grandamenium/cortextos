import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureSpawnHelperExecutable } from '../../../src/utils/node-pty-perms';

// Regression guard for issue #07 follow-up. npm install on macOS frequently
// leaves node-pty's prebuilt spawn-helper at 0o644 (no exec bit). The
// daemon now self-heals at startup via this helper; this test pins the
// exact behavior the daemon relies on.

function mkFakeNodePty(rootDir: string, archDirs: string[]): string[] {
  const created: string[] = [];
  const ptyRoot = join(rootDir, 'node_modules', 'node-pty');
  for (const arch of archDirs) {
    const archDir = join(ptyRoot, 'prebuilds', arch);
    mkdirSync(archDir, { recursive: true });
    const helper = join(archDir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\necho stub\n', 'utf-8');
    created.push(helper);
  }
  // build/Release/spawn-helper — second location the helper checks.
  const releaseDir = join(ptyRoot, 'build', 'Release');
  mkdirSync(releaseDir, { recursive: true });
  return created;
}

describe('ensureSpawnHelperExecutable', () => {
  let rootDir: string;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'cortextos-pty-perms-'));
  });
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('chmods 0o755 on a non-executable spawn-helper (the post-install failure mode)', () => {
    if (process.platform === 'win32') return; // skip — function returns skipped:true
    const [helper] = mkFakeNodePty(rootDir, ['darwin-arm64']);
    chmodSync(helper, 0o644); // simulate npm install dropping the exec bit

    const result = ensureSpawnHelperExecutable(rootDir);

    expect(result.fixed).toEqual([helper]);
    expect(result.errors).toEqual([]);
    // Owner exec bit must now be set; we don't care about exact mode beyond that.
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });

  it('leaves already-executable spawn-helper alone (idempotent)', () => {
    if (process.platform === 'win32') return;
    const [helper] = mkFakeNodePty(rootDir, ['darwin-arm64']);
    chmodSync(helper, 0o755);
    const before = statSync(helper).mode;

    const result = ensureSpawnHelperExecutable(rootDir);

    expect(result.fixed).toEqual([]);
    expect(result.alreadyOk).toEqual([helper]);
    expect(statSync(helper).mode).toBe(before);
  });

  it('fixes multiple architectures in one pass', () => {
    if (process.platform === 'win32') return;
    const helpers = mkFakeNodePty(rootDir, ['darwin-arm64', 'darwin-x64', 'linux-x64']);
    for (const h of helpers) chmodSync(h, 0o644);

    const result = ensureSpawnHelperExecutable(rootDir);

    expect(result.fixed.sort()).toEqual(helpers.sort());
  });

  it('handles missing node_modules gracefully (no error)', () => {
    if (process.platform === 'win32') return;
    // rootDir exists but has no node_modules — daemon could be started
    // pre-install (developer mistake). We must not crash the daemon.
    const result = ensureSpawnHelperExecutable(rootDir);
    expect(result.fixed).toEqual([]);
    expect(result.alreadyOk).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns skipped:true on Windows', () => {
    if (process.platform !== 'win32') {
      // Can't directly test this branch without monkey-patching process.platform;
      // assert the shape that callers depend on.
      const result = ensureSpawnHelperExecutable(rootDir);
      expect(result.skipped).toBe(false);
      return;
    }
    const result = ensureSpawnHelperExecutable(rootDir);
    expect(result.skipped).toBe(true);
  });
});
