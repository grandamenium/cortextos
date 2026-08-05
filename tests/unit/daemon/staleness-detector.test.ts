import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
  assessStaleness,
  readLivenessSources,
  StalenessDetector,
  DEFAULT_STALE_THRESHOLD_MS,
} from '../../../src/daemon/staleness-detector.js';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe('assessStaleness (pure rule)', () => {
  it('fresh heartbeat alone = not stale', () => {
    const v = assessStaleness({ heartbeatAt: NOW - 5 * MIN }, NOW);
    expect(v.stale).toBe(false);
    expect(v.freshestSource).toBe('heartbeat');
  });

  it('stale heartbeat but FRESH CRON FIRE = not stale (the 2026-07-09 false-positive class)', () => {
    const v = assessStaleness(
      { heartbeatAt: NOW - 165 * MIN, lastCronFireAt: NOW - 10 * MIN },
      NOW,
    );
    expect(v.stale).toBe(false);
    expect(v.freshestSource).toBe('cron-fire');
  });

  it('stale heartbeat + stale cron + fresh idle flag = not stale', () => {
    const v = assessStaleness(
      { heartbeatAt: NOW - 90 * MIN, lastCronFireAt: NOW - 80 * MIN, idleFlagAt: NOW - 2 * MIN },
      NOW,
    );
    expect(v.stale).toBe(false);
    expect(v.freshestSource).toBe('idle-flag');
  });

  it('ALL sources silent past threshold = stale', () => {
    const v = assessStaleness(
      { heartbeatAt: NOW - 90 * MIN, lastCronFireAt: NOW - 50 * MIN, idleFlagAt: NOW - 46 * MIN },
      NOW,
    );
    expect(v.stale).toBe(true);
    expect(v.ageMs).toBe(46 * MIN);
  });

  it('exactly at threshold = not stale (strictly greater)', () => {
    const v = assessStaleness({ heartbeatAt: NOW - DEFAULT_STALE_THRESHOLD_MS }, NOW);
    expect(v.stale).toBe(false);
  });

  it('no sources at all = never stale (new agent, nothing to judge)', () => {
    const v = assessStaleness({}, NOW);
    expect(v.stale).toBe(false);
    expect(v.freshestSource).toBe('none');
  });
});

describe('readLivenessSources', () => {
  let dirs: string[] = [];
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs = []; });
  const stateDir = () => { const d = mkdtempSync(join(tmpdir(), 'stale-src-')); dirs.push(d); return d; };

  it('reads heartbeat.json last_heartbeat, cron-state latest fire, idle flag mtime', () => {
    const dir = stateDir();
    writeFileSync(join(dir, 'heartbeat.json'),
      JSON.stringify({ agent: 'x', last_heartbeat: '2026-07-10T10:00:00Z' }));
    writeFileSync(join(dir, 'cron-state.json'), JSON.stringify({
      updated_at: '2026-07-10T10:22:00Z',
      crons: [
        { name: 'heartbeat', last_fire: '2026-07-10T09:59:00Z' },
        { name: 'file-drop', last_fire: '2026-07-10T10:22:00Z' },
      ],
    }));
    writeFileSync(join(dir, 'last_idle.flag'), '1783684800');
    const t = new Date('2026-07-10T10:30:00Z');
    utimesSync(join(dir, 'last_idle.flag'), t, t);

    const s = readLivenessSources(dir);
    expect(s.heartbeatAt).toBe(Date.parse('2026-07-10T10:00:00Z'));
    expect(s.lastCronFireAt).toBe(Date.parse('2026-07-10T10:22:00Z')); // latest of the two
    expect(Math.abs((s.idleFlagAt ?? 0) - t.getTime())).toBeLessThan(2000);
  });

  it('returns empty object for a bare state dir', () => {
    expect(readLivenessSources(stateDir())).toEqual({});
  });

  it('malformed heartbeat.json falls back to file mtime', () => {
    const dir = stateDir();
    writeFileSync(join(dir, 'heartbeat.json'), '{corrupt');
    const s = readLivenessSources(dir);
    expect(typeof s.heartbeatAt).toBe('number');
  });
});

describe('StalenessDetector sweep', () => {
  let dirs: string[] = [];
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs = []; });

  function ctxWithAgent(name: string, hbAgeMin: number, now: number) {
    const ctxRoot = mkdtempSync(join(tmpdir(), 'stale-ctx-'));
    dirs.push(ctxRoot);
    const stateDir = join(ctxRoot, 'state', name);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
      agent: name,
      last_heartbeat: new Date(now - hbAgeMin * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }));
    return ctxRoot;
  }

  it('prods a stale agent once and then respects the cooldown', () => {
    const now = NOW;
    const ctxRoot = ctxWithAgent('kirk', 120, now);
    const notify = vi.fn();
    const logs: string[] = [];
    const det = new StalenessDetector({
      instanceId: 'default',
      ctxRoot,
      listAgents: () => [{ name: 'kirk', org: '360i' }],
      notify: notify as never,
      now: () => now,
      log: m => logs.push(m),
    });
    det.checkOnce();
    det.checkOnce(); // same instant — cooldown must suppress
    expect(notify).toHaveBeenCalledTimes(1);
    const [, from, target, message] = notify.mock.calls[0];
    expect(from).toBe('daemon');
    expect(target).toBe('kirk');
    expect(message).toMatch(/staleness detector/);
    expect(logs.join('\n')).toMatch(/ALL liveness sources silent/);
  });

  it('does NOT prod when a cron fire is fresh even with stale heartbeat', () => {
    const now = NOW;
    const ctxRoot = ctxWithAgent('scotty', 120, now);
    writeFileSync(join(ctxRoot, 'state', 'scotty', 'cron-state.json'), JSON.stringify({
      updated_at: new Date(now).toISOString(),
      crons: [{ name: 'file-drop', last_fire: new Date(now - 5 * MIN).toISOString() }],
    }));
    const notify = vi.fn();
    const det = new StalenessDetector({
      instanceId: 'default', ctxRoot,
      listAgents: () => [{ name: 'scotty', org: '360i' }],
      notify: notify as never, now: () => now, log: () => {},
    });
    det.checkOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('regression (addendum 3): watchdog-class beat via updateHeartbeat writes the NAMED agent dir and no basename-cwd phantom dir appears', async () => {
    const { updateHeartbeat } = await import('../../../src/bus/heartbeat.js');
    const { resolvePaths } = await import('../../../src/utils/paths.js');
    // Simulate the daemon environment: cwd basename is the framework checkout
    const paths = resolvePaths('scotty', 'default');
    // Write to an isolated fake state dir instead of the real one:
    const ctxRoot = mkdtempSync(join(tmpdir(), 'stale-reg-'));
    dirs.push(ctxRoot);
    const fakePaths = { ...paths, stateDir: join(ctxRoot, 'state', 'scotty') };
    const before = Date.now();
    updateHeartbeat(fakePaths as never, 'scotty', '[watchdog] scotty alive — idle session test', { org: '360i' });
    const hbPath = join(ctxRoot, 'state', 'scotty', 'heartbeat.json');
    expect(existsSync(hbPath)).toBe(true);
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    expect(hb.agent).toBe('scotty'); // named agent, not basename(cwd)
    expect(Date.parse(hb.last_heartbeat)).toBeGreaterThanOrEqual(before - 1000);
    // No phantom dir named after the process cwd basename:
    expect(existsSync(join(ctxRoot, 'state', basename(process.cwd())))).toBe(false);
  });
});
