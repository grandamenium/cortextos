import { describe, it, expect } from 'vitest';
import { formatTaskTable } from '../../../src/cli/bus';
import type { Task } from '../../../src/types';

// Regression tests for the list-tasks text render. The previous fixed-width
// table cut every 27-char `task_<13-digit-ms>_<8-digit>` id down to 26 chars
// AND left zero spacing before the assignee column — so copying an id out of
// the table yielded a plausible-but-wrong value (last digit swallowed, or the
// assignee's first characters glued on). Ids in the table must round-trip.

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task_1784904117380_59872553',
    title: 'A task',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'dev',
    created_by: 'chief',
    org: 'acme',
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: '2026-07-24T00:00:00Z',
    updated_at: '2026-07-24T00:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  } as Task;
}

describe('formatTaskTable', () => {
  it('renders the full task id — never truncated', () => {
    const id = 'task_1784904117380_59872553'; // 27 chars, the real id shape
    const out = formatTaskTable([makeTask({ id })]);
    expect(out).toContain(id);
  });

  it('separates every column with at least two spaces (id never touches assignee)', () => {
    const id = 'task_1784904117380_59872553';
    const out = formatTaskTable([makeTask({ id, assigned_to: 'dev' })]);
    const row = out.split('\n').find(l => l.includes(id))!;
    expect(row).toBeDefined();
    // The character run starting at the id must end exactly at the id —
    // followed by spacing, not glued to the assignee.
    expect(row).toMatch(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s{2,}dev'));
    expect(row).not.toContain(id + 'dev');
  });

  it('sizes the id column from the data, so longer ids still fit', () => {
    const longId = 'task_1784904117380_598725531234'; // longer than the standard shape
    const out = formatTaskTable([makeTask({ id: longId })]);
    expect(out).toContain(longId);
  });

  it('marks title truncation visibly with an ellipsis', () => {
    const longTitle = 'x'.repeat(80);
    const out = formatTaskTable([makeTask({ title: longTitle })]);
    expect(out).toContain('…');
    expect(out).not.toContain(longTitle);
  });

  it('keeps short titles untouched', () => {
    const out = formatTaskTable([makeTask({ title: 'Short title' })]);
    expect(out).toContain('Short title');
    expect(out).not.toContain('…');
  });
});
