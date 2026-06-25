'use client';

import { useMemo, useRef, useState } from 'react';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { IconCalendar, IconAlertCircle } from '@tabler/icons-react';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-zinc-400',
  in_progress: 'bg-blue-500',
  blocked: 'bg-red-500',
  completed: 'bg-emerald-500',
};

const PRIORITY_BORDER: Record<string, string> = {
  urgent: 'border-red-500',
  high: 'border-orange-400',
  normal: 'border-transparent',
  low: 'border-transparent',
};

const COL_WIDTH = 36; // px per day
const ROW_HEIGHT = 44;

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function formatMonthDay(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface GanttRow {
  task: Task;
  startDate: Date;
  endDate: Date;
  hasStart: boolean;
  hasDue: boolean;
}

interface GanttChartProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export function GanttChart({ tasks, onTaskClick }: GanttChartProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const today = startOfDay(new Date());

  // Build rows — tasks with at least one date, fallback to created_at for start
  const rows: GanttRow[] = useMemo(() => {
    return tasks
      .filter((t) => t.start_date || t.due_date || t.created_at)
      .map((task) => {
        const s = parseDate(task.start_date) ?? parseDate(task.created_at) ?? today;
        const e = parseDate(task.due_date) ?? addDays(s, 1);
        return {
          task,
          startDate: startOfDay(s),
          endDate: startOfDay(e),
          hasStart: !!task.start_date,
          hasDue: !!task.due_date,
        };
      })
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }, [tasks, today]);

  const noDateTasks = useMemo(() => tasks.filter((t) => !t.start_date && !t.due_date && !t.created_at), [tasks]);

  const { rangeStart, totalDays } = useMemo(() => {
    if (rows.length === 0) return { rangeStart: addDays(today, -7), totalDays: 60 };
    const earliest = rows.reduce((m, r) => (r.startDate < m ? r.startDate : m), rows[0].startDate);
    const latest = rows.reduce((m, r) => (r.endDate > m ? r.endDate : m), rows[0].endDate);
    const rs = addDays(earliest, -3);
    const total = Math.max(diffDays(rs, latest) + 7, 60);
    return { rangeStart: rs, totalDays: total };
  }, [rows, today]);

  const todayOffset = diffDays(rangeStart, today);

  // Build day/month header
  const months: { label: string; span: number }[] = useMemo(() => {
    const result: { label: string; span: number }[] = [];
    let cur = new Date(rangeStart);
    let span = 0;
    let curMonth = cur.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    for (let i = 0; i < totalDays; i++) {
      const m = cur.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      if (m !== curMonth && span > 0) {
        result.push({ label: curMonth, span });
        curMonth = m;
        span = 0;
      }
      span++;
      cur = addDays(cur, 1);
    }
    if (span > 0) result.push({ label: curMonth, span });
    return result;
  }, [rangeStart, totalDays]);

  const totalWidth = totalDays * COL_WIDTH;
  const labelWidth = 220;

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
        <IconCalendar size={40} className="mb-3 opacity-30" />
        <p className="text-sm">No tasks to display on the timeline.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* Scrollable timeline */}
      <div className="flex overflow-hidden">
        {/* Fixed label column */}
        <div className="shrink-0 border-r bg-muted/20" style={{ width: labelWidth }}>
          {/* Month header spacer */}
          <div className="h-7 border-b bg-muted/30" />
          {/* Day header spacer */}
          <div className="h-7 border-b" />
          {/* Task labels */}
          {rows.map(({ task }) => (
            <div
              key={task.id}
              className="flex items-center gap-2 px-3 border-b cursor-pointer hover:bg-muted/30 transition-colors"
              style={{ height: ROW_HEIGHT }}
              onClick={() => onTaskClick(task)}
            >
              <span
                className={cn('size-2.5 shrink-0 rounded-full', STATUS_COLORS[task.status])}
              />
              <span className="text-xs truncate" title={task.title}>
                {task.title}
              </span>
            </div>
          ))}
        </div>

        {/* Scrollable grid */}
        <div ref={scrollRef} className="overflow-x-auto flex-1">
          <div style={{ width: totalWidth, minWidth: '100%' }}>
            {/* Month header */}
            <div className="flex h-7 border-b bg-muted/30 text-xs text-muted-foreground">
              {months.map((m, i) => (
                <div
                  key={i}
                  className="border-r px-1.5 flex items-center font-medium truncate shrink-0"
                  style={{ width: m.span * COL_WIDTH }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* Day header */}
            <div className="flex h-7 border-b text-xs text-muted-foreground relative">
              {Array.from({ length: totalDays }, (_, i) => {
                const d = addDays(rangeStart, i);
                const isToday = i === todayOffset;
                const isMon = d.getDay() === 1;
                return (
                  <div
                    key={i}
                    className={cn(
                      'shrink-0 flex items-center justify-center border-r',
                      isToday && 'bg-blue-500/10 text-blue-600 font-semibold',
                      isMon && !isToday && 'font-medium',
                    )}
                    style={{ width: COL_WIDTH }}
                  >
                    {(isMon || isToday || i === 0) ? d.getDate() : ''}
                  </div>
                );
              })}
            </div>

            {/* Rows */}
            {rows.map(({ task, startDate, endDate, hasStart, hasDue }) => {
              const left = diffDays(rangeStart, startDate) * COL_WIDTH;
              const width = Math.max(diffDays(startDate, endDate), 1) * COL_WIDTH;
              const isHovered = hoveredId === task.id;
              const isPastDue = hasDue && endDate < today && task.status !== 'completed';

              return (
                <div
                  key={task.id}
                  className="relative border-b flex items-center"
                  style={{ height: ROW_HEIGHT }}
                >
                  {/* Weekend shading */}
                  {Array.from({ length: totalDays }, (_, i) => {
                    const d = addDays(rangeStart, i);
                    const dow = d.getDay();
                    if (dow !== 0 && dow !== 6) return null;
                    return (
                      <div
                        key={i}
                        className="absolute inset-y-0 bg-muted/20"
                        style={{ left: i * COL_WIDTH, width: COL_WIDTH }}
                      />
                    );
                  })}

                  {/* Today line */}
                  {todayOffset >= 0 && todayOffset < totalDays && (
                    <div
                      className="absolute inset-y-0 w-px bg-blue-500/50 z-10"
                      style={{ left: todayOffset * COL_WIDTH + COL_WIDTH / 2 }}
                    />
                  )}

                  {/* Task bar */}
                  <div
                    className={cn(
                      'absolute rounded-md h-6 flex items-center px-2 cursor-pointer z-20',
                      'border-l-2 text-white text-xs font-medium truncate select-none',
                      STATUS_COLORS[task.status],
                      PRIORITY_BORDER[task.priority],
                      isHovered && 'opacity-90 ring-2 ring-white/40',
                      isPastDue && 'ring-2 ring-red-400',
                    )}
                    style={{ left, width: Math.max(width, COL_WIDTH) }}
                    onClick={() => onTaskClick(task)}
                    onMouseEnter={() => setHoveredId(task.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    title={`${task.title}\n${formatMonthDay(startDate)} → ${formatMonthDay(endDate)}`}
                  >
                    {isPastDue && <IconAlertCircle size={11} className="shrink-0 mr-1" />}
                    <span className="truncate">{task.title}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-2.5 border-t text-xs text-muted-foreground bg-muted/10">
        {Object.entries(STATUS_COLORS).map(([s, c]) => (
          <div key={s} className="flex items-center gap-1.5">
            <span className={cn('size-2.5 rounded-full', c)} />
            <span className="capitalize">{s.replace('_', ' ')}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="w-px h-3 bg-blue-500" />
          <span>Today</span>
        </div>
        {noDateTasks.length > 0 && (
          <span className="text-muted-foreground/60">{noDateTasks.length} task(s) without dates not shown</span>
        )}
      </div>
    </div>
  );
}
