import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

export const CLAUDE_OAUTH_STALL_PATTERNS = [
  /API Error:\s*401 Invalid authentication credentials/i,
  /Please run \/login/i,
];

export interface ClaudeAgentHealthInput {
  runtime?: string;
  processStatus: string;
  heartbeatIso?: string | null;
  stdoutTail?: string;
  stdoutMtimeMs?: number;
  nowMs?: number;
  heartbeatStaleMs?: number;
  oauthLogRecentMs?: number;
}

export type ClaudeAgentUnhealthyReason =
  | 'not-claude-runtime'
  | 'process-not-running'
  | 'heartbeat-stale'
  | 'oauth-401-log'
  | 'healthy';

export interface ClaudeAgentHealthResult {
  healthy: boolean;
  reason: ClaudeAgentUnhealthyReason;
  heartbeatAgeMs?: number;
}

const DEFAULT_HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const DEFAULT_OAUTH_LOG_RECENT_MS = 30 * 60 * 1000;

export function classifyClaudeAgentHealth(input: ClaudeAgentHealthInput): ClaudeAgentHealthResult {
  const runtime = input.runtime || 'claude-code';
  if (runtime !== 'claude-code') {
    return { healthy: true, reason: 'not-claude-runtime' };
  }

  if (input.processStatus !== 'running') {
    return { healthy: false, reason: 'process-not-running' };
  }

  const nowMs = input.nowMs ?? Date.now();
  const heartbeatStaleMs = input.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const heartbeatAgeMs = parseHeartbeatAge(input.heartbeatIso, nowMs);
  if (heartbeatAgeMs !== undefined && heartbeatAgeMs > heartbeatStaleMs) {
    return { healthy: false, reason: 'heartbeat-stale', heartbeatAgeMs };
  }

  const oauthLogRecentMs = input.oauthLogRecentMs ?? DEFAULT_OAUTH_LOG_RECENT_MS;
  const stdoutRecent = input.stdoutMtimeMs === undefined || nowMs - input.stdoutMtimeMs <= oauthLogRecentMs;
  if (stdoutRecent && containsClaudeOAuthStall(input.stdoutTail || '')) {
    return { healthy: false, reason: 'oauth-401-log', heartbeatAgeMs };
  }

  return { healthy: true, reason: 'healthy', heartbeatAgeMs };
}

export function containsClaudeOAuthStall(text: string): boolean {
  return CLAUDE_OAUTH_STALL_PATTERNS.some((pattern) => pattern.test(text));
}

export function readHeartbeatIso(ctxRoot: string, agentName: string): string | null {
  const path = join(ctxRoot, 'state', agentName, 'heartbeat.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed.last_heartbeat || parsed.timestamp || null;
  } catch {
    return null;
  }
}

export function readStdoutTail(ctxRoot: string, agentName: string, maxBytes = 64 * 1024): { text: string; mtimeMs?: number } {
  const path = join(ctxRoot, 'logs', agentName, 'stdout.log');
  if (!existsSync(path)) return { text: '' };
  try {
    const stats = statSync(path);
    const start = Math.max(0, stats.size - maxBytes);
    const len = stats.size - start;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, start);
      return { text: buf.toString('utf-8', 0, read), mtimeMs: stats.mtimeMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: '' };
  }
}

function parseHeartbeatAge(heartbeatIso: string | null | undefined, nowMs: number): number | undefined {
  if (!heartbeatIso) return undefined;
  const parsed = Date.parse(heartbeatIso);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, nowMs - parsed);
}
