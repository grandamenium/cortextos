import Link from 'next/link';
import {
  IconUser,
  IconShield,
  IconAlertTriangle,
  IconCircleCheck,
  IconChevronRight,
  IconClock,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Task } from '@/lib/types';
import type { Approval } from '@/lib/types';

interface ActionItemsPanelProps {
  humanTasks: Task[];
  pendingApprovals: Approval[];
  blockedTasks: Task[];
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function cleanTitle(title: string): string {
  return title.replace(/^\[(HUMAN|BLOCKED|URGENT|HIGH)\]\s*/i, '').trim();
}

export function ActionItemsPanel({
  humanTasks,
  pendingApprovals,
  blockedTasks,
}: ActionItemsPanelProps) {
  const total = humanTasks.length + pendingApprovals.length + blockedTasks.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium uppercase tracking-wider text-muted-foreground">
          <span>Action Items</span>
          {total > 0 && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
              {total}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {total === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground px-6 py-4 text-sm">
            <IconCircleCheck size={16} className="text-green-500" />
            <span>All clear — nothing needs your attention</span>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {/* Human tasks */}
            {humanTasks.map(task => (
              <Link
                key={task.id}
                href={`/tasks?agent=human`}
                className="flex items-start justify-between gap-3 px-6 py-3 hover:bg-muted/40 transition-colors group"
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <IconUser size={15} className="text-primary mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug truncate">
                      {cleanTitle(task.title)}
                    </p>
                    {task.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {task.description.slice(0, 100)}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1">
                      <IconClock size={11} className="text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{timeAgo(task.created_at)}</span>
                      {task.assignee && task.assignee !== 'human' && (
                        <span className="text-xs text-muted-foreground">· from {task.assignee}</span>
                      )}
                    </div>
                  </div>
                </div>
                <IconChevronRight
                  size={14}
                  className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0"
                />
              </Link>
            ))}

            {/* Pending approvals */}
            {pendingApprovals.map(approval => (
              <Link
                key={approval.id}
                href="/approvals"
                className="flex items-start justify-between gap-3 px-6 py-3 hover:bg-muted/40 transition-colors group"
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <IconShield size={15} className="text-primary mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug truncate">
                      {approval.title}
                    </p>
                    {approval.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {approval.description.slice(0, 100)}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1">
                      <IconClock size={11} className="text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{timeAgo(approval.created_at)}</span>
                      <span className="text-xs text-muted-foreground">· {approval.agent}</span>
                      {approval.category && (
                        <span className="text-xs text-muted-foreground">· {approval.category}</span>
                      )}
                    </div>
                  </div>
                </div>
                <IconChevronRight
                  size={14}
                  className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0"
                />
              </Link>
            ))}

            {/* Blocked tasks */}
            {blockedTasks.map(task => (
              <Link
                key={task.id}
                href="/tasks?status=blocked"
                className="flex items-start justify-between gap-3 px-6 py-3 hover:bg-muted/40 transition-colors group"
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <IconAlertTriangle size={15} className="text-yellow-500 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug truncate">
                      {cleanTitle(task.title)}
                    </p>
                    {task.notes && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {task.notes.slice(0, 100)}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-xs text-muted-foreground">
                        {task.assignee ?? 'unassigned'} · {timeAgo(task.created_at)}
                      </span>
                    </div>
                  </div>
                </div>
                <IconChevronRight
                  size={14}
                  className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0"
                />
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
