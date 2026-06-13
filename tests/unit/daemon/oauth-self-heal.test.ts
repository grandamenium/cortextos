import { describe, it, expect } from 'vitest';
import {
  classifyClaudeAgentHealth,
  containsClaudeOAuthStall,
} from '../../../src/daemon/oauth-self-heal.js';

describe('Claude OAuth self-heal health classification', () => {
  const now = Date.parse('2026-06-13T18:00:00Z');

  it('ignores non-Claude runtimes', () => {
    const result = classifyClaudeAgentHealth({
      runtime: 'codex-app-server',
      processStatus: 'running',
      heartbeatIso: '2026-06-13T12:00:00Z',
      stdoutTail: 'Please run /login · API Error: 401 Invalid authentication credentials',
      stdoutMtimeMs: now,
      nowMs: now,
    });

    expect(result).toEqual({ healthy: true, reason: 'not-claude-runtime' });
  });

  it('marks running Claude agents unhealthy when heartbeat is stale', () => {
    const result = classifyClaudeAgentHealth({
      runtime: 'claude-code',
      processStatus: 'running',
      heartbeatIso: '2026-06-13T17:40:00Z',
      stdoutTail: '',
      nowMs: now,
      heartbeatStaleMs: 15 * 60 * 1000,
    });

    expect(result.healthy).toBe(false);
    expect(result.reason).toBe('heartbeat-stale');
    expect(result.heartbeatAgeMs).toBe(20 * 60 * 1000);
  });

  it('marks running Claude agents unhealthy on recent OAuth 401/login logs', () => {
    const result = classifyClaudeAgentHealth({
      runtime: 'claude-code',
      processStatus: 'running',
      heartbeatIso: '2026-06-13T17:59:00Z',
      stdoutTail: 'Please run /login · API Error: 401 Invalid authentication credentials',
      stdoutMtimeMs: now - 60_000,
      nowMs: now,
      heartbeatStaleMs: 15 * 60 * 1000,
      oauthLogRecentMs: 30 * 60 * 1000,
    });

    expect(result.healthy).toBe(false);
    expect(result.reason).toBe('oauth-401-log');
  });

  it('does not trigger recovery from old OAuth logs', () => {
    const result = classifyClaudeAgentHealth({
      runtime: 'claude-code',
      processStatus: 'running',
      heartbeatIso: '2026-06-13T17:59:00Z',
      stdoutTail: 'API Error: 401 Invalid authentication credentials',
      stdoutMtimeMs: now - 60 * 60 * 1000,
      nowMs: now,
      heartbeatStaleMs: 15 * 60 * 1000,
      oauthLogRecentMs: 30 * 60 * 1000,
    });

    expect(result).toEqual({
      healthy: true,
      reason: 'healthy',
      heartbeatAgeMs: 60 * 1000,
    });
  });

  it('treats running Claude agents with fresh heartbeat and clean logs as healthy', () => {
    const result = classifyClaudeAgentHealth({
      runtime: 'claude-code',
      processStatus: 'running',
      heartbeatIso: '2026-06-13T17:59:30Z',
      stdoutTail: 'normal output',
      stdoutMtimeMs: now,
      nowMs: now,
    });

    expect(result.healthy).toBe(true);
    expect(result.reason).toBe('healthy');
  });

  it('matches both observed OAuth stall signatures', () => {
    expect(containsClaudeOAuthStall('Please run /login')).toBe(true);
    expect(containsClaudeOAuthStall('API Error: 401 Invalid authentication credentials')).toBe(true);
    expect(containsClaudeOAuthStall('API Error: 429 rate limited')).toBe(false);
  });
});
