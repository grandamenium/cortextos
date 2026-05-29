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
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

const DEDUP_WINDOW_MS = 10 * 60 * 1000;         // 10 minutes
const QUIET_HOUR_START_LA = 22;                 // 22:00 America/Los_Angeles
const QUIET_HOUR_END_LA = 7;                    // 07:00 America/Los_Angeles

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
 * A restart marker is valid for the hook only while younger than this. The TTL
 * budget runs from when the marker is WRITTEN — which is inside sessionRefresh
 * BEFORE `await stop()` — to the LAST hook firing it must still classify, i.e.
 * firing#2. So the budget must cover: stop()'s PTY-exit wait + the inter-firing
 * gap. The inter-firing gap is ~13-22s typical; stop() is normally fast but is
 * NOT bounded — BUG-011 exists precisely because PTY exit can hang. 300s is
 * sized to absorb a slow stop() on top of the firing gap, not just the gap.
 *
 * The daemon's post-restart heartbeat is the primary clear (see updateHeartbeat
 * in src/bus/heartbeat.ts). This TTL is the BACKSTOP for a failed start that
 * never heartbeats: a marker older than the TTL is treated as stale, ignored,
 * and lazy-unlinked, so it cannot misclassify a genuine crash arbitrarily far
 * in the future.
 *
 * Sized on a deliberate cost asymmetry: a TTL too tight re-exposes the exact
 * false-positive bug (it would ignore the marker at a slow firing#2); a TTL too
 * generous only widens the bounded failed-start false-negative window — which
 * the heartbeat-staleness monitor catches as a secondary path anyway.
 */
const MARKER_TTL_MS = 300_000; // 5 minutes

/**
 * Read the hook's stdin JSON payload. Claude Code pipes a JSON object to
 * SessionEnd hooks containing `session_id` (the ending session's id) plus
 * other event fields. Mirrors the stdin-read in hook-context-status.ts.
 * Returns {} on any failure. The session_id is recorded in crashes.log for
 * audit; it is not used for classification.
 */
async function readHookInput(): Promise<{ session_id?: string }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    // Fallback so a stdin that never ends can't hang the hook. unref()'d and
    // cleared on a clean end/error so the timer never keeps the process alive
    // past its work — without this the hook lingers up to 1.5s after it is done.
    const timer = setTimeout(resolve, 1500);
    timer.unref?.();
    const finish = () => { clearTimeout(timer); resolve(); };
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return {};
  }
}

/**
 * Classify a SessionEnd from the state markers, returning the marker-derived
 * end type + reason — WITHOUT consuming the marker.
 *
 * Why no-consume: a single restart fires the SessionEnd hook TWICE for one
 * logical session-end (~13-22s apart) — once from the dying PTY, once from
 * the next PTY's fresh-launch cleanup. Every restart path writes exactly ONE
 * hook-recognized marker. The previous code unlinked the marker on the first
 * firing, so the second firing found nothing and was logged as a false
 * `type=crash reason=none` — the FP pairs in crashes.log. Leaving the marker
 * in place lets BOTH firings classify correctly. The marker is cleared by the
 * daemon's first-post-restart heartbeat (the successor session is genuinely
 * up by then), with the TTL above as the failed-start backstop.
 *
 * A marker older than MARKER_TTL_MS is treated as stale: ignored (so it
 * cannot misclassify a later genuine crash) and lazy-unlinked here.
 *
 * Returns { endType: 'crash' } when no fresh marker is present.
 */
export function classifyFromMarkers(
  stateDir: string,
  markers: { file: string; type: string }[],
  nowMs: number = Date.now(),
): { endType: string; reason: string } {
  for (const marker of markers) {
    const markerPath = join(stateDir, marker.file);
    if (!existsSync(markerPath)) continue;
    let ageMs = 0;
    try {
      ageMs = nowMs - statSync(markerPath).mtimeMs;
    } catch { /* unreadable mtime — treat as fresh, fall through to classify */ }
    if (ageMs > MARKER_TTL_MS) {
      // Stale: the first-heartbeat clear evidently never fired (failed
      // start). Do not classify from it — lazy-unlink and keep looking.
      try { unlinkSync(markerPath); } catch { /* ignore */ }
      continue;
    }
    let reason = '';
    try {
      reason = readFileSync(markerPath, 'utf-8').trim();
    } catch { /* ignore */ }
    return { endType: marker.type, reason };
  }
  return { endType: 'crash', reason: '' };
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

  // session_id is recorded in crashes.log for audit only — not used to
  // classify. (An earlier iteration deduped firings by session_id; that was
  // wrong — the two firings of one restart carry DIFFERENT session_ids, one
  // real session + one ephemeral. The fix is marker-handling, not id-dedup.)
  const hookInput = await readHookInput();
  const sessionId = typeof hookInput.session_id === 'string' ? hookInput.session_id : '';

  // Determine end type from state markers (written by other parts of the
  // system before the Claude Code session exits). Markers are NOT consumed
  // here — see classifyFromMarkers for why (restart fires this hook twice).
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

  const classified = classifyFromMarkers(stateDir, markers);
  let endType = classified.endType;
  let reason = classified.reason;

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
  // session_id is recorded purely for audit (there is no session_id dedup —
  // an earlier iteration tried that and it was removed). If a duplicate-firing
  // FP ever slips through, two crashes.log lines sharing a session value make
  // it provable after the fact.
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} type=${endType} reason=${reason || 'none'} session=${sessionId || 'unknown'} last_task=${lastTask}\n`;
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

  // Real-crash agent alerts: notify chief + analyst on crash and daemon-crashed
  // so silent failures get visibility on the bus, not just on Telegram. Gated
  // by the same dedup window as the Telegram send (handled above), and skipped
  // for clean exits / planned restarts / rate-limit pauses. Hoisted above the
  // Telegram-credential gate so agents without BOT_TOKEN/CHAT_ID still reach
  // the bus (issue #317).
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
}

main().catch(() => process.exit(0));
