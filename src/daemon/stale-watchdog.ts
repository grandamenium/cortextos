import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { AgentManager } from './agent-manager.js';
import { readAllHeartbeats, isHeartbeatStale } from '../bus/heartbeat.js';
import { incrementCrashCount } from './crash-counter.js';
import { ensureDir } from '../utils/atomic.js';
import type { BusPaths, AgentConfig } from '../types/index.js';

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;    // 5 minutes
const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;  // 15 minutes
const RESTART_COOLDOWN_MS = 3 * 60 * 1000;           // 3 minutes between restarts

/**
 * When we detect a rate limit but can't parse a reset time, wait this long
 * before retrying. Previously 30 min, which was way too short — Anthropic's
 * daily usage cap typically doesn't reset for hours, and repeated restarts
 * just burn more tokens on bootstrap in a crash loop.
 */
const RATE_LIMIT_BLIND_WAIT_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * If an agent gets rate-limited AGAIN within this window after a restart
 * attempt, mark it as halted (don't keep retrying). The quota is clearly
 * still exhausted — user needs to decide when to resume.
 */
const RATE_LIMIT_RELAPSE_WINDOW_MS = 30 * 60 * 1000;  // 30 min

/**
 * Max rate-limit-triggered restarts per 24h window. After this, halt the
 * agent and require manual intervention. Prevents burning a full day's
 * quota on restart overhead.
 */
const MAX_RATE_LIMIT_RESTARTS_PER_DAY = 3;

/**
 * Stagger delay between agents restarting after a shared rate limit resets.
 * Prevents all 6 agents from slamming the API simultaneously and immediately
 * re-triggering the rate limit. Agent with restart_priority=1 goes first,
 * each subsequent agent waits STAGGER_DELAY_MS * (priority - 1).
 */
const STAGGER_DELAY_MS = 2 * 60 * 1000;  // 2 minutes between each agent's restart

// How many bytes from the tail of stdout.log to scan for rate-limit signals
const RATE_LIMIT_SCAN_BYTES = 16384;

/**
 * Patterns that indicate Claude Code has hit its token/rate limit.
 * These appear in the PTY stdout when the CLI shows the rate-limit screen.
 */
const RATE_LIMIT_PATTERNS = [
  "You've hit your limit",
  'hit your limit',
  '/rate-limit-options',
  'rate limit',
  'Rate limit',
  'too many requests',
];

/**
 * Regex to extract the reset time from Claude Code's rate-limit screen.
 * Examples:
 *   "resets 3pm (Europe/Berlin)"
 *   "resets 10pm (Europe/Berlin)"
 *   "resets 8am (Europe/Berlin)"
 *   "resets 12:30pm (Europe/Berlin)"
 */
const RESET_TIME_REGEX = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/**
 * Watches agent heartbeats and auto-restarts frozen agents.
 *
 * Handles two distinct failure modes:
 *
 * 1. **Network freeze**: Internet drops, Claude Code API calls hang, PTY session
 *    becomes unresponsive without crashing. Fix: restart the agent.
 *
 * 2. **Token/rate limit**: Claude Code hits the usage cap and shows "You've hit
 *    your limit — resets Xpm (timezone)". Fix: do NOT restart until the reset
 *    time has passed, THEN automatically restart.
 */
export class StaleAgentWatchdog {
  private agentManager: AgentManager;
  private ctxRoot: string;
  private frameworkRoot: string;
  private checkIntervalMs: number;
  private defaultStaleThresholdMs: number;
  private timer: NodeJS.Timeout | null = null;
  private restartingSet: Set<string> = new Set();
  private lastRestartAt: Map<string, number> = new Map();
  /** Tracks the parsed reset timestamp (epoch ms) per rate-limited agent */
  private rateLimitResetsAt: Map<string, number> = new Map();
  /** Scheduled staggered restart time per agent (epoch ms) */
  private scheduledRestartAt: Map<string, number> = new Map();
  /** Last rate-limit-triggered restart per agent (epoch ms) */
  private lastRateLimitRestartAt: Map<string, number> = new Map();
  /** Rate-limit restart count within rolling 24h window */
  private rateLimitRestartCount: Map<string, { count: number; windowStart: number }> = new Map();
  /** Agents halted due to repeated rate-limit relapses — needs manual resume */
  private haltedForRateLimit: Set<string> = new Set();

  constructor(
    agentManager: AgentManager,
    ctxRoot: string,
    frameworkRoot: string,
    options?: { checkIntervalMs?: number; staleThresholdMs?: number },
  ) {
    this.agentManager = agentManager;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.checkIntervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.defaultStaleThresholdMs = options?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  }

  start(): void {
    if (this.timer) return;
    console.log(
      `[watchdog] Stale-agent watchdog started: check every ${this.checkIntervalMs / 60000}m, ` +
      `default stale threshold ${this.defaultStaleThresholdMs / 60000}m, ` +
      `rate-limit detection + auto-restart on reset enabled`,
    );
    this.timer = setInterval(() => {
      this.checkAndRestart().catch((err) => {
        console.error(`[watchdog] Error during stale check: ${err.message}`);
      });
    }, this.checkIntervalMs);
    // Don't let this timer alone hold the event loop open (belt-and-suspenders
    // against a leaked interval surviving an incomplete shutdown).
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[watchdog] Stale-agent watchdog stopped');
    }
  }

  async checkAndRestart(): Promise<void> {
    const paths: Pick<BusPaths, 'ctxRoot'> = { ctxRoot: this.ctxRoot } as BusPaths;
    const heartbeats = readAllHeartbeats(paths as BusPaths);
    const statuses = this.agentManager.getAllStatuses();

    // Build lookup: agent name → heartbeat
    const hbMap = new Map(heartbeats.map(hb => [hb.agent, hb]));

    for (const status of statuses) {
      const { name } = status;

      // Only check running agents — skip stopped, halted, starting, crashed
      if (status.status !== 'running') continue;

      // Skip if already being restarted
      if (this.restartingSet.has(name)) continue;

      // Skip if per-agent config disables watchdog
      const agentConfig = this.readAgentConfig(name);
      if (agentConfig?.stale_watchdog_enabled === false) continue;

      // Determine stale threshold (per-agent override or default)
      const thresholdMs = agentConfig?.stale_threshold_minutes
        ? agentConfig.stale_threshold_minutes * 60 * 1000
        : this.defaultStaleThresholdMs;

      const hb = hbMap.get(name);
      if (!hb) continue; // No heartbeat yet — agent may still be booting

      if (!isHeartbeatStale(hb, thresholdMs)) {
        // Agent is healthy — clear any rate-limit tracking
        this.rateLimitResetsAt.delete(name);
        this.scheduledRestartAt.delete(name);
        continue;
      }

      // Heartbeat is stale. Check WHY before deciding to restart.

      // Skip agents explicitly halted due to repeated rate-limit relapses.
      // User has to manually resume via `cortextos start <agent>`.
      if (this.haltedForRateLimit.has(name)) {
        const lastLog = this.lastLogAt.get(`halted-${name}`) ?? 0;
        if (Date.now() - lastLog > 60 * 60 * 1000) {
          console.log(
            `[watchdog] ${name} HALTED for rate-limit protection — ` +
            `manual restart required (cortextos start ${name})`,
          );
          this.lastLogAt.set(`halted-${name}`, Date.now());
        }
        continue;
      }

      // --- Rate-limit detection ---
      const rateLimitInfo = this.getRateLimitInfo(name);

      if (rateLimitInfo.isLimited) {
        const now = Date.now();

        // Relapse check: if this agent was just restarted due to rate-limit
        // and is NOW rate-limited again within the relapse window, the quota
        // clearly isn't available yet. Halt instead of retrying.
        const lastRestart = this.lastRateLimitRestartAt.get(name);
        if (lastRestart && (now - lastRestart) < RATE_LIMIT_RELAPSE_WINDOW_MS) {
          console.log(
            `[watchdog] ${name} RELAPSED into rate-limit ${Math.round((now - lastRestart) / 60000)}m after last restart — halting`,
          );
          this.haltedForRateLimit.add(name);
          this.sendHaltAlert(name, 'relapse');
          continue;
        }

        // Daily budget check: cap rate-limit-triggered restarts per 24h window
        const budget = this.rateLimitRestartCount.get(name);
        if (budget && (now - budget.windowStart) < 24 * 60 * 60 * 1000) {
          if (budget.count >= MAX_RATE_LIMIT_RESTARTS_PER_DAY) {
            console.log(
              `[watchdog] ${name} hit max rate-limit restarts (${budget.count}/24h) — halting`,
            );
            this.haltedForRateLimit.add(name);
            this.sendHaltAlert(name, 'budget');
            continue;
          }
        }

        // Do we have a known reset time?
        if (rateLimitInfo.resetsAtMs) {
          this.rateLimitResetsAt.set(name, rateLimitInfo.resetsAtMs);

          if (now < rateLimitInfo.resetsAtMs) {
            // Still before reset time — wait
            const waitMin = Math.round((rateLimitInfo.resetsAtMs - now) / 60000);
            // Only log every 30 minutes to avoid spam
            const lastLog = this.lastLogAt.get(name) ?? 0;
            if (now - lastLog > 30 * 60 * 1000) {
              console.log(
                `[watchdog] ${name} rate-limited — resets in ${waitMin}m ` +
                `(${rateLimitInfo.resetsAtStr}). Waiting.`,
              );
              this.lastLogAt.set(name, now);
            }
            continue;
          }

          // Reset time has passed — schedule staggered restart based on priority.
          // Lower priority number = restarts sooner. This prevents all agents
          // from slamming the API at once after a shared rate limit resets.
          const priority = agentConfig?.restart_priority ?? 5;
          const staggerDelay = (priority - 1) * STAGGER_DELAY_MS;
          const restartAt = rateLimitInfo.resetsAtMs + staggerDelay;

          if (!this.scheduledRestartAt.has(name)) {
            this.scheduledRestartAt.set(name, restartAt);
            console.log(
              `[watchdog] ${name} rate-limit reset passed ` +
              `(${rateLimitInfo.resetsAtStr}) — scheduled restart ` +
              `in ${Math.round(Math.max(0, restartAt - Date.now()) / 60000)}m (priority ${priority})`,
            );
          }

          if (Date.now() < restartAt) {
            // Not yet time for this agent's staggered restart
            continue;
          }

          console.log(
            `[watchdog] ${name} staggered restart now (priority ${priority})`,
          );
          this.rateLimitResetsAt.delete(name);
          this.scheduledRestartAt.delete(name);
          this.lastLogAt.delete(name);
          // Fall through to restart logic below
        } else {
          // Rate-limited but can't parse reset time — use a LONG fallback.
          // Anthropic daily caps typically don't reset for hours. Previous
          // 30-min fallback was causing crash loops that burned more quota
          // on bootstrap overhead than the agents did useful work.
          const knownReset = this.rateLimitResetsAt.get(name);
          if (knownReset && now < knownReset) {
            continue; // Still waiting for a previously parsed reset
          }
          if (!this.rateLimitResetsAt.has(name)) {
            this.rateLimitResetsAt.set(name, now + RATE_LIMIT_BLIND_WAIT_MS);
            const ageMin = Math.round((now - new Date(hb.last_heartbeat).getTime()) / 60000);
            const waitH = Math.round(RATE_LIMIT_BLIND_WAIT_MS / 3600000);
            console.log(
              `[watchdog] ${name} stale (${ageMin}m) and rate-limited (no parseable reset time) — ` +
              `fallback: waiting ${waitH}h before retry (protects daily quota)`,
            );
            continue;
          }
          // Fallback timer elapsed — try restart
          console.log(`[watchdog] ${name} rate-limit fallback elapsed — restarting`);
          this.rateLimitResetsAt.delete(name);
          this.lastLogAt.delete(name);
          // Fall through to restart
        }

        // Record this as a rate-limit-triggered restart attempt
        const budgetNow = this.rateLimitRestartCount.get(name);
        if (!budgetNow || (now - budgetNow.windowStart) >= 24 * 60 * 60 * 1000) {
          this.rateLimitRestartCount.set(name, { count: 1, windowStart: now });
        } else {
          this.rateLimitRestartCount.set(name, {
            count: budgetNow.count + 1,
            windowStart: budgetNow.windowStart,
          });
        }
        this.lastRateLimitRestartAt.set(name, now);
      } else {
        // Not rate-limited — clear tracking
        this.rateLimitResetsAt.delete(name);
        this.lastLogAt.delete(name);
      }

      // --- Restart ---

      // Enforce restart cooldown
      const lastRestart = this.lastRestartAt.get(name) ?? 0;
      if (Date.now() - lastRestart < RESTART_COOLDOWN_MS) continue;

      const ageMin = Math.round((Date.now() - new Date(hb.last_heartbeat).getTime()) / 60000);

      // Count this stale restart as a crash. Without this, watchdog restarts
      // bypass the crash counter entirely (stop() sets stopRequested=true,
      // causing handleExit to skip crash counting), so agents never halt.
      const maxCrashes = agentConfig?.max_crashes_per_day ?? 10;
      const { count: crashCount } = incrementCrashCount(this.ctxRoot, name);

      if (crashCount >= maxCrashes) {
        console.log(
          `[watchdog] ${name} stale (${ageMin}m) — HALTED: ` +
          `${crashCount} crashes today (limit: ${maxCrashes}). ` +
          `Agent will not be restarted until tomorrow or manual intervention.`,
        );
        this.appendCrashToRestartsLog(name, crashCount, maxCrashes, 'HALTED');
        // Stop the agent so it doesn't sit in 'running' status
        try {
          await this.agentManager.stopAgent(name);
        } catch { /* ignore */ }
        continue;
      }

      console.log(
        `[watchdog] ${name} stale (${ageMin}m, threshold ${thresholdMs / 60000}m) — ` +
        `restarting (crash #${crashCount}/${maxCrashes})`,
      );
      this.appendCrashToRestartsLog(name, crashCount, maxCrashes, 'WATCHDOG');

      this.restartingSet.add(name);
      this.lastRestartAt.set(name, Date.now());

      try {
        await this.agentManager.restartAgent(name);
        console.log(`[watchdog] ${name} restart complete`);
      } catch (err) {
        console.error(`[watchdog] ${name} restart failed: ${(err as Error).message}`);
      } finally {
        this.restartingSet.delete(name);
      }
    }
  }

  /** Tracks last log timestamp per agent to avoid spamming */
  private lastLogAt: Map<string, number> = new Map();

  /**
   * Check if an agent is currently rate-limited and parse the reset time.
   */
  private getRateLimitInfo(agentName: string): {
    isLimited: boolean;
    resetsAtMs?: number;
    resetsAtStr?: string;
  } {
    const tail = this.readLogTail(agentName);
    if (!tail) return { isLimited: false };

    // Check for rate-limit patterns
    const isLimited = RATE_LIMIT_PATTERNS.some(p => tail.includes(p));
    if (!isLimited) return { isLimited: false };

    // Try to parse reset time
    const match = tail.match(RESET_TIME_REGEX);
    if (!match) return { isLimited: true };

    const [, hourStr, minuteStr, ampm, timezone] = match;
    let hour = parseInt(hourStr, 10);
    const minute = minuteStr ? parseInt(minuteStr, 10) : 0;

    // Convert 12h to 24h
    if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;

    // Build the reset timestamp in the given timezone
    const resetMs = this.buildResetTimestamp(hour, minute, timezone);
    const resetsAtStr = `${hourStr}${minuteStr ? ':' + minuteStr : ''}${ampm} (${timezone})`;

    return { isLimited: true, resetsAtMs: resetMs, resetsAtStr };
  }

  /**
   * Build an epoch-ms timestamp for "today at HH:MM in timezone".
   * If that time has already passed today, returns the past time (caller handles this).
   */
  private buildResetTimestamp(hour: number, minute: number, timezone: string): number {
    try {
      const now = new Date();
      // Get today's date in the target timezone
      const dateStr = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
      // Build ISO string — this is approximate but good enough for a 5-min check interval
      const isoStr = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

      // Convert from timezone to UTC by finding the offset
      const targetDate = new Date(isoStr);
      // Get the offset of the target timezone at this time
      const utcStr = targetDate.toLocaleString('en-US', { timeZone: 'UTC' });
      const tzStr = targetDate.toLocaleString('en-US', { timeZone: timezone });
      const utcDate = new Date(utcStr);
      const tzDate = new Date(tzStr);
      const offsetMs = utcDate.getTime() - tzDate.getTime();

      return targetDate.getTime() + offsetMs;
    } catch {
      // Timezone parsing failed — return "now + 30 min" as fallback
      return Date.now() + 30 * 60 * 1000;
    }
  }

  /**
   * Read the tail of an agent's stdout.log, stripped of ANSI codes.
   */
  private readLogTail(agentName: string): string | null {
    const logPath = join(this.ctxRoot, 'logs', agentName, 'stdout.log');
    try {
      if (!existsSync(logPath)) return null;

      const stats = statSync(logPath);
      if (stats.size === 0) return null;

      const readSize = Math.min(stats.size, RATE_LIMIT_SCAN_BYTES);
      const fd = openSync(logPath, 'r');
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, stats.size - readSize);
      closeSync(fd);

      // Strip ANSI control sequences for reliable matching
      return buffer.toString('utf-8').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    } catch {
      return null;
    }
  }

  /**
   * Append a watchdog-triggered crash/halt entry to the agent's restarts.log.
   * Format matches AgentProcess.appendCrashToRestartsLog for consistency.
   */
  /**
   * Send a halt alert to logs (and eventually Telegram via a future helper).
   * For now: just appends to restarts.log so the cause is visible.
   */
  private sendHaltAlert(agentName: string, reason: 'relapse' | 'budget'): void {
    try {
      const logDir = join(this.ctxRoot, 'logs', agentName);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const reasonMsg =
        reason === 'relapse'
          ? 'rate-limit relapsed within 30min of restart'
          : `exceeded ${MAX_RATE_LIMIT_RESTARTS_PER_DAY} rate-limit restarts in 24h`;
      const logLine = `[${timestamp}] HALTED_RATE_LIMIT: ${reasonMsg} — manual resume required\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
      console.error(
        `[watchdog] ALERT: ${agentName} halted for quota protection (${reason}). ` +
        `User must manually restart with: cortextos start ${agentName}`,
      );
    } catch {
      /* swallow */
    }
  }

  /**
   * External API: user-visible list of halted agents.
   */
  getHaltedAgents(): string[] {
    return Array.from(this.haltedForRateLimit);
  }

  /**
   * External API: clear halt state when user manually resumes an agent.
   */
  clearHalt(agentName: string): void {
    this.haltedForRateLimit.delete(agentName);
    this.rateLimitRestartCount.delete(agentName);
    this.lastRateLimitRestartAt.delete(agentName);
    this.rateLimitResetsAt.delete(agentName);
  }

  private appendCrashToRestartsLog(
    agentName: string,
    crashCount: number,
    maxCrashes: number,
    kind: 'WATCHDOG' | 'HALTED',
  ): void {
    try {
      const logDir = join(this.ctxRoot, 'logs', agentName);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const details =
        kind === 'HALTED'
          ? `stale_restart crash_count=${crashCount} max_crashes=${maxCrashes}`
          : `stale_restart crash_count=${crashCount}`;
      const logLine = `[${timestamp}] ${kind}: ${details}\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
    } catch {
      /* swallow — never break restart logic on a logging failure */
    }
  }

  /**
   * Read per-agent config.json if it exists.
   */
  private readAgentConfig(agentName: string): AgentConfig | null {
    try {
      const orgsDir = join(this.frameworkRoot, 'orgs');
      const orgDirs = readdirSync(orgsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const org of orgDirs) {
        const configPath = join(orgsDir, org, 'agents', agentName, 'config.json');
        try {
          const content = readFileSync(configPath, 'utf-8');
          return JSON.parse(content) as AgentConfig;
        } catch {
          // Not in this org, try next
        }
      }
    } catch {
      // orgs dir missing or unreadable
    }
    return null;
  }
}
