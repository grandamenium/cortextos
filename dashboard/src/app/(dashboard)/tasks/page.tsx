'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useOrg } from '@/hooks/use-org';
import { Button } from '@/components/ui/button';
import { IconLayoutKanban, IconList, IconChecklist } from '@tabler/icons-react';
import { KanbanBoard } from '@/components/tasks/kanban-board';
import { TaskListTable } from '@/components/tasks/task-list-table';
import { TaskDetailSheet } from '@/components/tasks/task-detail-sheet';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { TaskFilters } from '@/components/tasks/task-filters';
import { useAgentPresence } from '@/hooks/use-agent-presence';
import { paletteForAgent } from '@/components/tasks/agent-cursor';
import type { Task, TaskStatus } from '@/lib/types';

type ViewMode = 'kanban' | 'list';

const DEFAULT_FILTERS = {
  org: 'all',
  agent: 'all',
  priority: 'all',
  project: 'all',
  status: 'all',
};

export default function TasksPage() {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();

  const [view, setView] = useState<ViewMode>('kanban');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [completedToday, setCompletedToday] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [liveAgents, setLiveAgents] = useState<string[]>([]);
  const { presence, presenceByTask, parkedPresence } = useAgentPresence();

  // Fetch live agent list from enabled-agents registry (not task assignees) so
  // archived agents disappear and new agents appear without needing task history.
  useEffect(() => {
    fetch('/api/agents')
      .then((r) => r.ok ? r.json() : [])
      .then((data: Array<{ name: string }>) => setLiveAgents(data.map((a) => a.name).sort()))
      .catch(() => {});
  }, []);

  // Derive unique values for filter dropdowns
  const allTasks = tasks;
  const taskAgents = [...new Set(allTasks.map((t) => t.assignee).filter(Boolean) as string[])];
  // Merge live registry with task assignees; live registry is authoritative for known agents
  const agents = [...new Set([...liveAgents, ...taskAgents])].sort();
  const projects = [...new Set(allTasks.map((t) => t.project).filter(Boolean) as string[])];
  const orgs = [...new Set(allTasks.map((t) => t.org))];

  const fetchTasks = useCallback(async () => {
    const params = new URLSearchParams();
    const effectiveOrg = currentOrg !== 'all' ? currentOrg : (filters.org !== 'all' ? filters.org : '');
    if (effectiveOrg) params.set('org', effectiveOrg);
    if (filters.agent !== 'all') params.set('agent', filters.agent);
    if (filters.priority !== 'all') params.set('priority', filters.priority);
    if (filters.status !== 'all') params.set('status', filters.status);
    if (filters.project !== 'all') params.set('project', filters.project);

    try {
      // Build completed params with same filters (except status)
      const completedParams = new URLSearchParams(params);
      completedParams.set('status', 'completed');
      completedParams.delete('status'); // remove any existing non-completed status
      completedParams.set('status', 'completed');

      const [tasksRes, completedRes] = await Promise.all([
        fetch(`/api/tasks?${params.toString()}`),
        fetch(`/api/tasks?${completedParams.toString()}`),
      ]);

      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setTasks(data);
      }
      if (completedRes.ok) {
        const data: Task[] = await completedRes.json();
        // Filter to completed today only
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        setCompletedToday(
          data.filter((t) => t.completed_at && new Date(t.completed_at) >= todayStart)
        );
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [currentOrg, filters]);

  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [fetchTasks]);

  function handleFilterChange(key: string, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function handleClearFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  function handleTaskClick(task: Task) {
    setSelectedTask(task);
    setSheetOpen(true);
  }

  const selectedTaskId = searchParams.get('task');

  useEffect(() => {
    if (!selectedTaskId) return;

    const matchingTask = tasks.find((task) => task.id === selectedTaskId);
    if (matchingTask) {
      setSelectedTask(matchingTask);
      setSheetOpen(true);
      return;
    }

    let cancelled = false;
    async function fetchSelectedTask() {
      try {
        const res = await fetch(`/api/tasks/${selectedTaskId}`);
        if (!cancelled && res.ok) {
          const task = await res.json();
          setSelectedTask(task);
          setSheetOpen(true);
        }
      } catch {
        // Deep-link selection is best-effort; the board still renders normally.
      }
    }

    fetchSelectedTask();
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, tasks]);

  async function handleStatusChange(taskId: string, status: TaskStatus, note?: string) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      });

      if (res.ok) {
        setSheetOpen(false);
        setSelectedTask(null);
        fetchTasks();
      }
    } catch {
      // Silently fail
    }
  }

  async function handleQuickStatusChange(taskId: string, status: TaskStatus) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) fetchTasks();
    } catch {
      // Silently fail
    }
  }

  async function handleDelete(taskId: string) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (res.ok) {
        setSheetOpen(false);
        setSelectedTask(null);
        fetchTasks();
      }
    } catch {
      // Silently fail
    }
  }

  // Filter tasks for display (non-completed for kanban columns, all for list)
  const displayTasks = view === 'kanban'
    ? tasks.filter((t) => t.status !== 'completed')
    : tasks;

  const hasActiveFilters = Object.values(filters).some((v) => v !== 'all');

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <div className="space-y-4">
          <div className="h-10 w-full rounded-lg bg-muted/30 animate-pulse" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-64 rounded-xl bg-muted/30 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="grid grid-cols-2 items-center rounded-lg border bg-muted/30 p-0.5 sm:flex">
            <Button
              variant={view === 'kanban' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setView('kanban')}
              className="justify-center"
            >
              <IconLayoutKanban className="size-3.5" />
              Board
            </Button>
            <Button
              variant={view === 'list' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setView('list')}
              className="justify-center"
            >
              <IconList className="size-3.5" />
              List
            </Button>
          </div>
          <div className="sm:shrink-0">
            <CreateTaskDialog
              agents={agents}
              projects={projects}
              onCreated={fetchTasks}
            />
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:overflow-visible sm:px-0 sm:pb-0">
        <TaskFilters
          orgs={orgs}
          agents={agents}
          projects={projects}
          filters={filters}
          onChange={handleFilterChange}
          onClearAll={handleClearFilters}
        />
      </div>

      {presence.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/25 px-3 py-2"
          data-active-agents-banner="true"
        >
          <span className="text-xs font-medium text-muted-foreground">
            Active agents
          </span>
          {presence.slice(0, 8).map((item) => {
            const palette = paletteForAgent(item.actor_id);
            return (
              <span
                key={item.actor_id}
                className="inline-flex min-h-6 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium shadow-sm"
                style={{ borderColor: palette.ring, boxShadow: `inset 3px 0 0 ${palette.accent}` }}
                title={item.action_label || item.cursor_position_hint || item.current_action || item.status}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: palette.accent }} />
                {item.name}
              </span>
            );
          })}
          {presence.length > 8 && (
            <span className="text-xs text-muted-foreground">
              +{presence.length - 8}
            </span>
          )}
        </div>
      )}

      {/* Content */}
      {tasks.length === 0 ? (
        hasActiveFilters ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <IconChecklist size={48} className="text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-1">No tasks match your filters</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Your current view is scoped to specific agents, projects, or statuses. Clear filters to see all tasks.
            </p>
            <Button variant="outline" size="sm" onClick={handleClearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <IconChecklist size={48} className="text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-1">No tasks yet</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Create your first task to start tracking work across your agents.
            </p>
            <CreateTaskDialog
              agents={agents}
              projects={projects}
              onCreated={fetchTasks}
            />
          </div>
        )
      ) : view === 'kanban' ? (
        <KanbanBoard
          tasks={displayTasks}
          completedTodayTasks={completedToday}
          presenceByTask={presenceByTask}
          parkedPresence={parkedPresence}
          onTaskClick={handleTaskClick}
          onStatusChange={handleQuickStatusChange}
        />
      ) : (
        <TaskListTable
          tasks={displayTasks}
          presenceByTask={presenceByTask}
          onTaskClick={handleTaskClick}
          onStatusChange={handleQuickStatusChange}
        />
      )}

      {/* Task detail sheet */}
      <TaskDetailSheet
        task={selectedTask}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onStatusChange={handleStatusChange}
        onDelete={handleDelete}
        onEdit={() => { setSheetOpen(false); setSelectedTask(null); fetchTasks(); }}
      />
    </div>
  );
}
