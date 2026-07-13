import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '@/lib/config';

type StatusFilter = 'all' | 'success' | 'failure';

export interface CronExecutionLogEntry {
  ts: string;
  cron: string;
  status: 'fired' | 'retried' | 'failed';
  attempt: number;
  duration_ms: number;
  error: string | null;
}

export interface ExecutionLogPage {
  entries: CronExecutionLogEntry[];
  total: number;
  hasMore: boolean;
}

const CRONS_DIR = '.cortextOS/state/agents';

export function readExecutionLogPage(
  agentName: string,
  cronName: string | undefined,
  limit: number,
  offset: number,
  statusFilter: StatusFilter,
): ExecutionLogPage {
  const logPath = path.join(CTX_ROOT, CRONS_DIR, agentName, 'cron-execution.log');
  if (!fs.existsSync(logPath)) return { entries: [], total: 0, hasMore: false };

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return { entries: [], total: 0, hasMore: false };
  }

  const allEntries: CronExecutionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      allEntries.push(JSON.parse(trimmed) as CronExecutionLogEntry);
    } catch {
      // skip malformed line
    }
  }

  let filtered = cronName
    ? allEntries.filter((entry) => entry.cron === cronName)
    : allEntries;

  if (statusFilter === 'success') {
    filtered = filtered.filter((entry) => entry.status === 'fired');
  } else if (statusFilter === 'failure') {
    filtered = filtered.filter((entry) => entry.status === 'failed');
  }

  const total = filtered.length;

  if (limit <= 0) {
    const safeOffset = Math.min(offset, total);
    return { entries: filtered.slice(0, total - safeOffset), total, hasMore: false };
  }

  const safeOffset = Math.max(0, Math.min(offset, total));
  const end = total - safeOffset;
  const start = Math.max(0, end - limit);
  const entries = filtered.slice(start, end);
  const hasMore = start > 0;

  return { entries, total, hasMore };
}

export function entriesToCsv(entries: CronExecutionLogEntry[]): string {
  const header = 'timestamp,cron,status,attempt,duration_ms,error';
  const rows = entries.map((entry) => {
    const ts = entry.ts;
    const cron = csvEscape(entry.cron);
    const status = entry.status;
    const attempt = entry.attempt;
    const duration = entry.duration_ms;
    const error = csvEscape(entry.error ?? '');
    return `${ts},${cron},${status},${attempt},${duration},${error}`;
  });
  return [header, ...rows].join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
