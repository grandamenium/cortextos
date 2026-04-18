import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentManager } from './agent-manager.js';
import { readAllHeartbeats, isHeartbeatStale } from '../bus/heartbeat.js';
import type { BusPaths, AgentConfig } from '../types/index.js';

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;    // 5 minutes
const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;  // 15 minutes
const RESTART_COOLDOWN_MS = 3 * 60 * 1000;           // 3 minutes between restarts

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
        continue;
      }

      // Heartbeat is stale. Check WHY before deciding to restart.

      // --- Rate-limit detection ---
      const rateLimitInfo = this.getRateLimitInfo(name);

      if (rateLimitInfo.isLimited) {
        const now = Date.now();

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

          // Reset time has passed! Restart the agent.
          console.log(
            `[watchdog] ${name} rate-limit reset time passed ` +
            `(${rateLimitInfo.resetsAtStr}) — restarting now`,
          );
          this.rateLimitResetsAt.delete(name);
          this.lastLogAt.delete(name);
          // Fall through to restart logic below
        } else {
          // Rate-limited but can't parse reset time — use fallback backoff
          const knownReset = this.rateLimitResetsAt.get(name);
          if (knownReset && now < knownReset) {
            continue; // Still waiting for a previously parsed reset
          }
          // No reset time at all — back off 30 min, then retry
          if (!this.rateLimitResetsAt.has(name)) {
            this.rateLimitResetsAt.set(name, now + 30 * 60 * 1000);
            const ageMin = Math.round((now - new Date(hb.last_heartbeat).getTime()) / 60000);
            console.log(
              `[watchdog] ${name} stale (${ageMin}m) and rate-limited (no parseable reset time) — ` +
              `fallback: waiting 30m before retry`,
            );
            continue;
          }
          // Fallback timer elapsed — try restart
          console.log(`[watchdog] ${name} rate-limit fallback elapsed — restarting`);
          this.rateLimitResetsAt.delete(name);
          this.lastLogAt.delete(name);
          // Fall through to restart
        }
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
      console.log(`[watchdog] ${name} stale (${ageMin}m, threshold ${thresholdMs / 60000}m) — restarting`);

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
