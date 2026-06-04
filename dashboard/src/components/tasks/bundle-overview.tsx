'use client';

import { useState } from 'react';
import { IconChevronDown, IconChevronRight, IconChecklist } from '@tabler/icons-react';
import type { Task } from '@/lib/types';

interface BundleGroup {
  bundleId: string;
  tasks: Task[];
  total: number;
  completed: number;
}

// status → coloured dot
const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-500',
  in_progress: 'bg-amber-500',
  blocked: 'bg-red-500',
  pending: 'bg-muted-foreground/40',
};

function groupByBundle(tasks: Task[]): BundleGroup[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.bundle_id) continue;
    const arr = map.get(t.bundle_id) ?? [];
    arr.push(t);
    map.set(t.bundle_id, arr);
  }
  return [...map.entries()]
    .map(([bundleId, ts]) => ({
      bundleId,
      tasks: ts
        .slice()
        .sort((a, b) => (a.assignee ?? '').localeCompare(b.assignee ?? '')),
      total: ts.length,
      completed: ts.filter((t) => t.status === 'completed').length,
    }))
    // least-complete bundles first (the work in flight)
    .sort((a, b) => a.completed / a.total - b.completed / b.total);
}

export function BundleOverview({
  tasks,
  onTaskClick,
}: {
  tasks: Task[];
  onTaskClick?: (t: Task) => void;
}) {
  const groups = groupByBundle(tasks);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <IconChecklist size={48} className="mb-4 text-muted-foreground/30" />
        <h3 className="mb-1 text-lg font-medium">Keine Bundles</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          Bundles fassen die Subtasks eines Features rollenübergreifend zusammen.
          Tasks mit einem <code>bundle_id</code> erscheinen hier mit Fortschrittsbalken.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const pct = g.total ? Math.round((g.completed / g.total) * 100) : 0;
        const isOpen = !closed[g.bundleId];
        return (
          <div key={g.bundleId} className="rounded-xl border bg-card">
            <button
              onClick={() =>
                setClosed((p) => ({ ...p, [g.bundleId]: isOpen }))
              }
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              {isOpen ? (
                <IconChevronDown className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium">{g.bundleId}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {g.completed}/{g.total} fertig
              </span>
              <div className="h-2 w-28 shrink-0 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {pct}%
              </span>
            </button>
            {isOpen && (
              <ul className="divide-y border-t">
                {g.tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => onTaskClick?.(t)}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/40"
                    >
                      <span
                        className={`size-2 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? 'bg-muted-foreground/40'}`}
                      />
                      <span className="truncate text-sm">{t.title}</span>
                      {t.assignee && (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {t.assignee}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {t.status}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
