import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DAEMON_AGENT_NAME,
  logDaemonEvent,
} from '../../../src/daemon/daemon-event-logger.js';

describe('logDaemonEvent', () => {
  let testDir: string;
  let ctxRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'daemon-event-logger-test-'));
    ctxRoot = join(testDir, 'instance');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('exports the synthetic agent name as `_daemon`', () => {
    expect(DAEMON_AGENT_NAME).toBe('_daemon');
  });

  it('writes one JSONL row to <ctxRoot>/orgs/<org>/analytics/events/_daemon/<date>.jsonl', () => {
    logDaemonEvent(ctxRoot, 'default', 'acme', 'action', 'heartbeat_stale_detected', 'warning', {
      agent: 'boss',
      age_seconds: 700,
      threshold_seconds: 600,
    });

    const today = new Date().toISOString().slice(0, 10);
    const eventsDir = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', DAEMON_AGENT_NAME);
    const file = join(eventsDir, `${today}.jsonl`);
    expect(existsSync(file)).toBe(true);

    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row.agent).toBe('_daemon');
    expect(row.org).toBe('acme');
    expect(row.category).toBe('action');
    expect(row.event).toBe('heartbeat_stale_detected');
    expect(row.severity).toBe('warning');
    expect(row.metadata).toEqual({ agent: 'boss', age_seconds: 700, threshold_seconds: 600 });
  });

  it('appends multiple events to the same dated file (round-trip via readdir)', () => {
    logDaemonEvent(ctxRoot, 'default', 'acme', 'action', 'doctor_delta_detected', 'warning', { new_failures: ['x'] });
    logDaemonEvent(ctxRoot, 'default', 'acme', 'action', 'doctor_delta_detected', 'warning', { new_failures: ['y'] });

    const eventsDir = join(ctxRoot, 'orgs', 'acme', 'analytics', 'events', DAEMON_AGENT_NAME);
    const files = readdirSync(eventsDir);
    expect(files.length).toBe(1);
    const lines = readFileSync(join(eventsDir, files[0]), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('routes to <ctxRoot>/analytics/events when org is empty string', () => {
    // Daemon configured with no org → analyticsDir falls back to root-level.
    // Matches resolvePaths()'s org-optional behavior.
    logDaemonEvent(ctxRoot, 'default', '', 'action', 'cron_dispatch_storm_detected', 'critical', { agent: 'boss' });

    const today = new Date().toISOString().slice(0, 10);
    const file = join(ctxRoot, 'analytics', 'events', DAEMON_AGENT_NAME, `${today}.jsonl`);
    expect(existsSync(file)).toBe(true);
  });

  it('does not throw when underlying logEvent fails (e.g. unwritable ctxRoot)', () => {
    // Pass a clearly bogus ctxRoot. The logger swallows the throw so the
    // watcher's main loop stays alive.
    expect(() =>
      logDaemonEvent('/proc/cant-write-here', 'default', 'acme', 'action', 'x', 'info'),
    ).not.toThrow();
  });
});
