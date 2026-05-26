import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BusPaths } from '../../../src/types';
import { runHeartbeatHealthWatch } from '../../../src/bus/heartbeat-health-watch';

let root: string;
let previousCtxRoot: string | undefined;

function paths(): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state', 'watcher'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    deliverablesDir: join(root, 'orgs', 'test-org', 'deliverables'),
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function writeHeartbeat(agent: string, minutesAgo: number): void {
  writeJson(join(root, 'state', agent, 'heartbeat.json'), {
    status: 'online',
    last_heartbeat: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
}

function writeAgentConfig(projectRoot: string, agent: string, interval: string): void {
  writeJson(join(projectRoot, 'orgs', 'test-org', 'agents', agent, 'config.json'), {
    crons: [{ name: 'heartbeat', interval }],
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'heartbeat-health-watch-'));
  previousCtxRoot = process.env.CTX_ROOT;
  process.env.CTX_ROOT = root;
});

afterEach(() => {
  if (previousCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = previousCtxRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('runHeartbeatHealthWatch', () => {
  it('uses heartbeat cron interval times 1.5 for each agent', () => {
    const projectRoot = join(root, 'project');
    writeAgentConfig(projectRoot, 'fast', '30m');
    writeAgentConfig(projectRoot, 'hourly', '1h');
    writeHeartbeat('fast', 50);
    writeHeartbeat('hourly', 80);

    const report = runHeartbeatHealthWatch(
      paths(),
      'watcher',
      'test-org',
      projectRoot,
      new Set(['fast', 'hourly']),
      { thresholdMinutes: 45 },
    );

    const fast = report.agents.find(agent => agent.agent === 'fast');
    const hourly = report.agents.find(agent => agent.agent === 'hourly');

    expect(fast?.thresholdMinutes).toBe(45);
    expect(fast?.stale).toBe(true);
    expect(hourly?.thresholdMinutes).toBe(45);
    expect(hourly?.stale).toBe(true);
    expect(report.staleRunningAgents.map(agent => agent.agent)).toEqual(['fast', 'hourly']);
  });

  it('caps long heartbeat intervals to the explicit watch threshold', () => {
    const projectRoot = join(root, 'project');
    writeAgentConfig(projectRoot, 'day-agent', '4h');
    writeHeartbeat('day-agent', 247);

    const report = runHeartbeatHealthWatch(
      paths(),
      'watcher',
      'test-org',
      projectRoot,
      new Set(['day-agent']),
      { thresholdMinutes: 120 },
    );

    const dayAgent = report.agents.find(agent => agent.agent === 'day-agent');
    expect(dayAgent?.thresholdMinutes).toBe(120);
    expect(dayAgent?.stale).toBe(true);
    expect(report.staleRunningAgents.map(agent => agent.agent)).toEqual(['day-agent']);
  });

  it('falls back to the CLI threshold when no heartbeat cron interval is available', () => {
    const projectRoot = join(root, 'project');
    mkdirSync(join(projectRoot, 'orgs', 'test-org', 'agents', 'legacy'), { recursive: true });
    writeHeartbeat('legacy', 50);

    const report = runHeartbeatHealthWatch(
      paths(),
      'watcher',
      'test-org',
      projectRoot,
      new Set(['legacy']),
      { thresholdMinutes: 90 },
    );

    const legacy = report.agents.find(agent => agent.agent === 'legacy');
    expect(legacy?.thresholdMinutes).toBe(90);
    expect(legacy?.stale).toBe(false);
  });
});
