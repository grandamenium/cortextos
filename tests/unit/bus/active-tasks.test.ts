import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  renderActiveTasksBoard,
  writeActiveTasksBoard,
  ACTIVE_TASKS_REL,
  PLACEHOLDER,
} from '../../../src/bus/active-tasks';
import type { Task } from '../../../src/types';

function mkTask(p: Partial<Task>): Task {
  return {
    id: 'task_1',
    title: 'a task',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'agentX',
    created_by: 'creator',
    org: 'o',
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-01T11:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...p,
  };
}

const NOW = '2026-06-03T12:00:00Z';

describe('active-tasks board renderer', () => {
  it('replaces the dead-updater placeholder with real rows', () => {
    const md = renderActiveTasksBoard([mkTask({ id: 'task_a', status: 'in_progress', title: 'do the thing' })], NOW);
    expect(md).not.toContain(PLACEHOLDER);
    expect(md).toContain('task_a');
    expect(md).toContain('do the thing');
  });

  it('groups tasks into in-progress / open / blocked and counts them', () => {
    const md = renderActiveTasksBoard([
      mkTask({ id: 'ip', status: 'in_progress' }),
      mkTask({ id: 'op1', status: 'pending' }),
      mkTask({ id: 'op2', status: 'pending' }),
      mkTask({ id: 'bl', status: 'blocked' }),
    ], NOW);
    expect(md).toMatch(/4 active \(1 in-progress, 2 open, 1 blocked\)/);
    // section membership
    const ipSection = md.slice(md.indexOf('## Currently in-progress'), md.indexOf('## Open'));
    expect(ipSection).toContain('ip');
    expect(ipSection).not.toContain('op1');
  });

  it('excludes completed, cancelled, and archived tasks', () => {
    const md = renderActiveTasksBoard([
      mkTask({ id: 'done', status: 'completed' }),
      mkTask({ id: 'cancelled', status: 'cancelled' }),
      mkTask({ id: 'arch', status: 'in_progress', archived: true }),
      mkTask({ id: 'live', status: 'in_progress' }),
    ], NOW);
    expect(md).toContain('live');
    expect(md).not.toContain('done');
    expect(md).not.toContain('cancelled');
    expect(md).not.toContain('arch');
    expect(md).toMatch(/1 active \(1 in-progress, 0 open, 0 blocked\)/);
  });

  it('renders _none_ for an empty board without throwing', () => {
    const md = renderActiveTasksBoard([], NOW);
    expect(md).toMatch(/0 active \(0 in-progress, 0 open, 0 blocked\)/);
    expect(md).toContain('_none_');
    expect(md).not.toContain(PLACEHOLDER);
  });

  it('escapes pipes/newlines so a title cannot break the table', () => {
    const md = renderActiveTasksBoard([mkTask({ id: 'x', status: 'in_progress', title: 'a | b\nc' })], NOW);
    expect(md).toContain('a \\| b c');
  });

  it('sorts a section by priority (urgent first)', () => {
    const md = renderActiveTasksBoard([
      mkTask({ id: 'low1', status: 'pending', priority: 'low' }),
      mkTask({ id: 'urgent1', status: 'pending', priority: 'urgent' }),
    ], NOW);
    expect(md.indexOf('urgent1')).toBeLessThan(md.indexOf('low1'));
  });

  it('annotates a bundle_id when present (feature-bundle awareness)', () => {
    const t = { ...mkTask({ id: 'b1', status: 'in_progress', title: 'slice' }), bundle_id: 'B-rezept-flow' } as Task;
    const md = renderActiveTasksBoard([t], NOW);
    expect(md).toContain('bundle: B-rezept-flow');
  });

  it('carries the render timestamp in front-matter and header', () => {
    const md = renderActiveTasksBoard([], NOW);
    expect(md).toContain(`generated: ${NOW}`);
    expect(md).toContain(`Last render: ${NOW}`);
  });
});

describe('writeActiveTasksBoard', () => {
  let vaultRoot: string;
  beforeEach(() => { vaultRoot = mkdtempSync(join(tmpdir(), 'cortextos-vault-')); });
  afterEach(() => rmSync(vaultRoot, { recursive: true, force: true }));

  it('creates agent-shared/ and writes the board atomically', () => {
    const out = writeActiveTasksBoard(vaultRoot, [mkTask({ id: 'w1', status: 'in_progress' })], NOW);
    expect(out).toBe(join(vaultRoot, ACTIVE_TASKS_REL));
    expect(existsSync(out)).toBe(true);
    const content = readFileSync(out, 'utf-8');
    expect(content).toContain('w1');
    expect(content).not.toContain(PLACEHOLDER);
  });
});
