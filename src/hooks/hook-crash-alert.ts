/**
 * SessionEnd hook - crash alert via Telegram.
 * Categorizes session end type and sends notification.
 *
 * Behavior:
 *   - Detects Anthropic weekly/5h rate-limit messages in stdout.log and
 *     classifies the exit as "rate-limited" so it is suppressed rather than
 *     spamming a 🚨 CRASH alert every 30 minutes while the daemon respawn
 *     loop continues hitting the wall.
 *   - Applies quiet hours (22:00-07:00 America/Los_Angeles) for routine end
 *     types (planned-restart, session-refresh, daemon-stop, user-*,
 *     rate-limited). A real unexpected crash still pages at night.
 *   - Deduplicates identical alerts for the same agent within 10 minutes so a
 *     broken watchdog loop results in at most one notification, not a buzz
 *     storm.
 *   - Reads SessionEnd reason from stdin (Claude Code hook payload). Non-crash
 *     reasons (clear, logout, prompt_input_submit, compact) are reclassified as
 *     session-event-{reason} and suppressed — no Telegram, no crash count.
 *   - Writes a .recent-planned-restart-at cookie when a planned end type is
 *     detected. A second SessionEnd that fires within 60s with no marker is
 *     reclassified as planned-restart-aftershock and suppressed.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

const DEDUP_WINDOW_MS = 10 * 60 * 1000;         // 10 minutes
const QUIET_HOUR_START_LA = 22;                 // 22:00 America/Los_Angeles
const QUIET_HOUR_END_LA = 7;                    // 07:00 America/Los_Angeles
const AFTERSHOCK_WINDOW_MS = 60_000;            // 60 seconds

// SessionEnd reasons from Claude Code that indicate a clean/intentional exit,
// not a crash. These are reclassified to session-event-{reason} and suppressed.
export const NON_CRASH_REASONS = new Set(['clear', 'logout', 'prompt_input_submit', 'compact']);

// End types that are routine and should be suppressed during quiet hours.
// "crash" is deliberately NOT in this list — a genuine unexpected crash at
// 3am is worth waking up for.
const QUIET_SUPPRESSED_TYPES = new Set([
  'planned-restart',
  'session-refresh',
  'daemon-stop',
  'user-restart',
  'user-disable',
  'user-stop',
  'rate-limited',
  'planned-restart-aftershock',
]);

function isQuietHoursLA(now: Date): boolean {
  const laString = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
  });
  const m = laString.match(/\d+\/\d+\/\d+,?\s+(\d+):/);
  if (!m) return false;
  const hour = parseInt(m[1], 10);
  // Window wraps midnight: 22:00-23:59 OR 00:00-06:59
  return hour >= QUIET_HOUR_START_LA || hour < QUIET_HOUR_END_LA;
}

/**
 * Scan the tail of stdout.log for Anthropic rate-limit or weekly-limit
 * signatures. Mirrors OutputBuffer.hasRateLimitSignature so the hook and the
 * daemon use the same detection logic.
 */
function detectRateLimitInLog(logPath: string): boolean {
  try {
    const size = statSync(logPath).size;
    const readBytes = Math.min(size, 200 * 1024); // last 200 KB
    const fd = readFileSync(logPath);
    const slice = fd.slice(Math.max(0, fd.length - readBytes)).toString('utf-8');
    const text = slice.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      text.includes('weekly limit') ||
      text.includes('5-hour limit') ||
      text.includes('5h limit') ||
      /used \d+% of your/.test(text)
    );
  } catch {
    return false;
  }
}

/**
 * Read max_crashes_per_day from the agent's config.json. Returns null if the
 * file is missing, malformed, or the field is not a number — caller treats
 * null as "no limit configured" so a missing config never blocks the alert.
 */
export function readMaxCrashesPerDay(agentDir: string | undefined): number | null {
  if (!agentDir) return null;
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    return typeof cfg.max_crashes_per_day === 'number' ? cfg.max_crashes_per_day : null;
  } catch {
    return null;
  }
}

/**
 * Send a crash notification via `cortextos bus send-message` to the listed
 * recipient agents. Best-effort: failures are swallowed so an alert miss never
 * cascades into a hook crash.
 */
export function notifyAgents(opts: {
  agentName: string;
  endType: string;
  reason: string;
  lastTask: string;
  crashCount: number;
  restartAttempted: boolean;
  recipients: string[];
}): void {
  const body = [
    `agent=${opts.agentName} crashed (type=${opts.endType})`,
    `reason: ${opts.reason || 'none'}`,
    `last status: ${opts.lastTask || 'unknown'}`,
    `crashes today: ${opts.crashCount}`,
    `restart attempted: ${opts.restartAttempted ? 'yes' : 'no (max_crashes_per_day reached)'}`,
  ].join('\n');
  for (const target of opts.recipients) {
    try {
      execFile(
        'cortextos',
        ['bus', 'send-message', target, 'high', body],
        { timeout: 10_000 },
        () => { /* fire-and-forget */ },
      );
    } catch { /* best-effort, never throw */ }
  }
}

/**
 * Return true if an identical (agent, type) alert was already sent within
 * the dedup window. Side effect: records this attempt when it is the first.
 */
function shouldSuppressDedup(stateDir: string, endType: string): boolean {
  const dedupFile = join(stateDir, '.crash_alert_dedup.json');
  const now = Date.now();
  let last: Record<string, number> = {};
  try {
    last = JSON.parse(readFileSync(dedupFile, 'utf-8')) as Record<string, number>;
  } catch { /* missing or corrupt — start fresh */ }
  const prev = last[endType] ?? 0;
  if (now - prev < DEDUP_WINDOW_MS) {
    return true;
  }
  last[endType] = now;
  try {
    writeFileSync(dedupFile, JSON.stringify(last), 'utf-8');
  } catch { /* ignore */ }
  return false;
}

/**
 * Read the SessionEnd reason from the Claude Code hook payload on stdin.
 * Returns empty string if stdin is unavailable or the payload is non-JSON.
 */
function readSessionEndReason(): string {
  try {
    const raw = readFileSync(0, 'utf-8').trim();
    if (!raw) return '';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.reason === 'string' ? parsed.reason : '';
  } catch {
    return '';
  }
}

/**
 * Write a cookie recording the timestamp of the most recent planned end type
 * so that a second SessionEnd within 60s can be recognised as an aftershock.
 */
function writePlannedRestartCookie(stateDir: string): void {
  try {
    writeFileSync(join(stateDir, '.recent-planned-restart-at'), String(Date.now()), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Apply the two false-positive suppression rules when no marker was found and
 * rate-limit detection did not match. Returns the final endType string.
 *
 * Rule 1 — non-crash SessionEnd reason: clear/logout/prompt_input_submit/compact
 *   → reclassify as session-event-{reason}, suppress Telegram + crash count
 *
 * Rule 2 — planned-restart aftershock: a second SessionEnd within 60s of a
 *   planned restart (cookie present and fresh)
 *   → reclassify as planned-restart-aftershock, suppress Telegram + crash count
 *
 * Exported for unit testing.
 */
export function classifySessionEndFallthrough(opts: {
  sessionEndReason: string;
  stateDir: string;
}): string {
  if (NON_CRASH_REASONS.has(opts.sessionEndReason)) {
    return `session-event-${opts.sessionEndReason}`;
  }
  const cookiePath = join(opts.stateDir, '.recent-planned-restart-at');
  try {
    const ts = parseInt(readFileSync(cookiePath, 'utf-8').trim(), 10);
    if (!isNaN(ts) && Date.now() - ts < AFTERSHOCK_WINDOW_MS) {
      return 'planned-restart-aftershock';
    }
  } catch { /* no cookie — genuine crash */ }
  return 'crash';
}

async function main(): Promise<void> {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return;

  const ctxRoot = join(homedir(), '.cortextos', instanceId);
  const stateDir = join(ctxRoot, 'state', agentName);
  const logDir = join(ctxRoot, 'logs', agentName);

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  // Read SessionEnd reason from Claude Code hook stdin payload before anything
  // else so we have it available for fallthrough classification below.
  const sessionEndReason = readSessionEndReason();

  // Determine end type from state markers (written by other parts of the system
  // before the Claude Code session exits).
  let endType = 'crash';
  let reason = '';

  const markers = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-disable', type: 'user-disable' },
    { file: '.user-stop', type: 'user-stop' },
    // .daemon-crashed wins over .daemon-stop when both are present — a crash
    // during shutdown is the more important signal. Written by the daemon's
    // uncaughtException handler in src/daemon/index.ts.
    { file: '.daemon-crashed', type: 'daemon-crashed' },
    { file: '.daemon-stop', type: 'daemon-stop' },
  ];

  for (const marker of markers) {
    const markerPath = join(stateDir, marker.file);
    if (existsSync(markerPath)) {
      endType = marker.type;
      try {
        reason = readFileSync(markerPath, 'utf-8').trim();
        unlinkSync(markerPath);
      } catch { /* ignore */ }
      break;
    }
  }

  // When a planned end type is detected, stamp a cookie so a second SessionEnd
  // that fires shortly after (the "aftershock") can be suppressed.
  if (endType !== 'crash' && endType !== 'daemon-crashed') {
    writePlannedRestartCookie(stateDir);
  }

  // If no marker matched but the stdout tail shows a rate-limit signature,
  // reclassify as rate-limited. Prevents the 30-minute 🚨 CRASH buzz storm
  // when the weekly limit is exhausted.
  if (endType === 'crash') {
    const stdoutPath = join(logDir, 'stdout.log');
    if (existsSync(stdoutPath) && detectRateLimitInLog(stdoutPath)) {
      endType = 'rate-limited';
      reason = 'anthropic rate limit detected in stdout.log';
    }
  }

  // Apply false-positive suppression for non-crash SessionEnd reasons and
  // planned-restart aftershocks.
  if (endType === 'crash') {
    endType = classifySessionEndFallthrough({ sessionEndReason, stateDir });
  }

  // Track crash count (real crashes only).
  const today = new Date().toISOString().split('T')[0];
  const countFile = join(stateDir, '.crash_count_today');
  let crashCount = 0;
  if (endType === 'crash') {
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) + 1 : 1;
    } catch {
      crashCount = 1;
    }
    try {
      writeFileSync(countFile, `${today}:${crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  } else if (endType === 'daemon-crashed') {
    // Read-only: surface today's count to chief/analyst without mutating it.
    try {
      const data = readFileSync(countFile, 'utf-8').trim();
      const [date, count] = data.split(':');
      crashCount = date === today ? parseInt(count, 10) : 0;
    } catch {
      crashCount = 0;
    }
  }

  // Read last heartbeat for context
  let lastTask = '';
  try {
    const hb = JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf-8'));
    lastTask = hb.status || '';
  } catch { /* ignore */ }

  // Always log to crashes.log — we want visibility even when alerts are muted.
  // Include sessionend_reason for diagnostic visibility on suppressed events.
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} type=${endType} reason=${reason || 'none'} last_task=${lastTask} sessionend_reason=${sessionEndReason || 'none'}\n`;
  try {
    appendFileSync(join(logDir, 'crashes.log'), logLine);
  } catch { /* ignore */ }

  // Decide whether to actually send to Telegram.
  const now = new Date();
  const quiet = isQuietHoursLA(now);
  if (quiet && QUIET_SUPPRESSED_TYPES.has(endType)) {
    return;
  }
  if (shouldSuppressDedup(stateDir, endType)) {
    return;
  }

  const botToken = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;
  if (!botToken || !chatId) return;

  let message = '';
  switch (endType) {
    case 'planned-restart':
      message = reason?.startsWith('CONTEXT-FORCE-RESTART')
        ? `🔄 ${agentName} restarting with memory`
        : `🔄 ${agentName} restarted (planned): ${reason || 'no reason given'}`;
      break;
    case 'session-refresh':
      message = `♻️ ${agentName} session refresh (context exhaustion). Restarting with fresh session.`;
      break;
    case 'user-restart':
      message = `🔄 ${agentName} restarted by user: ${reason || 'no reason given'}`;
      break;
    case 'user-disable':
      message = `⏸️ ${agentName} disabled by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'user-stop':
      message = `⏹️ ${agentName} stopped by user.`;
      if (reason) message += ` (${reason})`;
      break;
    case 'daemon-stop':
      message = `🛑 ${agentName} stopped (daemon shutdown).`;
      if (reason) message += ` (${reason})`;
      break;
    case 'daemon-crashed':
      // Deliberately NOT suppressed during quiet hours — a daemon crash at
      // 3am is genuinely worth waking for (historically it has preceded
      // fleet-wide restart storms). Crash-loop alerts from the daemon
      // itself add operator-level urgency; this is the per-agent variant
      // that replaces the misleading "🚨 agent crashed" message users
      // were getting on every daemon respawn.
      message = `🚨 ${agentName} — daemon crashed, session was interrupted. Resuming.`;
      if (reason) message += `\nCrash time: ${reason}`;
      break;
    case 'rate-limited':
      message = `⏳ ${agentName} paused — Anthropic rate limit hit. Will resume when the window resets.`;
      break;
    case 'crash':
      message = `🚨 CRASH: ${agentName} died unexpectedly.`;
      if (crashCount > 0) message += ` Crashes today: ${crashCount}.`;
      if (lastTask) message += `\nLast status: ${lastTask}`;
      break;
    // Suppressed types — logged to crashes.log but no Telegram alert.
    // planned-restart-aftershock: second SessionEnd fired within 60s of a
    //   planned restart (Claude Code emits SessionEnd twice on some exit paths).
    // session-event-*: clean Claude Code exits (clear/logout/compact/etc.) that
    //   are not crashes — most commonly auto-compact after a heavy session.
    case 'planned-restart-aftershock':
    default:
      // message stays '' — if (message) guard below prevents any send
      break;
  }

  if (message) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    } catch { /* ignore send failures */ }
  }

  // Real-crash agent alerts: notify chief + analyst on crash and daemon-crashed
  // so silent failures get visibility on the bus, not just on Telegram. Gated
  // by the same dedup window as the Telegram send (handled above), and skipped
  // for clean exits / planned restarts / rate-limit pauses.
  if (endType === 'crash' || endType === 'daemon-crashed') {
    const agentDir = process.env.CTX_AGENT_DIR || process.cwd();
    const maxCrashes = readMaxCrashesPerDay(agentDir);
    const restartAttempted = maxCrashes === null || crashCount < maxCrashes;
    notifyAgents({
      agentName,
      endType,
      reason,
      lastTask,
      crashCount,
      restartAttempted,
      recipients: ['chief', 'analyst'],
    });
  }
}

main().catch(() => process.exit(0));
