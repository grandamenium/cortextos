import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { getCTXRoot, getAgentDir, getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/ops
 *
 * Bulk operational data for all agents. Single request for the agents grid
 * so it doesn't need N individual requests.
 */

interface AgentOpsSnapshot {
  crashesToday: number;
  maxCrashesPerDay: number;
  halted: boolean;
  rateLimited: boolean;
  rateLimitResetsAt: string | null;
  rateLimitResetsAtMs: number | null;
  weeklyUsagePct: number | null;
  restartsTodayTotal: number;
  lastRestart: string | null;
  model: string | null;
}

const RATE_LIMIT_SCAN_BYTES = 16384;
const RATE_LIMIT_PATTERNS = [
  "You've hit your limit",
  'hit your limit',
  '/rate-limit-options',
];
const RESET_TIME_REGEX = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;
const WEEKLY_USAGE_REGEX = /(\d+)%\s*of your weekly limit/i;

function readLogTail(logPath: string): string | null {
  try {
    if (!existsSync(logPath)) return null;
    const stats = statSync(logPath);
    if (stats.size === 0) return null;
    const readSize = Math.min(stats.size, RATE_LIMIT_SCAN_BYTES);
    const fd = openSync(logPath, 'r');
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, stats.size - readSize);
    closeSync(fd);
    return buffer.toString('utf-8').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  } catch {
    return null;
  }
}

function getAgentOps(ctxRoot: string, name: string, org: string): AgentOpsSnapshot {
  const today = new Date().toISOString().split('T')[0];

  // Crash count
  let crashesToday = 0;
  try {
    const crashFile = join(ctxRoot, 'logs', name, '.crash_count_today');
    if (existsSync(crashFile)) {
      const content = readFileSync(crashFile, 'utf-8').trim();
      const [storedDate, countStr] = content.split(':');
      if (storedDate === today) {
        const c = parseInt(countStr, 10);
        if (!isNaN(c)) crashesToday = c;
      }
    }
  } catch { /* ignore */ }

  // Config
  let maxCrashesPerDay = 10;
  let model: string | null = null;
  try {
    const agentDir = getAgentDir(name, org || undefined);
    const configPath = join(agentDir, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.max_crashes_per_day !== undefined) maxCrashesPerDay = config.max_crashes_per_day;
      model = config.model ?? null;
    }
  } catch { /* ignore */ }

  // Rate limit from stdout tail
  const logPath = join(ctxRoot, 'logs', name, 'stdout.log');
  const logTail = readLogTail(logPath);
  let rateLimited = false;
  let rateLimitResetsAt: string | null = null;
  let rateLimitResetsAtMs: number | null = null;
  let weeklyUsagePct: number | null = null;

  if (logTail) {
    rateLimited = RATE_LIMIT_PATTERNS.some(p => logTail.includes(p));
    const usageMatch = logTail.match(WEEKLY_USAGE_REGEX);
    weeklyUsagePct = usageMatch ? parseInt(usageMatch[1], 10) : null;

    if (rateLimited) {
      const match = logTail.match(RESET_TIME_REGEX);
      if (match) {
        const [, hourStr, minuteStr, ampm, timezone] = match;
        rateLimitResetsAt = `${hourStr}${minuteStr ? ':' + minuteStr : ''}${ampm} (${timezone})`;
        try {
          let hour = parseInt(hourStr, 10);
          const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
          if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
          if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
          const now = new Date();
          const dateStr = now.toLocaleDateString('en-CA', { timeZone: timezone });
          const isoStr = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
          const targetDate = new Date(isoStr);
          const utcStr = targetDate.toLocaleString('en-US', { timeZone: 'UTC' });
          const tzStr = targetDate.toLocaleString('en-US', { timeZone: timezone });
          const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
          rateLimitResetsAtMs = targetDate.getTime() + offsetMs;
          if (rateLimitResetsAtMs < Date.now()) rateLimitResetsAtMs += 24 * 60 * 60 * 1000;
        } catch { /* ignore */ }
      }
    }
  }

  // Restarts today (from crashes.log — most complete source)
  let restartsTodayTotal = 0;
  let lastRestart: string | null = null;
  try {
    const crashesFile = join(ctxRoot, 'logs', name, 'crashes.log');
    if (existsSync(crashesFile)) {
      const content = readFileSync(crashesFile, 'utf-8');
      const todayLines = content.split('\n').filter(l => l.startsWith(today));
      restartsTodayTotal = todayLines.length;
      if (todayLines.length > 0) {
        const last = todayLines[todayLines.length - 1];
        const tsMatch = last.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
        if (tsMatch) lastRestart = tsMatch[1];
      }
    }
  } catch { /* ignore */ }

  return {
    crashesToday,
    maxCrashesPerDay,
    halted: crashesToday >= maxCrashesPerDay,
    rateLimited,
    rateLimitResetsAt,
    rateLimitResetsAtMs,
    weeklyUsagePct,
    restartsTodayTotal,
    lastRestart,
    model,
  };
}

export async function GET() {
  const ctxRoot = getCTXRoot();
  const agents = getAllAgents();

  const result: Record<string, AgentOpsSnapshot> = {};
  for (const agent of agents) {
    result[agent.name] = getAgentOps(ctxRoot, agent.name, agent.org);
  }

  return Response.json(result);
}
