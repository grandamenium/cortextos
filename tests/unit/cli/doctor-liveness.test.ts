import { describe, expect, it } from 'vitest';
import { classifyAgentLiveness } from '../../../src/cli/doctor';

const NOW_MS = Date.UTC(2026, 5, 28, 12, 0, 0);

describe('cortextos doctor liveness classification', () => {
  it('warns but does not restart when heartbeat is stale and stdout is recent', () => {
    const result = classifyAgentLiveness({
      agent: 'busy-agent',
      heartbeatTimestampMs: NOW_MS - 3 * 60 * 60 * 1000,
      heartbeatLabel: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
      stdoutMtimeMs: NOW_MS - 5 * 60 * 1000,
      stdoutLabel: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
      nowMs: NOW_MS,
    });

    expect(result.status).toBe('WARN');
    expect(result.message).toContain('busy/heads-down');
    expect(result.message).toContain('do NOT restart');
    expect(result.fix).toContain('Do not restart');
  });

  it('warns to investigate (not auto-restart) when heartbeat and stdout are both stale', () => {
    const result = classifyAgentLiveness({
      agent: 'frozen-agent',
      heartbeatTimestampMs: NOW_MS - 3 * 60 * 60 * 1000,
      heartbeatLabel: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
      stdoutMtimeMs: NOW_MS - 3 * 60 * 60 * 1000,
      stdoutLabel: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
      nowMs: NOW_MS,
    });

    // Both stale can't be PROVEN frozen from logs alone (idle-on-cadence looks
    // identical), so it's a WARN to investigate, not a FAIL implying a restart.
    expect(result.status).toBe('WARN');
    expect(result.message).toContain('possibly stalled');
    expect(result.fix).toContain('Verify first');
    expect(result.fix).toContain('soft-restart frozen-agent');
  });

  it('treats a long idle gap within the stdout window as busy, not frozen', () => {
    const result = classifyAgentLiveness({
      agent: 'idle-cadence-agent',
      heartbeatTimestampMs: NOW_MS - 3 * 60 * 60 * 1000,
      heartbeatLabel: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
      stdoutMtimeMs: NOW_MS - 60 * 60 * 1000, // 60m < 90m window
      stdoutLabel: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      nowMs: NOW_MS,
    });

    expect(result.status).toBe('WARN');
    expect(result.message).toContain('busy/heads-down');
  });

  it('passes when heartbeat is fresh even if stdout is quiet', () => {
    const result = classifyAgentLiveness({
      agent: 'alive-agent',
      heartbeatTimestampMs: NOW_MS - 10 * 60 * 1000,
      heartbeatLabel: new Date(NOW_MS - 10 * 60 * 1000).toISOString(),
      stdoutMtimeMs: NOW_MS - 60 * 60 * 1000,
      stdoutLabel: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      nowMs: NOW_MS,
    });

    expect(result.status).toBe('OK');
  });
});

