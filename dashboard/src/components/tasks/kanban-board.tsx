'use client';

import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/shared';
import { TaskCard } from './task-card';
import type { Task, TaskStatus } from '@/lib/types';

interface DroppableColumnProps {
  status: TaskStatus;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

function DroppableColumn({ status, tasks, onTaskClick }: DroppableColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: status });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          <span className="text-xs text-muted-foreground">{tasks.length}</span>
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={`rounded-lg min-h-[300px] transition-colors duration-150 ${
          isOver ? 'bg-primary/5 ring-1 ring-inset ring-primary/20' : ''
        }`}
      >
        <ScrollArea className="h-[calc(100vh-340px)] md:h-[calc(100vh-280px)] min-h-[200px]">
          <div className="flex flex-col gap-2 px-0.5 pt-0.5 pb-1">
            {tasks.length === 0 ? (
              <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                {isOver ? 'Drop here' : 'No tasks'}
              </p>
            ) : (
              tasks.map((task) => (
                <TaskCard key={task.id} task={task} onClick={onTaskClick} />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

interface KanbanBoardProps {
  tasks: Task[];
  completedTodayTasks: Task[];
  onTaskClick: (task: Task) => void;
  onStatusChange?: (taskId: string, status: TaskStatus) => void;
}

export function KanbanBoard({
  tasks,
  completedTodayTasks,
  onTaskClick,
  onStatusChange,
}: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const columns = [
    { status: 'pending' as TaskStatus, tasks: tasks.filter((t) => t.status === 'pending') },
    { status: 'in_progress' as TaskStatus, tasks: tasks.filter((t) => t.status === 'in_progress') },
    { status: 'blocked' as TaskStatus, tasks: tasks.filter((t) => t.status === 'blocked') },
    { status: 'completed' as TaskStatus, tasks: completedTodayTasks },
  ];

  function handleDragStart({ active }: DragStartEvent) {
    setActiveTask((active.data.current?.task as Task) ?? null);
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveTask(null);
    if (!over || !onStatusChange) return;
    const newStatus = over.id as TaskStatus;
    const task = active.data.current?.task as Task | undefined;
    if (task && task.status !== newStatus) {
      onStatusChange(String(active.id), newStatus);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTask(null)}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {columns.map((col) => (
          <DroppableColumn
            key={col.status}
            status={col.status}
            tasks={col.tasks}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask ? <TaskCard task={activeTask} isDragOverlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
