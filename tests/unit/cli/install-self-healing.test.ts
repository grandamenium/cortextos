import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const spawnSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    execSync: (cmd: string, opts?: { encoding?: string }) => {
      if (cmd === 'id -u') {
        // Real `getUid()` calls with `{ encoding: 'utf-8' }`, so execSync
        // returns string. When called without encoding, it returns Buffer.
        return opts?.encoding ? '501\n' : Buffer.from('501\n');
      }
      return actual.execSync(cmd);
    },
  };
});

import {
  installSelfHealing,
  uninstallSelfHealing,
  SELF_HEALING_SERVICES,
} from '../../../src/cli/install-self-healing.js';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

let testRoot: string;
let ctxRoot: string;
let sourceDir: string;
let launchAgentsDir: string;
let homeDirOverride: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'install-self-healing-test-'));
  ctxRoot = join(testRoot, 'ctx');
  sourceDir = join(testRoot, 'source-scripts');
  launchAgentsDir = join(testRoot, 'launchagents');
  homeDirOverride = join(testRoot, 'home');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(homeDirOverride, { recursive: true });

  // Lay down the 4 shell scripts + 4 plist templates the install copies
  // from `scripts/self-healing/`.
  for (const s of SELF_HEALING_SERVICES) {
    writeFileSync(join(sourceDir, `${s}.sh`), `#!/bin/bash\n# ${s}\n`);
    writeFileSync(
      join(sourceDir, `com.cortextos.${s}.plist.template`),
      `<plist><dict>
  <key>HomeRef</key><string>{HOME}/path</string>
  <key>InstanceRef</key><string>{INSTANCE}</string>
</dict></plist>`,
    );
  }

  spawnSyncMock.mockReset();
  // Default: launchctl list returns non-zero (service not loaded); bootstrap returns 0
  spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'launchctl' && args[0] === 'list') return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  rmSync(testRoot, { recursive: true, force: true });
});

describe('installSelfHealing', () => {
  it('on macOS: copies all 4 .sh scripts to <ctxRoot>/scripts/ with exec bit', () => {
    setPlatform('darwin');
    installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });

    const scriptsDir = join(ctxRoot, 'scripts');
    expect(existsSync(scriptsDir)).toBe(true);
    const installed = readdirSync(scriptsDir).filter((f) => f.endsWith('.sh')).sort();
    expect(installed).toEqual(SELF_HEALING_SERVICES.map((s) => `${s}.sh`).sort());
  });

  it('on macOS: renders plist templates with {HOME} and {INSTANCE} substituted', () => {
    setPlatform('darwin');
    installSelfHealing(ctxRoot, 'staging', { sourceDir, launchAgentsDir, homeDirOverride });

    const plist = readFileSync(join(launchAgentsDir, 'com.cortextos.watchdog.plist'), 'utf-8');
    expect(plist).toContain(`<string>${homeDirOverride}/path</string>`);
    expect(plist).toContain('<string>staging</string>');
    expect(plist).not.toContain('{HOME}');
    expect(plist).not.toContain('{INSTANCE}');
  });

  it('on macOS: bootstraps each service via launchctl bootstrap', () => {
    setPlatform('darwin');
    const r = installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });

    expect(r.installed.sort()).toEqual([...SELF_HEALING_SERVICES].sort());
    expect(r.failed).toEqual([]);

    const bootstrapCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === 'launchctl' && c[1][0] === 'bootstrap',
    );
    expect(bootstrapCalls).toHaveLength(SELF_HEALING_SERVICES.length);
    // Bootstrap targets gui/<uid> (modern macOS idiom)
    expect(bootstrapCalls[0][1][1]).toBe('gui/501');
  });

  it('on macOS: idempotent — already-loaded services are skipped (no double-bootstrap)', () => {
    setPlatform('darwin');
    // First call: all services not yet loaded → all installed.
    installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });

    // Second call: make `launchctl list` return 0 (service IS loaded).
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    const r = installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });

    expect(r.installed).toEqual([]);
    expect(r.skipped.sort()).toEqual([...SELF_HEALING_SERVICES].sort());
    const bootstrapCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === 'launchctl' && c[1][0] === 'bootstrap',
    );
    expect(bootstrapCalls).toEqual([]);
  });

  it('--skip-self-healing flag short-circuits without touching the filesystem', () => {
    setPlatform('darwin');
    const r = installSelfHealing(ctxRoot, 'default', {
      sourceDir, launchAgentsDir, homeDirOverride, skip: true,
    });

    expect(r.installed).toEqual([]);
    expect(r.skipped.sort()).toEqual([...SELF_HEALING_SERVICES].sort());
    expect(existsSync(join(ctxRoot, 'scripts'))).toBe(false);
    expect(existsSync(join(launchAgentsDir, 'com.cortextos.watchdog.plist'))).toBe(false);
    // No launchctl invocations at all.
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('on Linux: no-ops cleanly (no copy, no launchctl)', () => {
    setPlatform('linux');
    const r = installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });

    expect(r.installed).toEqual([]);
    expect(r.skipped.sort()).toEqual([...SELF_HEALING_SERVICES].sort());
    expect(existsSync(join(ctxRoot, 'scripts'))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('skips with an informational log when source dir is missing', () => {
    setPlatform('darwin');
    const r = installSelfHealing(ctxRoot, 'default', {
      sourceDir: join(testRoot, 'nonexistent-source'),
      launchAgentsDir,
      homeDirOverride,
    });

    expect(r.installed).toEqual([]);
    expect(r.skipped.sort()).toEqual([...SELF_HEALING_SERVICES].sort());
  });

  it('records per-service failure when launchctl bootstrap returns non-zero', () => {
    setPlatform('darwin');
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'launchctl' && args[0] === 'list') return { status: 1, stdout: '', stderr: '' };
      if (cmd === 'launchctl' && args[0] === 'bootstrap') return { status: 5, stdout: '', stderr: 'permission denied' };
      if (cmd === 'launchctl' && args[0] === 'load') return { status: 5, stdout: '', stderr: 'permission denied' };
      return { status: 0, stdout: '', stderr: '' };
    });

    const r = installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });

    expect(r.installed).toEqual([]);
    expect(r.failed.length).toBe(SELF_HEALING_SERVICES.length);
    expect(r.failed[0].reason).toContain('permission denied');
  });
});

describe('uninstallSelfHealing', () => {
  it('on macOS: launchctl bootouts each service + removes plist files', () => {
    setPlatform('darwin');
    // First install so plist files exist.
    installSelfHealing(ctxRoot, 'default', { sourceDir, launchAgentsDir, homeDirOverride });
    expect(existsSync(join(launchAgentsDir, 'com.cortextos.watchdog.plist'))).toBe(true);

    spawnSyncMock.mockClear();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    const r = uninstallSelfHealing(ctxRoot, 'default', { launchAgentsDir, homeDirOverride });

    expect(r.unloaded.sort()).toEqual([...SELF_HEALING_SERVICES].sort());
    expect(r.failed).toEqual([]);
    // plist files removed
    for (const s of SELF_HEALING_SERVICES) {
      expect(existsSync(join(launchAgentsDir, `com.cortextos.${s}.plist`))).toBe(false);
    }
    // bootout called per service
    const bootoutCalls = spawnSyncMock.mock.calls.filter(
      (c) => c[0] === 'launchctl' && c[1][0] === 'bootout',
    );
    expect(bootoutCalls.length).toBeGreaterThanOrEqual(SELF_HEALING_SERVICES.length);
  });

  it('on Linux: no-op', () => {
    setPlatform('linux');
    const r = uninstallSelfHealing(ctxRoot, 'default', { launchAgentsDir, homeDirOverride });
    expect(r.unloaded).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
