'use client';

import { formatDistanceToNow } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  IconCirclePlus,
  IconUser,
  IconArrowRight,
  IconCircleCheck,
  IconMessage,
  IconLock,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { TaskAuditEntry, TaskAuditEvent } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return 'Unbekannt';
    return formatDistanceToNow(d, { addSuffix: true, locale: de });
  } catch {
    return 'Unbekannt';
  }
}

function getInitials(agent: string): string {
  return agent.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Event config: icon, label, and visual treatment per event type
// ---------------------------------------------------------------------------

interface EventConfig {
  Icon: React.ElementType;
  iconClass: string;
  dotClass: string;
  label: (entry: TaskAuditEntry) => string;
  isComment: boolean;
}

const EVENT_CONFIG: Record<TaskAuditEvent, EventConfig> = {
  create: {
    Icon: IconCirclePlus,
    iconClass: 'text-muted-foreground',
    dotClass: 'bg-border',
    label: (e) => `Task erstellt${e.note ? ` — "${e.note}"` : ''}`,
    isComment: false,
  },
  claim: {
    Icon: IconUser,
    iconClass: 'text-blue-500',
    dotClass: 'bg-blue-500',
    label: (e) => `Beansprucht${e.from && e.to ? ` (${e.from} → ${e.to})` : ''}`,
    isComment: false,
  },
  update: {
    Icon: IconArrowRight,
    iconClass: 'text-amber-500',
    dotClass: 'bg-amber-500',
    label: (e) =>
      e.from && e.to
        ? `Status geändert: ${e.from} → ${e.to}`
        : 'Status aktualisiert',
    isComment: false,
  },
  complete: {
    Icon: IconCircleCheck,
    iconClass: 'text-green-500',
    dotClass: 'bg-green-500',
    label: () => 'Abgeschlossen',
    isComment: false,
  },
  comment: {
    Icon: IconMessage,
    iconClass: 'text-foreground',
    dotClass: 'bg-primary',
    label: () => '',
    isComment: true,
  },
};

// ---------------------------------------------------------------------------
// Single feed item
// ---------------------------------------------------------------------------

function FeedItem({ entry }: { entry: TaskAuditEntry }) {
  const config = EVENT_CONFIG[entry.event] ?? EVENT_CONFIG.update;
  const { Icon, iconClass, dotClass, isComment } = config;

  return (
    <div className="flex gap-3">
      {/* Timeline dot + connector */}
      <div className="flex flex-col items-center">
        <div className={cn('mt-1 h-2 w-2 rounded-full shrink-0', dotClass)} />
        {/* Vertical line rendered by the parent ul gap */}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        {isComment ? (
          /* Comment: avatar + bubble */
          <div className="flex items-start gap-2">
            <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[9px] font-semibold text-muted-foreground leading-none">
                {getInitials(entry.agent)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-xs font-medium text-foreground">{entry.agent}</span>
                <span className="text-xs text-muted-foreground">{formatRelative(entry.ts)}</span>
              </div>
              <div className="rounded-md bg-muted/50 border border-border/50 px-3 py-2">
                <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                  {entry.note}
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* Status transition: compact row */
          <div className="flex items-start gap-2">
            <Icon size={14} className={cn('mt-0.5 shrink-0', iconClass)} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{entry.agent}</span>
                {' — '}
                {config.label(entry)}
              </p>
              <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                {formatRelative(entry.ts)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyHistory() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <IconLock size={24} className="text-muted-foreground/40 mb-2" />
      <p className="text-sm text-muted-foreground">Noch keine Aktivitaten</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        Kommentare und Statuswechsel erscheinen hier.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface TaskHistoryFeedProps {
  entries: TaskAuditEntry[];
  loading?: boolean;
}

export function TaskHistoryFeed({ entries, loading }: TaskHistoryFeedProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 animate-pulse">
            <div className="mt-1 h-2 w-2 rounded-full bg-muted shrink-0" />
            <div className="flex-1 space-y-1.5 pb-4">
              <div className="h-3 w-32 rounded bg-muted" />
              <div className="h-3 w-48 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return <EmptyHistory />;
  }

  return (
    <div className="relative">
      {/* Continuous vertical connector line behind all items */}
      <div
        className="absolute left-[3px] top-3 bottom-3 w-px bg-border/60"
        aria-hidden
      />
      <div className="space-y-0">
        {entries.map((entry, idx) => (
          <FeedItem key={`${entry.ts}-${idx}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}
