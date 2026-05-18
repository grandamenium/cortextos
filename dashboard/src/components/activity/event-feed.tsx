'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  IconMessage,
  IconCheckbox,
  IconShield,
  IconAlertTriangle,
  IconFlag,
  IconActivity,
} from '@tabler/icons-react';
import { formatDistanceToNow } from 'date-fns';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { useSSE } from '@/hooks/use-sse';
import type { Event, SSEEvent, EventType } from '@/lib/types';

// -- Icon mapping --

const eventTypeIcons: Record<string, React.ReactNode> = {
  message: <IconMessage size={16} />,
  task: <IconCheckbox size={16} />,
  approval: <IconShield size={16} />,
  error: <IconAlertTriangle size={16} className="text-destructive" />,
  milestone: <IconFlag size={16} className="text-primary" />,
  heartbeat: <IconActivity size={16} className="text-muted-foreground" />,
  action: <IconActivity size={16} />,
};

const severityBg: Record<string, string> = {
  info: '',
  warning: 'bg-warning/5',
  error: 'bg-destructive/5',
};

function formatEventTime(timestamp: string): string {
  try {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  } catch {
    return 'unknown';
  }
}

// -- Types --

export interface EventFeedFilters {
  types: EventType[];
  agent: string;
  org: string;
  from?: string;
  to?: string;
}

interface EventFeedProps {
  initialEvents: Event[];
  filters: EventFeedFilters;
}

// -- Component --

export function EventFeed({ initialEvents, filters }: EventFeedProps) {
  const [allEvents, setAllEvents] = useState<Event[]>(initialEvents);

  // SSE for live updates
  const { events: sseEvents, isConnected } = useSSE({
    bufferSize: 100,
    filter: useCallback(
      (sse: SSEEvent) => {
        // Apply type filter if any types are selected
        if (filters.types.length > 0) {
          const sseType = sse.type as EventType;
          if (!filters.types.includes(sseType)) return false;
        }
        // Apply agent filter
        if (filters.agent && (sse.data?.agent as string) !== filters.agent) {
          return false;
        }
        return true;
      },
      [filters.types, filters.agent],
    ),
  });

  // Merge SSE events into the list
  useEffect(() => {
    if (sseEvents.length === 0) return;

    const newEvents: Event[] = sseEvents.map((sse, i) => ({
      id: `sse-${sse.timestamp}-${i}`,
      timestamp: sse.timestamp,
      agent: (sse.data?.agent as string) ?? '',
      org: (sse.data?.org as string) ?? '',
      type: (sse.type as EventType) ?? 'action',
      category: (sse.data?.category as string) ?? '',
      severity: ((sse.data?.severity as string) ?? 'info') as Event['severity'],
      data: sse.data,
      message: (sse.data?.message as string) ?? sse.type ?? 'Event',
    }));

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAllEvents((prev) => {
      const merged = [...newEvents, ...prev];
      const seen = new Set<string>();
      return merged
        .filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        })
        .slice(0, 200);
    });
  }, [sseEvents]);

  // Apply client-side filters to display
  const displayEvents = allEvents.filter((e) => {
    if (filters.types.length > 0 && !filters.types.includes(e.type)) return false;
    if (filters.agent && e.agent !== filters.agent) return false;
    if (filters.org && e.org !== filters.org) return false;
    if (filters.from && e.timestamp < filters.from) return false;
    if (filters.to && e.timestamp > filters.to) return false;
    return true;
  });

  return (
    <div className="space-y-1">
      {/* Connection indicator */}
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            isConnected ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'
          }`}
        />
        {isConnected ? 'Live' : 'Reconnecting...'}
        <span className="ml-auto">{displayEvents.length} events</span>
      </div>

      {/* Event list */}
      {displayEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No events match the current filters.
        </p>
      ) : (
        displayEvents.map((event) => (
          <div
            key={event.id}
            className={`rounded-lg px-3 py-3 transition-colors hover:bg-muted/50 sm:flex sm:items-start sm:gap-3 sm:py-2.5 ${
              severityBg[event.severity] ?? ''
            }`}
          >
            <div className="mb-2 flex items-center gap-2 sm:mb-0">
              {/* Timestamp */}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums sm:w-[7rem] sm:pt-0.5" suppressHydrationWarning>
                {formatEventTime(event.timestamp)}
              </span>

              {/* Agent avatar */}
              <AgentAvatar name={event.agent || '?'} size="sm" />

              {/* Event type icon */}
              <span className="shrink-0 text-muted-foreground sm:mt-0.5">
                {eventTypeIcons[event.type] ?? <IconActivity size={16} />}
              </span>

              {/* Type badge */}
              <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
                {event.type}
              </span>
            </div>

            {/* Message */}
            <div className="flex-1 min-w-0">
              <p className="text-sm leading-snug">
                {event.message ?? event.category ?? event.type}
              </p>
              {event.agent && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {event.agent}
                  {event.org ? ` - ${event.org}` : ''}
                </p>
              )}
            </div>

            {/* Type badge */}
            <span className="hidden shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:inline">
              {event.type}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
