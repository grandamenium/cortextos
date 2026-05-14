import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkNodeModulesMtime } from '../../../src/utils/node-modules-mtime.js';

describe('checkNodeModulesMtime', () => {
  let testDir: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'nm-mtime-test-'));
    frameworkRoot = join(testDir, 'fw');
    mkdirSync(join(frameworkRoot, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writePkgWithMtime(mtimeMs: number): void {
    const path = join(frameworkRoot, 'node_modules', 'package.json');
    writeFileSync(path, '{}');
    const t = mtimeMs / 1000;
    utimesSync(path, t, t);
  }

  it('returns stale=true when node_modules/package.json mtime is newer than daemonStartedAt', () => {
    const daemonStartedAt = new Date('2026-05-15T10:00:00Z');
    writePkgWithMtime(new Date('2026-05-15T10:05:00Z').getTime()); // 5min newer

    const r = checkNodeModulesMtime(frameworkRoot, daemonStartedAt);
    expect(r.stale).toBe(true);
    expect(r.mtime?.getTime()).toBe(new Date('2026-05-15T10:05:00Z').getTime());
  });

  it('returns stale=false when mtime is older than daemonStartedAt', () => {
    const daemonStartedAt = new Date('2026-05-15T10:00:00Z');
    writePkgWithMtime(new Date('2026-05-15T09:00:00Z').getTime()); // 1h older

    const r = checkNodeModulesMtime(frameworkRoot, daemonStartedAt);
    expect(r.stale).toBe(false);
  });

  it('returns stale=false when mtime equals daemonStartedAt (strictly newer threshold)', () => {
    const ts = new Date('2026-05-15T10:00:00.000Z');
    writePkgWithMtime(ts.getTime());

    const r = checkNodeModulesMtime(frameworkRoot, ts);
    expect(r.stale).toBe(false);
  });

  it('returns stale=false when node_modules/package.json is missing (no throw)', () => {
    const daemonStartedAt = new Date('2026-05-15T10:00:00Z');
    // Don't create package.json.
    const r = checkNodeModulesMtime(frameworkRoot, daemonStartedAt);
    expect(r.stale).toBe(false);
    expect(r.mtime).toBeUndefined();
  });

  it('returns stale=false when frameworkRoot is bogus (no throw on disk weirdness)', () => {
    const daemonStartedAt = new Date('2026-05-15T10:00:00Z');
    const r = checkNodeModulesMtime('/nonexistent/path/that/cannot/be/read', daemonStartedAt);
    expect(r.stale).toBe(false);
  });
});
