/**
 * Restart-marker hygiene (#609 / task_1781032176037): the daemon boot sweep
 * (d) and the hard-restart SIGKILL escalation (b).
 *
 * Live context: an orphaned `.restart-planned`/`.user-stop` made the crash-alert
 * hook misread a genuine crash as an intentional stop, silently masking dead
 * agents for 14.5h; a wedged PTY child surviving `hard-restart` (SIGTERM never
 * escalated) orphaned descendants that exhausted the box.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentManager } from '../../../src/daemon/agent-manager';
import { isPidAlive, hardKillProcessGroup } from '../../../src/daemon/agent-process';

describe('sweepStaleLifecycleMarkers (daemon boot self-heals orphaned markers)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  const markerPath = (agent: string, marker: string) => join(ctxRoot, 'state', agent, marker);
  const writeMarker = (agent: string, marker: string, content: string) => {
    mkdirSync(join(ctxRoot, 'state', agent), { recursive: true });
    writeFileSync(markerPath(agent, marker), content);
  };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-marker-sweep-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(ctxRoot, { recursive: true });
  });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  const newManager = () => new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

  it('reaps a stale marker (older than the 300s TTL) and logs agent/marker/age/content', () => {
    writeMarker('paul', '.restart-planned', 'CONTEXT-FORCE-RESTART');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const am = newManager();

    // now is 400s after the marker's mtime → age 400s > 300s threshold → swept.
    const now = Date.now() + 400_000;
    (am as unknown as { sweepStaleLifecycleMarkers(n: number): void }).sweepStaleLifecycleMarkers(now);

    expect(existsSync(markerPath('paul', '.restart-planned'))).toBe(false);
    const swept = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('Swept stale lifecycle marker'));
    expect(swept).toBeTruthy();
    expect(swept).toContain('agent=paul');
    expect(swept).toContain('marker=.restart-planned');
    expect(swept).toMatch(/age=\d+s/);
    expect(swept).toContain('CONTEXT-FORCE-RESTART');
    logSpy.mockRestore();
  });

  it('LEAVES a marker still inside the TTL window (in-flight restart owned by the grace path)', () => {
    writeMarker('donna', '.user-stop', 'stopping');
    const am = newManager();

    // now ~= mtime → age ~0 < 300s threshold → kept.
    (am as unknown as { sweepStaleLifecycleMarkers(n: number): void }).sweepStaleLifecycleMarkers(Date.now());

    expect(existsSync(markerPath('donna', '.user-stop'))).toBe(true);
  });

  it('does NOT sweep .daemon-crashed (owned by the BUG-011 quiet logic)', () => {
    writeMarker('alice', '.daemon-crashed', 'prev daemon died');
    // age the file well past the TTL so only the exclusion (not the threshold) protects it
    const old = (Date.now() - 999_000) / 1000;
    utimesSync(markerPath('alice', '.daemon-crashed'), old, old);
    const am = newManager();

    (am as unknown as { sweepStaleLifecycleMarkers(n: number): void }).sweepStaleLifecycleMarkers(Date.now());

    expect(existsSync(markerPath('alice', '.daemon-crashed'))).toBe(true);
  });

  it('no-op (no throw) when the state dir does not exist', () => {
    const am = newManager(); // ctxRoot/state absent
    expect(() => (am as unknown as { sweepStaleLifecycleMarkers(n: number): void }).sweepStaleLifecycleMarkers(Date.now()))
      .not.toThrow();
  });
});

describe('hard-restart kill escalation helpers (#202)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('isPidAlive: true for this process, false for an unused pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2_000_000_000)).toBe(false); // far above any real pid
  });

  it('hardKillProcessGroup signals the whole process GROUP (negative pid) with SIGKILL', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    hardKillProcessGroup(4242);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL'); // reaps descendants, not just the leader
  });

  it('falls back to the single pid if the group signal is rejected', () => {
    const calls: Array<[number, string | number | undefined]> = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      calls.push([pid, sig]);
      if (pid < 0) throw new Error('ESRCH'); // group signal rejected
      return true;
    }) as never);

    hardKillProcessGroup(777);

    expect(calls[0]).toEqual([-777, 'SIGKILL']); // tried the group first
    expect(calls[1]).toEqual([777, 'SIGKILL']);  // then the single pid
  });
});
