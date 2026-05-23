import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';

export type CodexLimitClass = 'short_throttle' | 'long_lock' | 'auth_expired' | 'none';

export interface CodexLimitResult {
  limitClass: CodexLimitClass;
  retryAfterSecs: number | null;
}

export interface CodexFallbackOptions {
  prompt: string;
  dir: string;
  parentAgent: string;
  taskId?: string;
  autoFallback?: boolean;
  /**
   * When set, enables spillover-2: a second worker dispatched with HOME overridden to
   * this path so it authenticates against the Team workspace OAuth at
   * <claudeTeamHome>/.claude/.credentials.json — distinct account from spillover-1's Max OAuth.
   * Only dispatched on long_lock when autoFallback is true and this path is configured.
   * Convention: set CLAUDE_TEAM_HOME=~/.claude-team in secrets.env and pass it here.
   */
  claudeTeamHome?: string;
}

const SHORT_THROTTLE_MAX_SECS = 1800; // 30 minutes

const RETRY_AFTER_HEADER_RE = /Retry-After:\s*(\d+)/i;
const RETRY_AFTER_TEXT_RE = /try again in (\d+)\s*(s(?:ec(?:ond)?s?)?|min(?:ute)?s?|h(?:our)?s?)/i;
const LIMIT_429_RE = /(?:exceeded.*limit|rate.?limit|429)/i;
const AUTH_401_RE = /(?:401|unauthorized|authentication\s+failed)/i;

function parseRetryAfterText(match: RegExpMatchArray): number {
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('h')) return value * 3600;
  if (unit.startsWith('m')) return value * 60;
  return value;
}

export function parseCodexLimit(stderr: string, exitCode: number | null): CodexLimitResult {
  if (exitCode === 0) {
    return { limitClass: 'none', retryAfterSecs: null };
  }

  if (AUTH_401_RE.test(stderr)) {
    return { limitClass: 'auth_expired', retryAfterSecs: null };
  }

  if (!LIMIT_429_RE.test(stderr)) {
    return { limitClass: 'none', retryAfterSecs: null };
  }

  const headerMatch = RETRY_AFTER_HEADER_RE.exec(stderr);
  if (headerMatch) {
    const secs = parseInt(headerMatch[1], 10);
    return {
      limitClass: secs <= SHORT_THROTTLE_MAX_SECS ? 'short_throttle' : 'long_lock',
      retryAfterSecs: secs,
    };
  }

  const textMatch = RETRY_AFTER_TEXT_RE.exec(stderr);
  if (textMatch) {
    const secs = parseRetryAfterText(textMatch);
    return {
      limitClass: secs <= SHORT_THROTTLE_MAX_SECS ? 'short_throttle' : 'long_lock',
      retryAfterSecs: secs,
    };
  }

  // 429 with no Retry-After — Anthropic omits this header on weekly/monthly caps
  // (they don't know when the cap lifts). Treat as long_lock for fallback dispatch.
  // Transient rate limits always include Retry-After; if it's absent, assume cap.
  return { limitClass: 'long_lock', retryAfterSecs: null };
}

export interface CodexFallbackInput {
  stderr: string;
  exitCode: number | null;
}

export interface CodexFallbackDispatchResult {
  dispatched: boolean;
  workerName?: string;
  limitClass: CodexLimitClass;
}

/**
 * Dedup guard: write a marker under state/{agent}/spillover-dedup/{taskId} so
 * that repeated calls for the same task (e.g. cron fires again mid-spillover)
 * do not spawn a second worker. Marker is session-scoped — it lives in the
 * daemon's state dir and is cleared when the state dir is wiped on agent restart.
 */
function checkAndMarkSpilloverDedup(
  paths: BusPaths,
  agentName: string,
  taskId: string,
): boolean {
  const dedupDir = join(paths.stateDir, agentName, 'spillover-dedup');
  const dedupFile = join(dedupDir, taskId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (existsSync(dedupFile)) return true; // already dispatched
  mkdirSync(dedupDir, { recursive: true });
  writeFileSync(dedupFile, new Date().toISOString());
  return false;
}

export async function handleCodexFallback(
  result: CodexFallbackInput,
  opts: CodexFallbackOptions,
  paths: BusPaths,
  agentName: string,
  org: string,
): Promise<CodexFallbackDispatchResult> {
  const limitResult = parseCodexLimit(result.stderr, result.exitCode);

  if (limitResult.limitClass === 'none') {
    return { dispatched: false, limitClass: 'none' };
  }

  if (limitResult.limitClass === 'auth_expired') {
    logEvent(paths, agentName, org, 'action', 'codex_auth_expired', 'error', {
      task_id: opts.taskId ?? null,
      parent_agent: opts.parentAgent,
      dir: opts.dir,
    });
    return { dispatched: false, limitClass: 'auth_expired' };
  }

  logEvent(paths, agentName, org, 'action', 'codex_limit_hit', 'warning', {
    limit_class: limitResult.limitClass,
    retry_after_secs: limitResult.retryAfterSecs,
    task_id: opts.taskId ?? null,
    dir: opts.dir,
  });

  if (limitResult.limitClass !== 'long_lock' || !opts.autoFallback) {
    return { dispatched: false, limitClass: limitResult.limitClass };
  }

  // Dedup: skip if a spillover worker was already dispatched for this task.
  if (opts.taskId) {
    const alreadyDispatched = checkAndMarkSpilloverDedup(paths, agentName, opts.taskId);
    if (alreadyDispatched) {
      logEvent(paths, agentName, org, 'action', 'codex_failover_dedup_skip', 'info', {
        task_id: opts.taskId,
        reason: 'spillover already dispatched for this task in current session',
      });
      return { dispatched: false, limitClass: limitResult.limitClass };
    }
  }

  // Spillover-1: Max OAuth (default HOME, local ~/.claude/.credentials.json)
  const workerName = `codex-spillover-1-${Date.now()}`;
  const workerPrompt = [
    opts.prompt,
    '',
    `cortextos bus send-message ${opts.parentAgent} normal "done: ${workerName} completed" && cortextos terminate-worker ${workerName}`,
  ].join('\n');

  const spawnResult1 = spawnSync(
    'cortextos',
    [
      'bus', 'spawn-worker', workerName,
      '--dir', opts.dir,
      '--prompt', workerPrompt,
      '--parent', opts.parentAgent,
      '--model', 'claude-opus-4-7',
    ],
    { stdio: 'pipe', timeout: 30000 },
  );

  if (spawnResult1.status !== 0) {
    logEvent(paths, agentName, org, 'action', 'codex_failover_dispatch_failed', 'error', {
      worker_name: workerName,
      tier: 'spillover-1',
      exit_code: spawnResult1.status,
      task_id: opts.taskId ?? null,
    });
    return { dispatched: false, limitClass: limitResult.limitClass };
  }

  logEvent(paths, agentName, org, 'action', 'codex_failover_dispatched', 'info', {
    worker_name: workerName,
    tier: 'spillover-1',
    limit_class: limitResult.limitClass,
    retry_after_secs: limitResult.retryAfterSecs,
    task_id: opts.taskId ?? null,
    parent_agent: opts.parentAgent,
    dir: opts.dir,
  });

  // Spillover-2: Team OAuth (override HOME to claudeTeamHome so claude reads Team workspace creds)
  // Dispatched in parallel when CLAUDE_TEAM_HOME is configured — provides a second auth context
  // so if the Max account is also saturated, the Team workspace absorbs the load.
  if (opts.claudeTeamHome) {
    const worker2Name = `codex-spillover-2-${Date.now()}`;
    const worker2Prompt = [
      opts.prompt,
      '',
      `cortextos bus send-message ${opts.parentAgent} normal "done: ${worker2Name} completed" && cortextos terminate-worker ${worker2Name}`,
    ].join('\n');

    const spawnResult2 = spawnSync(
      'cortextos',
      [
        'bus', 'spawn-worker', worker2Name,
        '--dir', opts.dir,
        '--prompt', worker2Prompt,
        '--parent', opts.parentAgent,
        '--model', 'claude-opus-4-7',
        '--home', opts.claudeTeamHome,
      ],
      { stdio: 'pipe', timeout: 30000 },
    );

    if (spawnResult2.status !== 0) {
      logEvent(paths, agentName, org, 'action', 'codex_failover_dispatch_failed', 'error', {
        worker_name: worker2Name,
        tier: 'spillover-2',
        exit_code: spawnResult2.status,
        task_id: opts.taskId ?? null,
      });
    } else {
      logEvent(paths, agentName, org, 'action', 'codex_failover_dispatched', 'info', {
        worker_name: worker2Name,
        tier: 'spillover-2',
        limit_class: limitResult.limitClass,
        retry_after_secs: limitResult.retryAfterSecs,
        task_id: opts.taskId ?? null,
        parent_agent: opts.parentAgent,
        dir: opts.dir,
        claude_team_home: opts.claudeTeamHome,
      });
    }
  }

  return { dispatched: true, workerName, limitClass: limitResult.limitClass };
}
