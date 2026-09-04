import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEvent } from '../../../src/bus/event';
import type { BusPaths, Heartbeat } from '../../../src/types';

/**
 * Tests for the opt-in heartbeat-refresh side-effect on logEvent. The
 * refresh now happens ONLY when the caller passes
 * `{ refreshHeartbeat: true }`, which is reserved for an agent logging
 * its OWN in-session activity. The default is off (fail-safe): a
 * daemon-on-behalf write (e.g. delivering an inbound message to another
 * agent) never opts in, so a wedged agent's heartbeat cannot be spoofed
 * fresh by traffic it did not act on.
 */
describe('Bus events', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-event-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'spark'),
      inflight: join(testDir, 'inflight', 'spark'),
      processed: join(testDir, 'processed', 'spark'),
      logDir: join(testDir, 'logs', 'spark'),
      stateDir: join(testDir, 'state', 'spark'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Regression tests for the silent-metadata-drop bug (2026-08-20).
   *
   * logEvent used to fall through to `{}` when a metadata STRING did not
   * parse, so a shell-quoting mistake in any of the ~139 documented `--meta`
   * call sites produced a stored event with empty metadata at exit code 0
   * while printing "Logged". The audit trail recorded that something happened
   * and lost what it was, and every signal available to the caller said it had
   * worked. It now throws instead.
   */
  it('logEvent parses a valid metadata STRING into structured metadata', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'valid_meta', 'info', '{"a":1,"b":"two"}');

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries[0].metadata).toEqual({ a: 1, b: 'two' });
  });

  it('logEvent THROWS on unparseable metadata instead of silently storing {}', () => {
    expect(() =>
      logEvent(paths, 'spark', 'eros-os', 'action', 'bad_meta', 'info', '{"broken": not json}'),
    ).toThrow(/not valid JSON/);
  });

  it('logEvent writes NO event at all when metadata is unparseable', () => {
    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);

    expect(() =>
      logEvent(paths, 'spark', 'eros-os', 'action', 'bad_meta', 'info', '{"nope"'),
    ).toThrow();

    // The failure must be total: a rejected event must not leave a partial or
    // metadata-less row behind, or the audit gap is merely relocated.
    const wrote = existsSync(eventFile)
      ? readFileSync(eventFile, 'utf-8').trim().split('\n').filter(Boolean)
      : [];
    expect(wrote).toHaveLength(0);
  });

  it('logEvent rejects valid JSON that is not an object (scalar / array)', () => {
    expect(() =>
      logEvent(paths, 'spark', 'eros-os', 'action', 'scalar_meta', 'info', '5'),
    ).toThrow(/must be a JSON object/);
    expect(() =>
      logEvent(paths, 'spark', 'eros-os', 'action', 'array_meta', 'info', '[1,2]'),
    ).toThrow(/must be a JSON object/);
  });

  it('logEvent still accepts an object metadata argument unchanged', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'obj_meta', 'info', { untouched: true });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries[0].metadata).toEqual({ untouched: true });
  });

  it('logEvent appends a JSONL entry to the daily events file', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'test_event', 'info', { foo: 'bar' });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'spark',
      org: 'eros-os',
      category: 'action',
      event: 'test_event',
      severity: 'info',
      metadata: { foo: 'bar' },
    });
  });

  describe('heartbeat refresh side-effect', () => {
    it('bumps last_heartbeat on an existing heartbeat.json without overwriting other fields when the caller opts in', async () => {
      const oldHeartbeat: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'fix/log-event-refreshes-heartbeat',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(oldHeartbeat));

      // Let one millisecond tick so the new timestamp is strictly newer.
      await new Promise((resolve) => setTimeout(resolve, 2));
      logEvent(paths, 'spark', 'eros-os', 'action', 'activity_tick', 'info', undefined, {
        refreshHeartbeat: true,
      });

      const refreshed = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;

      // Timestamp bumped…
      expect(new Date(refreshed.last_heartbeat).getTime()).toBeGreaterThan(
        new Date(oldHeartbeat.last_heartbeat).getTime(),
      );
      // …other fields preserved intact.
      expect(refreshed.status).toBe('online');
      expect(refreshed.current_task).toBe('fix/log-event-refreshes-heartbeat');
      expect(refreshed.mode).toBe('day');
      expect(refreshed.loop_interval).toBe('4h');
      expect(refreshed.agent).toBe('spark');
      expect(refreshed.org).toBe('eros-os');
    });

    it('leaves last_heartbeat byte-identical when the caller does not opt in (default off, spoof-safe)', () => {
      const oldHeartbeat: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'wedged',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      const raw = JSON.stringify(oldHeartbeat);
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), raw);

      // Daemon-on-behalf-style write: no opts, so no refresh.
      logEvent(paths, 'spark', 'eros-os', 'message', 'telegram_received', 'info', { text_chars: 3 });

      const after = readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8');
      expect(after).toBe(raw);
    });

    it('is a no-op when no heartbeat.json exists yet', () => {
      // Fresh agent — no heartbeat file written yet.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      logEvent(paths, 'spark', 'eros-os', 'action', 'first_boot', 'info');

      // Still no heartbeat file — refresh is a no-op when nothing exists.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      // But the event itself was written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);
    });

    it('never blocks event persistence when the heartbeat refresh fails', () => {
      // Write a corrupt heartbeat.json to exercise the error path.
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), '{not valid json');

      // Must not throw. Opt in so the refresh path is actually exercised.
      expect(() =>
        logEvent(paths, 'spark', 'eros-os', 'action', 'after_corrupt_hb', 'info', undefined, {
          refreshHeartbeat: true,
        }),
      ).not.toThrow();

      // Event still written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      const entries = readFileSync(eventFile, 'utf-8').trim().split('\n');
      expect(entries).toHaveLength(1);
    });
  });
});
