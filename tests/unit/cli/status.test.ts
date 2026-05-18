/**
 * `cortextos status` — unit tests for the rich fleet-health view.
 *
 * Strategy: drive `collectStatus` against synthetic fixture dirs in a tmp
 * tree so the test is hermetic — it never touches the real fleet, never
 * shells out to pm2, and never opens a live IPC socket. Injectable probes
 * stub IPC + PM2 so each test pins one section's behaviour at a time.
 *
 * What we lock in:
 *   1. Builds a coherent StatusReport from a synthetic fixture (sam + forge
 *      heartbeats, sam inbox with 11 items, sam errors with 6 items,
 *      bus-signing-key on disk).
 *   2. Doesn't crash on a totally-empty install (no ctxRoot dirs at all).
 *   3. Doesn't crash when daemon.env / agents.yaml are absent.
 *   4. Renders a non-empty text block from a populated report.
 *   5. Threshold flags fire at the right boundaries (>10 inbox, >5 errors).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectStatus,
  renderStatusText,
  type AgentRow,
  type StatusReport,
} from '../../../src/cli/status';

describe('Task: cortextos status — collectStatus', () => {
  let tmpRoot: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-status-'));
    ctxRoot = join(tmpRoot, '.cortextos', 'default');
    frameworkRoot = join(tmpRoot, 'cortextos');
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(frameworkRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns a populated report against a synthetic fixture (no live IPC)', async () => {
    // ---- agents.yaml: sam + forge ----
    writeFileSync(join(frameworkRoot, 'agents.yaml'), [
      'version: 1',
      'agents:',
      '  sam:',
      '    host: macbook',
      '    org: subbu-ops',
      '    role: telegram_orchestrator',
      '  forge:',
      '    host: mac_mini',
      '    org: subbu-ops',
      '    role: builder',
      '',
    ].join('\n'));

    // ---- org/agent dirs (one in manifest + one drift) ----
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'sam'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'forge'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'rogue'), { recursive: true });

    // ---- state/<agent>/heartbeat.json ----
    mkdirSync(join(ctxRoot, 'state', 'sam'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'state', 'sam', 'heartbeat.json'),
      JSON.stringify({
        agent: 'sam',
        org: 'subbu-ops',
        status: 'online',
        current_task: '',
        mode: 'day',
        last_heartbeat: '2026-05-17T22:00:00Z',
        loop_interval: '',
      }),
    );

    // ---- inbox + errors per agent ----
    const samInbox = join(ctxRoot, 'inbox', 'sam');
    mkdirSync(samInbox, { recursive: true });
    for (let i = 0; i < 11; i++) {
      writeFileSync(join(samInbox, `msg-${i}.json`), '{}');
    }
    const samErrors = join(samInbox, '.errors');
    mkdirSync(samErrors, { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(samErrors, `err-${i}.json`), '{}');
    }
    mkdirSync(join(ctxRoot, 'inbox', 'forge'), { recursive: true });

    // ---- bus-signing-key ----
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'bus-signing-key'), 'deadbeefcafef00d');

    // ---- breaker file for forge (in cooldown) ----
    mkdirSync(join(ctxRoot, 'state', 'forge'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'state', 'forge', 'restart-breaker.json'),
      JSON.stringify({ cause: 'rate_limit', nextRestartAt: '2026-05-17T23:00:00Z', delayMs: 60000 }),
    );

    // ---- crash history ----
    writeFileSync(
      join(ctxRoot, 'state', '.daemon-crash-history.json'),
      JSON.stringify([
        { ts: '2026-05-17T21:00:00Z', agent: 'forge', cause: 'auth', message: 'halt' },
        { ts: '2026-05-17T20:00:00Z', agent: 'sam', cause: 'rate_limit', message: 'cooldown' },
      ]),
    );

    const report = await collectStatus({
      instance: 'default',
      ctxRoot,
      frameworkRoot,
      // Stub PM2: daemon online with pid 4242, 30m uptime, 1 restart.
      pm2Probe: () => ({
        pid: 4242,
        pm2_env: {
          status: 'online',
          pm_uptime: Date.now() - 30 * 60 * 1000,
          restart_time: 1,
        },
      }),
      // Stub IPC: two agents — sam running, forge starting.
      ipcProbe: async () => [
        { name: 'sam', status: 'running', pid: 1000, uptime: 600 },
        { name: 'forge', status: 'starting', pid: 1001, uptime: 5 },
      ],
      env: { CTX_BUS_AUTH_GRACE_UNTIL: '2099-01-01T00:00:00Z' },
    });

    // Host
    expect(report.host.instance).toBe('default');
    expect(report.host.hostId).toMatch(/.+@.+/); // user@host shape

    // Daemon
    expect(report.daemon.running).toBe(true);
    expect(report.daemon.pid).toBe(4242);
    expect(report.daemon.restartCount).toBe(1);

    // Agents — sam + forge, both in manifest
    expect(report.agents.map(a => a.name).sort()).toEqual(['forge', 'sam']);
    const samRow = report.agents.find(a => a.name === 'sam') as AgentRow;
    expect(samRow.role).toBe('telegram_orchestrator');
    expect(samRow.inManifest).toBe(true);
    expect(samRow.status).toBe('running');
    const forgeRow = report.agents.find(a => a.name === 'forge') as AgentRow;
    expect(forgeRow.role).toBe('builder');
    expect(forgeRow.status).toBe('starting');

    // Bus — sam exceeds both thresholds
    const samBus = report.bus.rows.find(b => b.agent === 'sam');
    expect(samBus).toBeDefined();
    expect(samBus!.inbox).toBe(11);
    expect(samBus!.errors).toBe(6);
    expect(samBus!.flagged).toBe(true);
    // forge — no items
    const forgeBus = report.bus.rows.find(b => b.agent === 'forge');
    expect(forgeBus!.flagged).toBe(false);

    // Breaker — forge in cooldown
    expect(report.breaker).toHaveLength(1);
    expect(report.breaker[0].agent).toBe('forge');
    expect(report.breaker[0].cause).toBe('rate_limit');
    expect(report.breaker[0].nextRestartAt).toBe('2026-05-17T23:00:00Z');

    // HMAC
    expect(report.hmac.keyPresent).toBe(true);
    expect(report.hmac.keyFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(report.hmac.graceUntil).toBe('2099-01-01T00:00:00Z');
    expect(report.hmac.graceActive).toBe(true);

    // Manifest
    expect(report.manifest.loaded).toBe(true);
    expect(report.manifest.agentCount).toBe(2);
    expect(report.manifest.driftOnDisk).toEqual(['rogue']);

    // Crashes — sorted newest-first, capped at 3
    expect(report.crashes).toHaveLength(2);
    expect(report.crashes[0].ts).toBe('2026-05-17T21:00:00Z');

    // Alerts surface the right things
    expect(report.alerts.some(a => a.includes('sam') && a.includes('errors'))).toBe(true);
    expect(report.alerts.some(a => a.includes('sam') && a.includes('inbox'))).toBe(true);
    expect(report.alerts.some(a => a.includes('forge') && a.includes('cooldown'))).toBe(true);
    expect(report.alerts.some(a => a.includes('rogue'))).toBe(true);
  });

  it('does not crash when no agents are running (no IPC, no heartbeats, no inbox)', async () => {
    const report = await collectStatus({
      instance: 'default',
      ctxRoot,
      frameworkRoot,
      // Both probes return no data
      pm2Probe: () => null,
      ipcProbe: async () => null,
      env: {},
    });

    expect(report.agents).toEqual([]);
    expect(report.bus.rows).toEqual([]);
    expect(report.breaker).toEqual([]);
    expect(report.crashes).toEqual([]);
    expect(report.daemon.running).toBe(false);
    // Manifest absent → loaded=false but no throw
    expect(report.manifest.loaded).toBe(false);
    expect(report.manifest.agentCount).toBe(0);
    expect(report.hmac.keyPresent).toBe(false);
  });

  it('does not crash when daemon.env / agents.yaml are absent', async () => {
    // Create only state dir with one heartbeat — no config, no manifest.
    mkdirSync(join(ctxRoot, 'state', 'orphan'), { recursive: true });
    writeFileSync(
      join(ctxRoot, 'state', 'orphan', 'heartbeat.json'),
      JSON.stringify({
        agent: 'orphan',
        org: 'subbu-ops',
        status: 'unknown',
        current_task: '',
        mode: 'day',
        last_heartbeat: '2026-05-17T22:00:00Z',
        loop_interval: '',
      }),
    );

    const report = await collectStatus({
      instance: 'default',
      ctxRoot,
      frameworkRoot,
      pm2Probe: () => null,
      // IPC returns null → fall through to heartbeat reader
      ipcProbe: async () => null,
      env: {},
    });

    // Orphan agent surfaces via heartbeat fallback
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0].name).toBe('orphan');
    expect(report.agents[0].inManifest).toBe(false);
    expect(report.manifest.loaded).toBe(false);
    // graceActive default false when env var absent
    expect(report.hmac.graceActive).toBe(false);
  });

  it('threshold flagging: 5 errors not flagged, 6 errors flagged', async () => {
    mkdirSync(join(ctxRoot, 'inbox', 'sam'), { recursive: true });
    mkdirSync(join(ctxRoot, 'inbox', 'sam', '.errors'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(ctxRoot, 'inbox', 'sam', '.errors', `e-${i}.json`), '{}');
    }
    mkdirSync(join(ctxRoot, 'inbox', 'pa'), { recursive: true });
    mkdirSync(join(ctxRoot, 'inbox', 'pa', '.errors'), { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(ctxRoot, 'inbox', 'pa', '.errors', `e-${i}.json`), '{}');
    }

    const report = await collectStatus({
      ctxRoot,
      frameworkRoot,
      pm2Probe: () => null,
      ipcProbe: async () => [],
      env: {},
    });

    expect(report.bus.rows.find(b => b.agent === 'sam')?.flagged).toBe(false);
    expect(report.bus.rows.find(b => b.agent === 'pa')?.flagged).toBe(true);
  });

  it('renderStatusText emits a non-empty multi-section block', async () => {
    const report = await collectStatus({
      ctxRoot,
      frameworkRoot,
      pm2Probe: () => null,
      ipcProbe: async () => [],
      env: {},
    });
    const text = renderStatusText(report);
    expect(text).toContain('cortextos status');
    expect(text).toContain('Host:');
    expect(text).toContain('Daemon:');
    expect(text).toContain('Agents');
    expect(text).toContain('Bus');
    expect(text).toContain('Circuit breaker');
    expect(text).toContain('HMAC:');
    expect(text).toContain('Manifest:');
  });
});
