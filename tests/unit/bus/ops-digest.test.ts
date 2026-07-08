import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateOpsDigest } from '../../../src/bus/ops-digest.js';

describe('generateOpsDigest', () => {
  const testDir = join(tmpdir(), `cortextos-ops-digest-${Date.now()}`);
  const ctxRoot = join(testDir, 'ctx');
  const projectRoot = join(testDir, 'project');
  const org = 'testorg';

  beforeEach(() => {
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    mkdirSync(join(ctxRoot, 'orgs', org, 'tasks'), { recursive: true });
    mkdirSync(join(ctxRoot, 'orgs', org, 'approvals', 'pending'), { recursive: true });
    mkdirSync(join(ctxRoot, 'orgs', org, 'analytics', 'events'), { recursive: true });
    mkdirSync(join(projectRoot, 'orgs', org, 'agents'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns an empty agent list when no agents are enabled', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}', 'utf-8');
    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    expect(digest.org).toBe(org);
    expect(digest.agents).toEqual([]);
    expect(digest.system.agents_total).toBe(0);
  });

  it('only includes agents enabled for the requested org', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      bot1: { enabled: true, org },
      bot2: { enabled: true, org: 'other-org' },
    }), 'utf-8');

    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    expect(digest.agents.map(a => a.name)).toEqual(['bot1']);
  });

  it('aggregates task counts, heartbeat health, and stale goals per agent', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      bot1: { enabled: true, org },
    }), 'utf-8');
    mkdirSync(join(ctxRoot, 'state', 'bot1'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'bot1', 'heartbeat.json'), JSON.stringify({
      last_heartbeat: new Date().toISOString(),
    }), 'utf-8');

    writeFileSync(join(ctxRoot, 'orgs', org, 'tasks', 'task_1.json'), JSON.stringify({
      assigned_to: 'bot1', status: 'completed', title: 'Fix the thing',
      completed_at: new Date().toISOString(),
    }), 'utf-8');
    writeFileSync(join(ctxRoot, 'orgs', org, 'tasks', 'task_2.json'), JSON.stringify({
      assigned_to: 'bot1', status: 'pending', title: 'Do the other thing',
    }), 'utf-8');

    // No GOALS.md written for bot1 under projectRoot -> stale/missing.
    mkdirSync(join(projectRoot, 'orgs', org, 'agents', 'bot1'), { recursive: true });

    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    const bot1 = digest.agents.find(a => a.name === 'bot1')!;
    expect(bot1.tasks_completed).toBe(1);
    expect(bot1.tasks_pending).toBe(1);
    expect(bot1.heartbeat_stale).toBe(false);
    expect(bot1.goals_stale).toBe(true);
    expect(bot1.goals_status).toBe('missing');
    expect(bot1.recent_completed_titles).toEqual(['Fix the thing']);
  });

  it('excludes tasks completed outside the recent window', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      bot1: { enabled: true, org },
    }), 'utf-8');

    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(ctxRoot, 'orgs', org, 'tasks', 'task_1.json'), JSON.stringify({
      assigned_to: 'bot1', status: 'completed', title: 'Old task', completed_at: oldDate,
    }), 'utf-8');

    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    const bot1 = digest.agents.find(a => a.name === 'bot1')!;
    expect(bot1.tasks_completed).toBe(1);
    expect(bot1.recent_completed_titles).toEqual([]);
  });

  it('reads yesterday\'s memory file tail when present', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      bot1: { enabled: true, org },
    }), 'utf-8');

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const memDir = join(projectRoot, 'orgs', org, 'agents', 'bot1', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${yesterday}.md`), '## Heartbeat Update\n- WORKING ON: task1\n', 'utf-8');

    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    const bot1 = digest.agents.find(a => a.name === 'bot1')!;
    expect(bot1.memory_tail).toContain('WORKING ON: task1');
  });

  it('returns null memory_tail when no memory file exists', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      bot1: { enabled: true, org },
    }), 'utf-8');

    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    const bot1 = digest.agents.find(a => a.name === 'bot1')!;
    expect(bot1.memory_tail).toBeNull();
  });

  it('carries system-wide metrics through from collectMetrics', () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      bot1: { enabled: true, org },
    }), 'utf-8');
    writeFileSync(join(ctxRoot, 'orgs', org, 'approvals', 'pending', 'ap1.json'), '{}', 'utf-8');

    const digest = generateOpsDigest(ctxRoot, projectRoot, org);
    expect(digest.system.agents_total).toBe(1);
    expect(digest.system.approvals_pending).toBe(1);
  });
});
