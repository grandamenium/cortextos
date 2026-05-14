'use client';

import { Card } from '@/components/ui/card';
import { PriorityBadge, OrgBadge, TimeAgo } from '@/components/shared';
import { IconMessage } from '@tabler/icons-react';
import type { Task } from '@/lib/types';

interface TaskCardProps {
  task: Task;
  onClick?: (task: Task) => void;
  commentCount?: number;
  lastComment?: string;
}

export function TaskCard({ task, onClick, commentCount, lastComment }: TaskCardProps) {
  return (
    <Card
      className="cursor-pointer p-3 transition-colors hover:bg-muted/50"
      onClick={() => onClick?.(task)}
    >
      <div className="space-y-2">
        <p className="text-sm font-medium leading-snug line-clamp-2">
          {task.title}
        </p>

        {/* Last comment preview (1 line, truncated) */}
        {lastComment && (
          <p className="text-xs text-muted-foreground line-clamp-1 italic">
            {lastComment}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={task.priority} />
          <OrgBadge org={task.org} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            {task.assignee ? (
              <span className="truncate max-w-[100px]">{task.assignee}</span>
            ) : (
              <span className="italic">Unassigned</span>
            )}
            {/* Comment count badge — only rendered when there are comments */}
            {commentCount != null && commentCount > 0 && (
              <span
                className="flex items-center gap-0.5 text-muted-foreground shrink-0"
                aria-label={`${commentCount} Kommentar${commentCount !== 1 ? 'e' : ''}`}
              >
                <IconMessage size={11} />
                <span className="text-[11px]">{commentCount}</span>
              </span>
            )}
          </div>
          <TimeAgo date={task.created_at} className="text-xs" />
        </div>
      </div>
    </Card>
  );
}
