import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureSpawnHelperExecutable } from '../../../src/utils/node-pty-perms';

// Regression guard for issue #07 follow-up. npm install on macOS frequently
// leaves node-pty's prebuilt spawn-helper at 0o644 (no exec bit). The
// daemon now self-heals at startup via this helper; this test pins the
// exact behavior the daemon relies on.

function mkFakeNodePty(
  rootDir: string,
  archDirs: string[],
  opts: { includeBuildRelease?: boolean } = {},
): string[] {
  const created: string[] = [];
  const ptyRoot = join(rootDir, 'node_modules', 'node-pty');
  for (const arch of archDirs) {
    const archDir = join(ptyRoot, 'prebuilds', arch);
    mkdirSync(archDir, { recursive: true });
    const helper = join(archDir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\necho stub\n', 'utf-8');
    created.push(helper);
  }
  // build/Release/spawn-helper — second candidate location. Optional
  // because most tests only care about prebuilds; the dedicated
  // build-release test opts in.
  const releaseDir = join(ptyRoot, 'build', 'Release');
  mkdirSync(releaseDir, { recursive: true });
  if (opts.includeBuildRelease) {
    const releaseHelper = join(releaseDir, 'spawn-helper');
    writeFileSync(releaseHelper, '#!/bin/sh\necho stub\n', 'utf-8');
    created.push(releaseHelper);
  }
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

  it('fixes spawn-helper in build/Release alongside prebuilds', () => {
    if (process.platform === 'win32') return;
    const helpers = mkFakeNodePty(rootDir, ['darwin-arm64'], { includeBuildRelease: true });
    for (const h of helpers) chmodSync(h, 0o644);

    const result = ensureSpawnHelperExecutable(rootDir);

    // Both prebuilds/darwin-arm64/spawn-helper AND build/Release/spawn-helper
    // must be in `fixed`. Regression guard for the second candidate location.
    expect(result.fixed.sort()).toEqual(helpers.sort());
    expect(result.fixed.some(p => p.endsWith('build/Release/spawn-helper'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('returns skipped:false on Unix (shape contract)', () => {
    // On Unix the helper does real work. Just pin the shape callers depend on.
    const result = ensureSpawnHelperExecutable(rootDir);
    expect(result.skipped).toBe(false);
  });

  it.runIf(process.platform === 'win32')('returns skipped:true on Windows (early return)', () => {
    const result = ensureSpawnHelperExecutable(rootDir);
    expect(result.skipped).toBe(true);
    expect(result.fixed).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'TS helper and standalone postinstall script agree on the same fixture',
    async () => {
      // Mirror-impl parity check. The standalone .mjs in scripts/ is hand-mirrored
      // from src/utils/node-pty-perms.ts — this test catches drift mechanically
      // rather than relying on the "if you change one, change the other" comment.
      const helpers = mkFakeNodePty(rootDir, ['darwin-arm64', 'linux-x64'], { includeBuildRelease: true });

      // Snapshot of "broken state" both implementations should resolve identically.
      for (const h of helpers) chmodSync(h, 0o644);
      const tsResult = ensureSpawnHelperExecutable(rootDir);
      const tsFixedAfter = helpers.map(h => statSync(h).mode & 0o111);

      // Reset to broken and let the standalone script handle it.
      for (const h of helpers) chmodSync(h, 0o644);
      const { execFileSync } = await import('child_process');
      const scriptPath = join(__dirname, '..', '..', '..', 'scripts', 'ensure-node-pty-perms.mjs');
      execFileSync(process.execPath, [scriptPath], {
        cwd: rootDir,
        env: { ...process.env },
      });
      const mjsFixedAfter = helpers.map(h => statSync(h).mode & 0o111);

      // Both implementations must leave the fixture with identical final modes.
      expect(mjsFixedAfter).toEqual(tsFixedAfter);
      // And both should have actually set exec bits on every helper.
      expect(tsResult.fixed.sort()).toEqual(helpers.sort());
      for (const mode of mjsFixedAfter) expect(mode).not.toBe(0);
    },
  );
});
