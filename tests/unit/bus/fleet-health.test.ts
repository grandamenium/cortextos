import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkAgentHeartbeats,
  checkCronGaps,
  runFleetHealthCheck,
  formatSlackAlert,
  STALE_THRESHOLD_MINUTES,
  CRON_GAP_THRESHOLD_MINUTES,
} from '../../../src/bus/fleet-health';

let tempDir: string | undefined;

function makeHeartbeat(agentName: string, minutesAgo: number, status = 'online') {
  const ts = new Date(Date.now() - minutesAgo * 60000).toISOString();
  return JSON.stringify({ agent_name: agentName, last_heartbeat: ts, status });
}

function setupHeartbeats(agents: Array<{ name: string; minutesAgo: number; status?: string }>): { ctxRoot: string; analyticsDir: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'fleet-health-'));
  const ctxRoot = join(tempDir, 'state-root');
  const analyticsDir = join(tempDir, 'analytics');

  for (const agent of agents) {
    const dir = join(ctxRoot, 'state', agent.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat.json'), makeHeartbeat(agent.name, agent.minutesAgo, agent.status));
  }

  return { ctxRoot, analyticsDir };
}

function writeEvent(
  analyticsDir: string,
  agentName: string,
  eventName: string,
  timestamp: string,
  metadata: Record<string, unknown> = {},
): void {
  const dateStr = timestamp.split('T')[0];
  const dir = join(analyticsDir, 'events', agentName);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    event_name: eventName,
    timestamp,
    metadata,
  });
  writeFileSync(join(dir, `${dateStr}.jsonl`), line + '\n', { flag: 'a' });
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('checkAgentHeartbeats', () => {
  it('marks agent as healthy when heartbeat is fresh', () => {
    const { ctxRoot, analyticsDir } = setupHeartbeats([{ name: 'forge', minutesAgo: 5 }]);
    const paths = { ctxRoot, analyticsDir, taskDir: '', stateDir: '', logDir: '' } as any;
    const result = checkAgentHeartbeats(paths);
    expect(result).toHaveLength(1);
    expect(result[0].isStale).toBe(false);
    expect(result[0].agentName).toBe('forge');
  });

  it('marks agent as stale when heartbeat exceeds threshold', () => {
    const { ctxRoot, analyticsDir } = setupHeartbeats([
      { name: 'forge', minutesAgo: STALE_THRESHOLD_MINUTES + 5 },
    ]);
    const paths = { ctxRoot, analyticsDir, taskDir: '', stateDir: '', logDir: '' } as any;
    const result = checkAgentHeartbeats(paths);
    expect(result[0].isStale).toBe(true);
  });

  it('returns healthy=true report when all agents are fresh', () => {
    const { ctxRoot, analyticsDir } = setupHeartbeats([
      { name: 'forge', minutesAgo: 3 },
      { name: 'sage', minutesAgo: 7 },
    ]);
    const paths = { ctxRoot, analyticsDir, taskDir: '', stateDir: '', logDir: '' } as any;
    const report = runFleetHealthCheck(paths, analyticsDir);
    expect(report.healthy).toBe(true);
    expect(report.staleAgents).toHaveLength(0);
  });

  it('returns healthy=false when any agent is stale', () => {
    const { ctxRoot, analyticsDir } = setupHeartbeats([
      { name: 'forge', minutesAgo: 3 },
      { name: 'analyst', minutesAgo: 60 },
    ]);
    const paths = { ctxRoot, analyticsDir, taskDir: '', stateDir: '', logDir: '' } as any;
    const report = runFleetHealthCheck(paths, analyticsDir);
    expect(report.healthy).toBe(false);
    expect(report.staleAgents.map(a => a.agentName)).toContain('analyst');
  });

  it('formatSlackAlert includes stale agent names', () => {
    const { ctxRoot, analyticsDir } = setupHeartbeats([
      { name: 'analyst', minutesAgo: 60 },
    ]);
    const paths = { ctxRoot, analyticsDir, taskDir: '', stateDir: '', logDir: '' } as any;
    const report = runFleetHealthCheck(paths, analyticsDir);
    const alert = formatSlackAlert(report);
    expect(alert).toContain('analyst');
    expect(alert).toContain('Fleet Health Alert');
  });

  it('formatSlackAlert says OK when healthy', () => {
    const { ctxRoot, analyticsDir } = setupHeartbeats([
      { name: 'forge', minutesAgo: 2 },
    ]);
    const paths = { ctxRoot, analyticsDir, taskDir: '', stateDir: '', logDir: '' } as any;
    const report = runFleetHealthCheck(paths, analyticsDir);
    const alert = formatSlackAlert(report);
    expect(alert).toContain('Fleet health OK');
  });
});

describe('checkCronGaps', () => {
  it('flags cron_fired events with no matching cron_received after the gap threshold', () => {
    const { analyticsDir } = setupHeartbeats([]);
    const firedAt = new Date(Date.now() - (CRON_GAP_THRESHOLD_MINUTES + 1) * 60000).toISOString();
    writeEvent(analyticsDir, 'forge', 'cron_fired', firedAt, {
      cron: 'heartbeat',
      fired_at: firedAt,
    });

    const gaps = checkCronGaps(analyticsDir);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      agentName: 'forge',
      cronName: 'heartbeat',
      firedAt,
    });
  });

  it('does not flag cron_fired events that have matching cron_received events', () => {
    const { analyticsDir } = setupHeartbeats([]);
    const firedAt = new Date(Date.now() - (CRON_GAP_THRESHOLD_MINUTES + 1) * 60000).toISOString();
    const receivedAt = new Date(new Date(firedAt).getTime() + 60_000).toISOString();
    const metadata = { cron: 'heartbeat', fired_at: firedAt };

    writeEvent(analyticsDir, 'forge', 'cron_fired', firedAt, metadata);
    writeEvent(analyticsDir, 'forge', 'cron_received', receivedAt, metadata);

    const gaps = checkCronGaps(analyticsDir);
    expect(gaps).toHaveLength(0);
  });
});
