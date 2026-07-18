'use client';

import { useEffect, useState, useCallback } from 'react';
import { IconCalendar, IconVideo, IconMapPin, IconUsers, IconRefresh } from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CalendarEvent } from '@/app/api/meetings/upcoming/route';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function minuteLabel(mins: number | null): string {
  if (mins === null) return '';
  if (mins < 0) return 'now';
  if (mins === 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}

function urgencyClass(mins: number | null): string {
  if (mins === null) return '';
  if (mins <= 15) return 'text-destructive font-semibold';
  if (mins <= 60) return 'text-amber-500 font-medium';
  return 'text-muted-foreground';
}

export function NextUpMeetings() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/meetings/upcoming', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEvents(data.events ?? []);
      setLastFetch(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    const timer = setInterval(fetchEvents, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchEvents]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <IconCalendar size={14} />
            Next Up
          </span>
          <button
            onClick={fetchEvents}
            title="Refresh"
            className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <IconRefresh size={13} />
          </button>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && (
          <p className="text-sm text-muted-foreground animate-pulse">Loading calendar…</p>
        )}

        {!loading && error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {!loading && !error && events.length === 0 && (
          <p className="text-sm text-muted-foreground">No upcoming meetings in the next 7 days.</p>
        )}

        {!loading && !error && events.map((ev) => (
          <div key={ev.id} className="rounded-md border border-border/50 bg-muted/30 p-3 space-y-1.5">
            {/* Title + time badge */}
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium leading-snug line-clamp-2">{ev.title}</p>
              {ev.minutesUntil !== null && (
                <span className={`text-xs shrink-0 tabular-nums ${urgencyClass(ev.minutesUntil)}`}>
                  {minuteLabel(ev.minutesUntil)}
                </span>
              )}
            </div>

            {/* When */}
            <p className="text-xs text-muted-foreground">
              {ev.startMT}{ev.endMT ? ` – ${ev.endMT}` : ''} MT
            </p>

            {/* Attendees */}
            {ev.attendees.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <IconUsers size={11} />
                <span className="truncate">{ev.attendees.join(', ')}</span>
              </div>
            )}

            {/* Location */}
            {ev.location && !ev.videoLink && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <IconMapPin size={11} />
                <span className="truncate">{ev.location}</span>
              </div>
            )}

            {/* Video join link */}
            {ev.videoLink && (
              <a
                href={ev.videoLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-sm bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
              >
                <IconVideo size={12} />
                Join meeting
              </a>
            )}
          </div>
        ))}

        {lastFetch && (
          <p className="text-[10px] text-muted-foreground/50 text-right">
            Updated {lastFetch.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
