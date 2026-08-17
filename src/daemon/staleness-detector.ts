/**
 * Dual-source staleness detector.
 *
 * Heartbeat-only staleness produced a persistent false-positive class: cron
 * prompts that lack an update-heartbeat line leave heartbeat.json untouched
 * while cron-fire records prove continuous liveness (2026-07-10 binding
 * amendment). And when a stall IS real, the fleet-standard peer-notify
 * mitigation shares the failure mode — a stalled peer cannot notify anyone
 * (stall #3 datum). This detector is the non-session trigger.
 *
 * Rule: an agent is flagged stale ONLY when EVERY liveness source has been
 * silent for more than the threshold (default 45 min):
 *   1. heartbeat.json last_heartbeat  (agent- or watchdog-written)
 *   2. cron-state.json most recent fire (any recorded fire = liveness beat)
 *   3. last_idle.flag mtime            (Stop hook turn-end signal)
 *
 * On staleness: write the .urgent-signal wake file + bus message via
 * notifyAgent (the resubmit mechanism that recovered every observed stall),
 * log loudly, and hold a per-agent cooldown so a genuinely wedged agent is
 * prodded at most once per threshold window.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { notifyAgent } from '../bus/agents.js';
import { readCronState } from '../bus/cron-state.js';
import { resolvePaths } from '../utils/paths.js';

export const DEFAULT_STALE_THRESHOLD_MS = 45 * 60 * 1000;
export const DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export interface LivenessSources {
  /** ms epoch of heartbeat.json last_heartbeat (undefined = no signal ever) */
  heartbeatAt?: number;
  /** ms epoch of the most recent recorded cron fire */
  lastCronFireAt?: number;
  /** ms epoch of last_idle.flag write (Stop hook turn-end) */
  idleFlagAt?: number;
}

export interface StalenessVerdict {
  stale: boolean;
  /** ms since the freshest available signal; Infinity when no source exists */
  ageMs: number;
  /** which source was freshest, for the log line */
  freshestSource: 'heartbeat' | 'cron-fire' | 'idle-flag' | 'none';
}

/**
 * Pure staleness rule: stale iff every AVAILABLE source is older than the
 * threshold. An agent with NO sources at all is never flagged (nothing to
 * distinguish "new agent" from "broken state dir" — flagging would wake
 * agents that simply have not written anything yet).
 */
export function assessStaleness(
  sources: LivenessSources,
  nowMs: number,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): StalenessVerdict {
  const entries: Array<[StalenessVerdict['freshestSource'], number]> = [];
  if (sources.heartbeatAt !== undefined) entries.push(['heartbeat', sources.heartbeatAt]);
  if (sources.lastCronFireAt !== undefined) entries.push(['cron-fire', sources.lastCronFireAt]);
  if (sources.idleFlagAt !== undefined) entries.push(['idle-flag', sources.idleFlagAt]);

  if (entries.length === 0) return { stale: false, ageMs: Infinity, freshestSource: 'none' };

  let freshest = entries[0];
  for (const e of entries) if (e[1] > freshest[1]) freshest = e;
  const ageMs = nowMs - freshest[1];
  return { stale: ageMs > thresholdMs, ageMs, freshestSource: freshest[0] };
}

/** Read the three liveness sources for one agent from its state dir. */
export function readLivenessSources(stateDir: string): LivenessSources {
  const out: LivenessSources = {};

  const hbPath = join(stateDir, 'heartbeat.json');
  if (existsSync(hbPath)) {
    try {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
      const t = Date.parse(hb.last_heartbeat);
      out.heartbeatAt = Number.isNaN(t) ? statSync(hbPath).mtimeMs : t;
    } catch {
      try { out.heartbeatAt = statSync(hbPath).mtimeMs; } catch { /* gone */ }
    }
  }

  try {
    const cronState = readCronState(stateDir);
    let latest: number | undefined;
    for (const entry of cronState.crons) {
      const t = Date.parse(entry.last_fire ?? '');
      if (!Number.isNaN(t) && (latest === undefined || t > latest)) latest = t;
    }
    if (latest !== undefined) out.lastCronFireAt = latest;
  } catch { /* no cron state */ }

  const flagPath = join(stateDir, 'last_idle.flag');
  if (existsSync(flagPath)) {
    try { out.idleFlagAt = statSync(flagPath).mtimeMs; } catch { /* gone */ }
  }

  return out;
}

export interface StalenessDetectorOptions {
  instanceId: string;
  ctxRoot: string;
  /** Live roster: agent names (with orgs) currently running under the daemon */
  listAgents: () => Array<{ name: string; org: string }>;
  log?: (msg: string) => void;
  thresholdMs?: number;
  checkIntervalMs?: number;
  /** Injectable for tests */
  notify?: typeof notifyAgent;
  now?: () => number;
}

export class StalenessDetector {
  private timer: NodeJS.Timeout | null = null;
  private lastProddedAt: Map<string, number> = new Map();
  private readonly opts: Required<Pick<StalenessDetectorOptions, 'thresholdMs' | 'checkIntervalMs'>> & StalenessDetectorOptions;

  constructor(options: StalenessDetectorOptions) {
    this.opts = {
      thresholdMs: DEFAULT_STALE_THRESHOLD_MS,
      checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
      ...options,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkOnce(), this.opts.checkIntervalMs);
    // Unref so the detector never keeps a shutting-down daemon alive
    this.timer.unref?.();
    (this.opts.log ?? console.log)(
      `[staleness] detector started (threshold ${Math.round(this.opts.thresholdMs / 60000)} min, check every ${Math.round(this.opts.checkIntervalMs / 60000)} min)`
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One sweep over the live roster. Exposed for tests. */
  checkOnce(): void {
    const log = this.opts.log ?? console.log;
    const now = (this.opts.now ?? Date.now)();
    const notify = this.opts.notify ?? notifyAgent;

    for (const { name, org } of this.opts.listAgents()) {
      const stateDir = join(this.opts.ctxRoot, 'state', name);
      const sources = readLivenessSources(stateDir);
      const verdict = assessStaleness(sources, now, this.opts.thresholdMs);
      if (!verdict.stale) continue;

      const lastProd = this.lastProddedAt.get(name) ?? 0;
      if (now - lastProd < this.opts.thresholdMs) continue; // cooldown

      const ageMin = Math.round(verdict.ageMs / 60000);
      log(`[staleness] ${name}: ALL liveness sources silent ${ageMin} min (freshest: ${verdict.freshestSource}) — sending wake signal`);
      try {
        const paths = resolvePaths(name, this.opts.instanceId, org);
        notify(
          paths,
          'daemon',
          name,
          `daemon staleness detector: all liveness sources (heartbeat, cron fires, idle flag) silent ${ageMin} min. ` +
          `If you receive this, your session likely had undelivered input — process your queue, update your heartbeat, and note the gap in your log.`,
          this.opts.ctxRoot,
        );
        this.lastProddedAt.set(name, now);
      } catch (err) {
        log(`[staleness] ${name}: wake signal failed: ${err}`);
      }
    }
  }
}
