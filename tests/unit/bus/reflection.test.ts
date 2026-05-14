import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeTaskReflection, writePostmortem } from '../../../src/bus/reflection';
import type { BusPaths } from '../../../src/types/index';

function makePaths(dir: string): BusPaths {
  return {
    ctxRoot: dir,
    inbox: join(dir, 'inbox'),
    inflight: join(dir, 'inflight'),
    processed: join(dir, 'processed'),
    logDir: join(dir, 'logs'),
    stateDir: join(dir, 'state'),
    taskDir: join(dir, 'tasks'),
    approvalDir: join(dir, 'approvals'),
    analyticsDir: join(dir, 'analytics'),
  };
}

describe('reflection — writeTaskReflection (Hermes #1)', () => {
  let testDir: string;
  let agentDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = join(tmpdir(), `reflection-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    agentDir = join(testDir, 'agent');
    mkdirSync(testDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    paths = makePaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('appends a 3-line reflection block to the daily memory file', () => {
    const result = writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 'task_123',
      worked: 'verify-before-execute caught a false premise',
      failed: 'assumed gitea was reachable from MacBook',
      change: 'format-patch + scp for cross-host deploys',
    });

    expect(result.alreadyExists).toBe(false);
    expect(existsSync(result.memoryPath)).toBe(true);

    const body = readFileSync(result.memoryPath, 'utf-8');
    expect(body).toMatch(/## Task task_123 reflection \(\d{2}:\d{2} UTC\)/);
    expect(body).toContain('- WORKED: verify-before-execute caught a false premise');
    expect(body).toContain('- FAILED: assumed gitea was reachable from MacBook');
    expect(body).toContain('- CHANGE: format-patch + scp for cross-host deploys');
  });

  it('writes to memory/YYYY-MM-DD.md under the agent dir', () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 't1',
      worked: 'w',
      failed: 'f',
      change: 'c',
    });
    expect(result.memoryPath).toBe(join(agentDir, 'memory', `${today}.md`));
  });

  it('is idempotent per (agent, date, task-id) — second call same day flagged', () => {
    writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 'dup',
      worked: 'first',
      failed: 'first',
      change: 'first',
    });
    const second = writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 'dup',
      worked: 'second',
      failed: 'second',
      change: 'second',
    });
    expect(second.alreadyExists).toBe(true);
    const body = readFileSync(second.memoryPath, 'utf-8');
    expect(body).toContain('- WORKED: first');
    expect(body).not.toContain('- WORKED: second');
  });

  it('different task-ids on the same day both append (not deduped)', () => {
    writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 't1',
      worked: 'a',
      failed: 'a',
      change: 'a',
    });
    const r2 = writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 't2',
      worked: 'b',
      failed: 'b',
      change: 'b',
    });
    expect(r2.alreadyExists).toBe(false);
    const body = readFileSync(r2.memoryPath, 'utf-8');
    expect(body).toContain('## Task t1 reflection');
    expect(body).toContain('## Task t2 reflection');
  });

  it('logs a task_reflection event to analytics JSONL', () => {
    const today = new Date().toISOString().slice(0, 10);
    writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 'evt_test',
      worked: 'w',
      failed: 'f',
      change: 'c',
    });
    const eventsPath = join(paths.analyticsDir, 'events', 'dev', `${today}.jsonl`);
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const parsed = lines.map(l => JSON.parse(l));
    const ours = parsed.filter(e => e.event === 'task_reflection');
    expect(ours.length).toBe(1);
    expect(ours[0].metadata.task_id).toBe('evt_test');
    expect(ours[0].metadata.agent).toBe('dev');
  });

  it('creates the memory/ subdir if missing', () => {
    expect(existsSync(join(agentDir, 'memory'))).toBe(false);
    writeTaskReflection(paths, 'dev', 'acme', agentDir, {
      taskId: 't',
      worked: 'w',
      failed: 'f',
      change: 'c',
    });
    expect(existsSync(join(agentDir, 'memory'))).toBe(true);
  });
});

describe('reflection — writePostmortem (Hermes #4)', () => {
  let testDir: string;
  let agentDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = join(tmpdir(), `postmortem-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    agentDir = join(testDir, 'agent');
    mkdirSync(testDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    paths = makePaths(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('appends a 3-line postmortem block to daily memory', () => {
    const result = writePostmortem(paths, 'dev', 'acme', agentDir, {
      mistake: 'tried to git fetch gitea from MacBook',
      rootCause: 'assumed tailnet routed port 3030; it does not',
      prevention: 'cross-host code moves use format-patch + scp + git am',
    });
    const body = readFileSync(result.memoryPath, 'utf-8');
    expect(body).toMatch(/## Postmortem \d{2}:\d{2} UTC\n/);
    expect(body).toContain('- MISTAKE: tried to git fetch gitea from MacBook');
    expect(body).toContain('- ROOT CAUSE: assumed tailnet routed port 3030');
    expect(body).toContain('- PREVENTION: cross-host code moves use format-patch');
  });

  it('includes related event id in the header when provided', () => {
    const result = writePostmortem(paths, 'dev', 'acme', agentDir, {
      mistake: 'm',
      rootCause: 'r',
      prevention: 'p',
      relatedEventId: 'evt-abc123',
    });
    const body = readFileSync(result.memoryPath, 'utf-8');
    expect(body).toMatch(/## Postmortem \d{2}:\d{2} UTC \(event evt-abc123\)/);
  });

  it('allows multiple postmortems per day (not deduped, unlike reflections)', () => {
    writePostmortem(paths, 'dev', 'acme', agentDir, { mistake: 'm1', rootCause: 'r1', prevention: 'p1' });
    writePostmortem(paths, 'dev', 'acme', agentDir, { mistake: 'm2', rootCause: 'r2', prevention: 'p2' });
    const today = new Date().toISOString().slice(0, 10);
    const body = readFileSync(join(agentDir, 'memory', `${today}.md`), 'utf-8');
    expect(body).toContain('- MISTAKE: m1');
    expect(body).toContain('- MISTAKE: m2');
    expect((body.match(/## Postmortem /g) || []).length).toBe(2);
  });

  it('logs a postmortem_filed event with related_event metadata', () => {
    const today = new Date().toISOString().slice(0, 10);
    writePostmortem(paths, 'dev', 'acme', agentDir, {
      mistake: 'm',
      rootCause: 'r',
      prevention: 'p',
      relatedEventId: 'evt-xyz',
    });
    const eventsPath = join(paths.analyticsDir, 'events', 'dev', `${today}.jsonl`);
    expect(existsSync(eventsPath)).toBe(true);
    const parsed = readFileSync(eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const ours = parsed.filter(e => e.event === 'postmortem_filed');
    expect(ours.length).toBe(1);
    expect(ours[0].metadata.related_event).toBe('evt-xyz');
  });

  it('omits related_event from metadata when not provided', () => {
    const today = new Date().toISOString().slice(0, 10);
    writePostmortem(paths, 'dev', 'acme', agentDir, {
      mistake: 'm',
      rootCause: 'r',
      prevention: 'p',
    });
    const parsed = readFileSync(join(paths.analyticsDir, 'events', 'dev', `${today}.jsonl`), 'utf-8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    const ours = parsed.filter(e => e.event === 'postmortem_filed');
    expect(ours[0].metadata.related_event).toBeUndefined();
  });
});
