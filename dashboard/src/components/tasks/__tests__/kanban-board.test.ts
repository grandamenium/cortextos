import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KanbanBoard } from '../kanban-board';
import type { Task } from '@/lib/types';

function makeTask(id: string, status: Task['status'], title: string): Task {
  return {
    id,
    title,
    description: '',
    status,
    priority: 'normal',
    assignee: 'paul',
    org: 'acme',
    project: 'ops',
    needs_approval: false,
    created_at: '2026-06-27T00:00:00Z',
    updated_at: '2026-06-27T00:00:00Z',
  };
}

describe('KanbanBoard', () => {
  it('renders Waiting in the board between In Progress and Blocked', () => {
    const html = renderToStaticMarkup(
      createElement(KanbanBoard, {
        tasks: [
          makeTask('task-pending', 'pending', 'Pending task'),
          makeTask('task-progress', 'in_progress', 'In progress task'),
          makeTask('task-waiting', 'waiting', 'Waiting task'),
          makeTask('task-blocked', 'blocked', 'Blocked task'),
        ],
        completedTodayTasks: [
          makeTask('task-completed', 'completed', 'Completed task'),
        ],
        onTaskClick: () => undefined,
        onTaskMove: async () => undefined,
      }),
    );

    expect(html).toContain('Waiting');
    expect(html.indexOf('Pending')).toBeLessThan(html.indexOf('In Progress'));
    expect(html.indexOf('In Progress')).toBeLessThan(html.indexOf('Waiting'));
    expect(html.indexOf('Waiting')).toBeLessThan(html.indexOf('Blocked'));
    expect(html.indexOf('Blocked')).toBeLessThan(html.indexOf('Completed'));
  });
});
