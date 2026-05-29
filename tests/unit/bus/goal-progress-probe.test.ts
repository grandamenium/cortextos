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
    taskDir: join(root, 'orgs', 'test-org', 'tasks'),
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

/** Write a minimal task JSON that the hasOrchIssuedTaskInLast24h helper can parse. */
function writeTask(
  taskDir: string,
  taskId: string,
  opts: { assigned_to: string; created_by: string; created_at: string },
) {
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, `${taskId}.json`),
    JSON.stringify({
      id: taskId,
      title: 'test task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: opts.assigned_to,
      created_by: opts.created_by,
      org: 'test-org',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: opts.created_at,
      updated_at: opts.created_at,
      completed_at: null,
      due_date: null,
      archived: false,
    }),
  );
}

describe('runGoalProgressProbe — codex-runtime idle suppression', () => {
  let tmpRoot: string;
  let agentsDir: string;
  let taskDir: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `probe-codex-test-${Date.now()}`);
    agentsDir = join(tmpRoot, 'orgs', 'test-org', 'agents');
    taskDir = join(tmpRoot, 'orgs', 'test-org', 'tasks');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(join(tmpRoot, 'state'), { recursive: true });
    writeFileSync(join(tmpRoot, 'events.log'), '');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('idle codex-runtime agent with no orch-issued tasks in 24h → suppressed (not in agents list)', () => {
    const agentName = 'codex';
    const agentDir = join(agentsDir, agentName);
    writeHeartbeat(tmpRoot, agentName);
    writeGoals(agentDir, isoHoursAgo(30), ['ship', 'deploy']);
    writeMemory(agentDir, todayDate(), 'Did some unrelated work today.');
    // Write agent config marking it as codex-app-server runtime
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: agentName, runtime: 'codex-app-server', enabled: true }));
    // No tasks written → no orch-issued tasks in last 24h

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    // Agent should be suppressed entirely — not in agents list, not in stalled
    expect(result.agents.map(a => a.agent)).not.toContain(agentName);
    expect(result.stalledAgents.map(a => a.agent)).not.toContain(agentName);
  });

  it('idle mac-codex agent (name-based detection) with no orch-issued tasks → suppressed', () => {
    const agentName = 'mac-codex';
    const agentDir = join(agentsDir, agentName);
    writeHeartbeat(tmpRoot, agentName);
    writeGoals(agentDir, isoHoursAgo(30), ['ship', 'deploy']);
    writeMemory(agentDir, todayDate(), 'Did some unrelated work today.');
    // mac-codex has runtime: "script" — detection falls back to name substring
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: agentName, runtime: 'script', enabled: true }));
    // No tasks written

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    expect(result.agents.map(a => a.agent)).not.toContain(agentName);
    expect(result.stalledAgents.map(a => a.agent)).not.toContain(agentName);
  });

  it('codex-runtime agent WITH an orch-issued task in last 24h but no goal mentions → still flagged as stalled', () => {
    const agentName = 'codex-2';
    const agentDir = join(agentsDir, agentName);
    writeHeartbeat(tmpRoot, agentName);
    writeGoals(agentDir, isoHoursAgo(30), ['ship', 'deploy']);
    writeMemory(agentDir, todayDate(), 'Did some unrelated work today.');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: agentName, runtime: 'codex-app-server', enabled: true }));
    // Write a recent orch-issued task → agent should NOT be suppressed
    writeTask(taskDir, 'task-001', {
      assigned_to: agentName,
      created_by: 'orchestrator',
      created_at: isoHoursAgo(2),
    });

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    // Agent is tracked — it has an active assignment but no goal mentions → stalled
    expect(result.agents.map(a => a.agent)).toContain(agentName);
    expect(result.stalledAgents.map(a => a.agent)).toContain(agentName);
  });

  it('codex-runtime agent WITH an orch-issued task AND goal mentions in memory → neither stalled nor suppressed', () => {
    const agentName = 'codex-3';
    const agentDir = join(agentsDir, agentName);
    writeHeartbeat(tmpRoot, agentName);
    writeGoals(agentDir, isoHoursAgo(2), ['ship', 'deploy']);
    writeMemory(agentDir, todayDate(), 'Working on ship and deploy tasks today.');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: agentName, runtime: 'codex-app-server', enabled: true }));
    writeTask(taskDir, 'task-002', {
      assigned_to: agentName,
      created_by: 'orchestrator',
      created_at: isoHoursAgo(1),
    });

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    expect(result.agents.map(a => a.agent)).toContain(agentName);
    expect(result.stalledAgents.map(a => a.agent)).not.toContain(agentName);
    expect(result.stampStaleAgents.map(a => a.agent)).not.toContain(agentName);
  });

  it('codex-runtime agent with only old tasks (>24h) → suppressed as if no tasks', () => {
    const agentName = 'codex';
    const agentDir = join(agentsDir, agentName);
    writeHeartbeat(tmpRoot, agentName);
    writeGoals(agentDir, isoHoursAgo(30), ['ship', 'deploy']);
    writeMemory(agentDir, todayDate(), 'Did some unrelated work today.');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ agent_name: agentName, runtime: 'codex-app-server', enabled: true }));
    // Task created 25h ago — outside the 24h window
    writeTask(taskDir, 'task-old', {
      assigned_to: agentName,
      created_by: 'orchestrator',
      created_at: isoHoursAgo(25),
    });

    const result = runGoalProgressProbe(makePaths(tmpRoot), 'orchestrator', 'test-org', tmpRoot);

    expect(result.agents.map(a => a.agent)).not.toContain(agentName);
    expect(result.stalledAgents.map(a => a.agent)).not.toContain(agentName);
  });
});

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
