'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/shared';
import { ParkedAgentDock } from './agent-cursor';
import { TaskCard } from './task-card';
import type { AgentPresencePayload } from '@/lib/agent-presence';
import type { Task, TaskStatus } from '@/lib/types';

interface KanbanColumn {
  status: TaskStatus;
  label: string;
  tasks: Task[];
}

interface KanbanBoardProps {
  tasks: Task[];
  completedTodayTasks: Task[];
  presenceByTask?: Record<string, AgentPresencePayload[]>;
  parkedPresence?: AgentPresencePayload[];
  onTaskClick: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => Promise<void>;
}

export function KanbanBoard({
  tasks,
  completedTodayTasks,
  presenceByTask = {},
  parkedPresence = [],
  onTaskClick,
  onStatusChange,
}: KanbanBoardProps) {
  const columns: KanbanColumn[] = [
    {
      status: 'pending',
      label: 'Pending',
      tasks: tasks.filter((t) => t.status === 'pending'),
    },
    {
      status: 'in_progress',
      label: 'In Progress',
      tasks: tasks.filter((t) => t.status === 'in_progress'),
    },
    {
      status: 'blocked',
      label: 'Blocked',
      tasks: tasks.filter((t) => t.status === 'blocked'),
    },
    {
      status: 'completed',
      label: 'Completed (today)',
      tasks: completedTodayTasks,
    },
  ];

  return (
    <>
      <div className="space-y-4 md:hidden">
        <ParkedAgentDock presence={parkedPresence} />
        {columns.map((col) => (
          <section key={col.status} className="space-y-2">
            <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between border-y bg-background/95 px-4 py-2 backdrop-blur">
              <div className="flex items-center gap-2">
                <StatusBadge status={col.status} />
                <span className="text-xs text-muted-foreground">
                  {col.tasks.length}
                </span>
              </div>
            </div>
            <div className="space-y-2">
              {col.tasks.length === 0 ? (
                <div className="rounded-xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  No tasks
                </div>
              ) : (
                col.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    presence={presenceByTask[task.id]}
                    onClick={onTaskClick}
                    onStatusChange={onStatusChange}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </div>

      <div className="hidden space-y-3 md:block">
        <ParkedAgentDock presence={parkedPresence} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {columns.map((col) => (
          <div key={col.status} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={col.status} />
                <span className="text-xs text-muted-foreground">
                  {col.tasks.length}
                </span>
              </div>
            </div>
            <ScrollArea className="h-[calc(100vh-280px)] min-h-[300px]">
              <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
                {col.tasks.length === 0 ? (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                    No tasks
                  </p>
                ) : (
                  col.tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      presence={presenceByTask[task.id]}
                      onClick={onTaskClick}
                      onStatusChange={onStatusChange}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        ))}
        </div>
      </div>
    </>
  );
}
