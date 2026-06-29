'use client';

import { useDraggable } from '@dnd-kit/core';
import { Card } from '@/components/ui/card';
import { PriorityBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconGripVertical } from '@tabler/icons-react';
import type { Task } from '@/lib/types';

interface TaskCardProps {
  task: Task;
  onClick?: (task: Task) => void;
  isDragOverlay?: boolean;
}

export function TaskCard({ task, onClick, isDragOverlay = false }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { task },
    disabled: isDragOverlay,
  });

  return (
    <Card
      ref={setNodeRef}
      className={`p-3 transition-colors hover:bg-muted/50 ${
        isDragging && !isDragOverlay ? 'opacity-40' : ''
      } ${isDragOverlay ? 'rotate-1 shadow-2xl cursor-grabbing' : ''}`}
    >
      <div className="flex items-start gap-1.5">
        {!isDragOverlay && (
          <div
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing mt-0.5 text-muted-foreground/30 hover:text-muted-foreground/60 touch-none shrink-0 select-none"
          >
            <IconGripVertical size={14} />
          </div>
        )}
        <div
          className="flex-1 min-w-0 space-y-2"
          onClick={() => !isDragging && onClick?.(task)}
          style={{ cursor: isDragOverlay ? 'grabbing' : 'pointer' }}
        >
          <p className="text-sm font-medium leading-snug line-clamp-2">
            {task.title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <PriorityBadge priority={task.priority} />
            <OrgBadge org={task.org} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="truncate max-w-[140px]">
              {task.assignee || <span className="italic">Unassigned</span>}
              {task.project && <span className="ml-1 opacity-60">· {task.project}</span>}
            </span>
            <TimeAgo date={task.created_at} className="text-xs" />
          </div>
        </div>
      </div>
    </Card>
  );
}
