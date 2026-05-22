import { spawnSync } from 'child_process';
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

  // 429 with no Retry-After → treat as weekly cap
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

  logEvent(paths, agentName, org, 'action', 'codex_limit_hit', 'warning', {
    limit_class: limitResult.limitClass,
    retry_after_secs: limitResult.retryAfterSecs,
    task_id: opts.taskId ?? null,
    dir: opts.dir,
  });

  if (limitResult.limitClass !== 'long_lock' || !opts.autoFallback) {
    return { dispatched: false, limitClass: limitResult.limitClass };
  }

  const workerName = `codex-spillover-${Date.now()}`;
  const workerPrompt = [
    opts.prompt,
    '',
    `cortextos bus send-message ${opts.parentAgent} normal "done: ${workerName} completed" && cortextos terminate-worker ${workerName}`,
  ].join('\n');

  spawnSync(
    'cortextos',
    [
      'bus', 'spawn-worker', workerName,
      '--dir', opts.dir,
      '--prompt', workerPrompt,
      '--parent', opts.parentAgent,
      '--model', 'claude-opus-4-7',
    ],
    { stdio: 'pipe' },
  );

  logEvent(paths, agentName, org, 'action', 'codex_failover_dispatched', 'info', {
    worker_name: workerName,
    limit_class: limitResult.limitClass,
    retry_after_secs: limitResult.retryAfterSecs,
    task_id: opts.taskId ?? null,
    parent_agent: opts.parentAgent,
    dir: opts.dir,
  });

  return { dispatched: true, workerName, limitClass: limitResult.limitClass };
}
