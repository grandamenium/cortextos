'use client';

import type { CSSProperties } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { PriorityBadge, OrgBadge, TimeAgo } from '@/components/shared';
import type { Task } from '@/lib/types';

interface TaskCardProps {
  task: Task;
  onClick?: (task: Task) => void;
  draggable?: boolean;
  busy?: boolean;
}

export function TaskCard({ task, onClick, draggable = true, busy = false }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: task.id,
    disabled: !draggable || busy,
  });

  const style: CSSProperties | undefined = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
      }
    : undefined;

  return (
    <Card
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={style}
      className={cn(
        'cursor-pointer p-3 transition-colors hover:bg-muted/50',
        draggable && 'touch-manipulation',
        isDragging && 'z-10 opacity-70 shadow-lg',
        busy && 'pointer-events-none opacity-70',
      )}
      onClick={() => {
        if (!isDragging) {
          onClick?.(task);
        }
      }}
    >
      <div className="space-y-2">
        <p className="text-sm font-medium leading-snug line-clamp-2">
          {task.title}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={task.priority} />
          <OrgBadge org={task.org} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {task.assignee ? (
            <span className="truncate max-w-[120px]">{task.assignee}</span>
          ) : (
            <span className="italic">Unassigned</span>
          )}
          <TimeAgo date={task.created_at} className="text-xs" />
        </div>
      </div>
    </Card>
  );
}
