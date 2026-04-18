import { NextRequest } from 'next/server';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { getCTXRoot, getAgentDir, getAllAgents } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/[name]/ops
 *
 * Returns operational data for an agent:
 * - crashesToday / maxCrashesPerDay
 * - rateLimited flag + reset time
 * - usage (session %, weekly %)
 * - uptime / last restart
 * - status (running / halted / crashed / rate-limited)
 */

interface OpsData {
  crashesToday: number;
  maxCrashesPerDay: number;
  halted: boolean;
  rateLimited: boolean;
  rateLimitResetsAt: string | null; // human-readable, e.g. "9pm (Europe/Berlin)"
  rateLimitResetsAtMs: number | null; // epoch ms for countdown
  usage: {
    session: { used_pct: number; resets: string } | null;
    weekAllModels: { used_pct: number; resets: string } | null;
    weekSonnet: { used_pct: number } | null;
    timestamp: string | null;
  };
  uptime: {
    lastRestart: string | null; // ISO timestamp
    restartsTodayTotal: number;
    restartsType: { crash: number; watchdog: number; self: number; hard: number };
  };
  model: string | null;
}

// Rate-limit detection (mirrors stale-watchdog.ts)
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

function getCrashCount(ctxRoot: string, agentName: string): { count: number; date: string } {
  const crashFile = join(ctxRoot, 'logs', agentName, '.crash_count_today');
  const today = new Date().toISOString().split('T')[0];
  try {
    if (!existsSync(crashFile)) return { count: 0, date: today };
    const content = readFileSync(crashFile, 'utf-8').trim();
    const [storedDate, countStr] = content.split(':');
    if (storedDate !== today) return { count: 0, date: today };
    const count = parseInt(countStr, 10);
    return { count: isNaN(count) ? 0 : count, date: today };
  } catch {
    return { count: 0, date: today };
  }
}

function getRestartsToday(ctxRoot: string, agentName: string): {
  total: number;
  crash: number;
  watchdog: number;
  self: number;
  hard: number;
  lastRestart: string | null;
} {
  const logFile = join(ctxRoot, 'logs', agentName, 'restarts.log');
  const today = new Date().toISOString().split('T')[0];
  const result = { total: 0, crash: 0, watchdog: 0, self: 0, hard: 0, lastRestart: null as string | null };

  try {
    if (!existsSync(logFile)) return result;
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // Format: [2026-04-18T14:25:30Z] CRASH: ...
      const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\]\s+(\w[\w-]*?):/);
      if (!match) continue;
      const [, timestamp, kind] = match;
      if (!timestamp.startsWith(today)) continue;

      result.total++;
      result.lastRestart = timestamp;

      switch (kind.toUpperCase()) {
        case 'CRASH': result.crash++; break;
        case 'WATCHDOG': result.watchdog++; break;
        case 'SELF-RESTART': result.self++; break;
        case 'HARD-RESTART': result.hard++; break;
        case 'HALTED': result.crash++; break;
      }
    }

    // Also check crashes.log for today's entries (written by hook, more complete)
    const crashesFile = join(ctxRoot, 'logs', agentName, 'crashes.log');
    if (existsSync(crashesFile)) {
      const crashContent = readFileSync(crashesFile, 'utf-8');
      const crashLines = crashContent.split('\n').filter(l => l.startsWith(today));
      // Use crash count from crashes.log if restarts.log has fewer
      // (restarts.log was empty before this fix)
      if (crashLines.length > result.total) {
        result.total = crashLines.length;
      }

      // Find last crash time
      if (crashLines.length > 0) {
        const lastLine = crashLines[crashLines.length - 1];
        const tsMatch = lastLine.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/);
        if (tsMatch && (!result.lastRestart || tsMatch[1] > result.lastRestart)) {
          result.lastRestart = tsMatch[1];
        }
      }
    }
  } catch {
    // ignore
  }

  return result;
}

function getUsageData(ctxRoot: string, agentName: string): OpsData['usage'] {
  const empty = { session: null, weekAllModels: null, weekSonnet: null, timestamp: null };

  // Check per-agent usage data
  const usageDir = join(ctxRoot, 'state', 'usage');
  const latestPath = join(usageDir, 'latest.json');
  try {
    if (!existsSync(latestPath)) return empty;
    const data = JSON.parse(readFileSync(latestPath, 'utf-8'));
    // Usage data may be for a different agent — check
    if (data.agent && data.agent !== agentName) return empty;
    return {
      session: data.session ?? null,
      weekAllModels: data.week_all_models ?? null,
      weekSonnet: data.week_sonnet ?? null,
      timestamp: data.timestamp ?? null,
    };
  } catch {
    return empty;
  }
}

function getRateLimitInfo(logTail: string | null): {
  rateLimited: boolean;
  resetsAt: string | null;
  resetsAtMs: number | null;
  weeklyUsagePct: number | null;
} {
  if (!logTail) return { rateLimited: false, resetsAt: null, resetsAtMs: null, weeklyUsagePct: null };

  const isLimited = RATE_LIMIT_PATTERNS.some(p => logTail.includes(p));

  // Parse weekly usage percentage even if not rate-limited
  const usageMatch = logTail.match(WEEKLY_USAGE_REGEX);
  const weeklyUsagePct = usageMatch ? parseInt(usageMatch[1], 10) : null;

  if (!isLimited) return { rateLimited: false, resetsAt: null, resetsAtMs: null, weeklyUsagePct };

  // Parse reset time
  const match = logTail.match(RESET_TIME_REGEX);
  if (!match) return { rateLimited: true, resetsAt: null, resetsAtMs: null, weeklyUsagePct };

  const [, hourStr, minuteStr, ampm, timezone] = match;
  const resetsAt = `${hourStr}${minuteStr ? ':' + minuteStr : ''}${ampm} (${timezone})`;

  // Build epoch ms
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;

  let resetsAtMs: number | null = null;
  try {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: timezone });
    const isoStr = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const targetDate = new Date(isoStr);
    const utcStr = targetDate.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = targetDate.toLocaleString('en-US', { timeZone: timezone });
    const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
    resetsAtMs = targetDate.getTime() + offsetMs;
    // If reset time is in the past, it might be tomorrow
    if (resetsAtMs < Date.now()) {
      resetsAtMs += 24 * 60 * 60 * 1000;
    }
  } catch {
    // ignore timezone parsing failures
  }

  return { rateLimited: true, resetsAt, resetsAtMs, weeklyUsagePct };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const ctxRoot = getCTXRoot();
  const allAgents = getAllAgents();
  const agent = allAgents.find(a => a.name === name);
  if (!agent) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  // Read agent config for max_crashes_per_day and model
  let maxCrashesPerDay = 10;
  let model: string | null = null;
  try {
    const agentDir = getAgentDir(name, agent.org || undefined);
    const configPath = join(agentDir, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.max_crashes_per_day !== undefined) {
        maxCrashesPerDay = config.max_crashes_per_day;
      }
      model = config.model ?? null;
    }
  } catch { /* ignore */ }

  // Crash counter
  const { count: crashesToday } = getCrashCount(ctxRoot, name);

  // Rate limit info from stdout.log tail
  const logPath = join(ctxRoot, 'logs', name, 'stdout.log');
  const logTail = readLogTail(logPath);
  const rateLimitInfo = getRateLimitInfo(logTail);

  // Usage data
  const usage = getUsageData(ctxRoot, name);

  // If we parsed weekly usage from log but don't have stored usage data, use it
  if (rateLimitInfo.weeklyUsagePct !== null && !usage.weekAllModels) {
    usage.weekAllModels = { used_pct: rateLimitInfo.weeklyUsagePct, resets: rateLimitInfo.resetsAt ?? '' };
  }

  // Restart history
  const restarts = getRestartsToday(ctxRoot, name);

  const halted = crashesToday >= maxCrashesPerDay;

  const ops: OpsData = {
    crashesToday,
    maxCrashesPerDay,
    halted,
    rateLimited: rateLimitInfo.rateLimited,
    rateLimitResetsAt: rateLimitInfo.resetsAt,
    rateLimitResetsAtMs: rateLimitInfo.resetsAtMs,
    usage,
    uptime: {
      lastRestart: restarts.lastRestart,
      restartsTodayTotal: restarts.total,
      restartsType: {
        crash: restarts.crash,
        watchdog: restarts.watchdog,
        self: restarts.self,
        hard: restarts.hard,
      },
    },
    model,
  };

  return Response.json(ops);
}
