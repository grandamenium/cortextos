import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadDaemonConfig, daemonConfigPath } from '../../../src/utils/daemon-config';

let originalHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cortextos-daemon-cfg-'));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('loadDaemonConfig', () => {
  it('returns empty object when file is missing (zero-config install)', () => {
    expect(loadDaemonConfig('default')).toEqual({});
  });

  it('returns parsed config when daemon.json is present', () => {
    const cfgDir = join(fakeHome, '.cortextos', 'default', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'daemon.json'),
      JSON.stringify({ doctor_cron_interval_minutes: 15, cron_dispatch_storm_threshold: 5 }),
    );
    expect(loadDaemonConfig('default')).toEqual({
      doctor_cron_interval_minutes: 15,
      cron_dispatch_storm_threshold: 5,
    });
  });

  it('returns empty object for malformed JSON (no throw)', () => {
    const cfgDir = join(fakeHome, '.cortextos', 'default', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'daemon.json'), '{not valid json');
    expect(loadDaemonConfig('default')).toEqual({});
  });

  it('returns empty object when file contains a non-object (array, null, scalar)', () => {
    const cfgDir = join(fakeHome, '.cortextos', 'default', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'daemon.json'), 'null');
    expect(loadDaemonConfig('default')).toEqual({});
  });

  it('daemonConfigPath honors the instanceId', () => {
    expect(daemonConfigPath('staging')).toContain('/.cortextos/staging/config/daemon.json');
  });
});
