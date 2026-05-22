import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runGoalProgressProbe } from '../../../src/bus/goal-progress-probe.js';
import type { BusPaths } from '../../../src/types/index.js';

function makePaths(root: string): BusPaths {
  return {
    root,
    ctxRoot: root,
    analyticsDir: root,
    eventsLog: join(root, 'events.log'),
    inboxDir: join(root, 'inbox'),
    outboxDir: join(root, 'outbox'),
  } as unknown as BusPaths;
}

function writeGoals(agentDir: string, updatedAt: string, goals: string[] = ['ship', 'deploy']) {
  mkdirSync(join(agentDir, 'memory'), { recursive: true });
  writeFileSync(join(agentDir, 'goals.json'), JSON.stringify({ goals, updated_at: updatedAt }));
}

function writeMemory(agentDir: string, date: string, content: string) {
  mkdirSync(join(agentDir, 'memory'), { recursive: true });
  writeFileSync(join(agentDir, 'memory', `${date}.md`), content);
}

function writeHeartbeat(root: string, agentName: string) {
  const dir = join(root, 'state', agentName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ last_heartbeat: new Date().toISOString() }));
}

function isoHoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('runGoalProgressProbe — stamp-stale classification', () => {
  let tmpRoot: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `probe-test-${Date.now()}`);
    agentsDir = join(tmpRoot, 'orgs', 'test-org', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(join(tmpRoot, 'state'), { recursive: true });
    writeFileSync(join(tmpRoot, 'state', 'agents.json'), JSON.stringify({ 'test-agent': { enabled: true } }));
    writeFileSync(join(tmpRoot, 'events.log'), '');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('mentioned=yes + staleGoalsFile=true + recent memory → stamp-stale, NOT stalled', () => {
    const agentDir = join(agentsDir, 'test-agent');
    writeHeartbeat(tmpRoot, 'test-agent');
    // goals.json is 30h old (stale)
    writeGoals(agentDir, isoHoursAgo(30), ['ship', 'deploy']);
    // memory mentions goal terms today
    writeMemory(agentDir, todayDate(), 'Working on ship and deploy tasks today.');

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    const agent = result.agents.find(a => a.agent === 'test-agent');
    expect(agent?.staleGoalsFile).toBe(true);
    expect(agent?.mentioned).toBe(true);

    expect(result.stampStaleAgents.map(a => a.agent)).toContain('test-agent');
    expect(result.stalledAgents.map(a => a.agent)).not.toContain('test-agent');
  });

  it('mentioned=no + staleGoalsFile=true → stalled', () => {
    const agentDir = join(agentsDir, 'test-agent');
    writeHeartbeat(tmpRoot, 'test-agent');
    writeGoals(agentDir, isoHoursAgo(30), ['ship', 'deploy']);
    // memory contains no goal terms
    writeMemory(agentDir, todayDate(), 'Did some unrelated work today.');

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    expect(result.stalledAgents.map(a => a.agent)).toContain('test-agent');
    expect(result.stampStaleAgents.map(a => a.agent)).not.toContain('test-agent');
  });

  it('mentioned=yes + fresh goalsFile → neither stalled nor stamp-stale', () => {
    const agentDir = join(agentsDir, 'test-agent');
    writeHeartbeat(tmpRoot, 'test-agent');
    // goals.json updated 1h ago (fresh)
    writeGoals(agentDir, isoHoursAgo(1), ['ship', 'deploy']);
    writeMemory(agentDir, todayDate(), 'Working on ship and deploy tasks today.');

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    expect(result.stalledAgents.map(a => a.agent)).not.toContain('test-agent');
    expect(result.stampStaleAgents.map(a => a.agent)).not.toContain('test-agent');
  });
});
