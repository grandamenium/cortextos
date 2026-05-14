/**
 * Fleet-resilience plan #5 — cortextos status --json.
 *
 * Verifies that:
 *   (a) the --json flag is wired on the command;
 *   (b) daemon-running + --json emits the AgentStatus[] payload as JSON;
 *   (c) daemon-down + --json emits an empty array (queryable state);
 *   (d) absence of --json preserves the legacy table output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentStatus } from '../../../src/types/index';

// IPC mock — fully controllable per test. Must be declared before the module
// import below since the import triggers commander's static registration.
const mockSend = vi.fn();
const mockIsDaemonRunning = vi.fn();

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockSend;
    isDaemonRunning = mockIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

// Now safe to import the command.
import { statusCommand } from '../../../src/cli/status';

const SAMPLE_STATUS: AgentStatus = {
  name: 'boss',
  status: 'running',
  pid: 12345,
  uptime: 3600,
  sessionStart: '2026-05-15T08:00:00Z',
  crashCount: 0,
  model: 'claude-sonnet-4-6',
  lastHeartbeatAgeSeconds: 12,
  lastHeartbeatTask: 'heartbeat — fleet healthy',
  lastInboxMessageAgeSeconds: 600,
  crashCountToday: 0,
  maxCrashesPerDay: 10,
  crashesRemaining: 10,
  lastRestartReason: '6h session refresh',
  lastRestartKind: 'SELF-RESTART',
  lastSpawnFailureAgeSeconds: null,
};

describe('cortextos status --json (fleet-resilience #5)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  beforeEach(() => {
    mockSend.mockReset();
    mockIsDaemonRunning.mockReset();
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8'));
      return true;
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => { /* silence */ });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('registers --json as an option with a discoverable description', () => {
    const opt = statusCommand.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
    expect(opt!.description.toLowerCase()).toContain('json');
  });

  it('daemon running + --json emits AgentStatus[] with all extended fields', async () => {
    mockIsDaemonRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ success: true, data: [SAMPLE_STATUS] });

    await statusCommand.parseAsync(['node', 'status', '--json']);

    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out) as AgentStatus[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: 'boss',
      lastHeartbeatAgeSeconds: 12,
      lastHeartbeatTask: 'heartbeat — fleet healthy',
      lastInboxMessageAgeSeconds: 600,
      crashCountToday: 0,
      maxCrashesPerDay: 10,
      crashesRemaining: 10,
      lastRestartKind: 'SELF-RESTART',
      lastRestartReason: '6h session refresh',
      lastSpawnFailureAgeSeconds: null,
    });
    // The table-output console.log calls should NOT have fired in --json mode.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('daemon down + --json emits empty array (queryable state, not error)', async () => {
    mockIsDaemonRunning.mockResolvedValue(false);

    await statusCommand.parseAsync(['node', 'status', '--json']);

    const out = stdoutChunks.join('');
    expect(JSON.parse(out)).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('daemon running + no --json preserves legacy table output (no stdout JSON)', async () => {
    mockIsDaemonRunning.mockResolvedValue(true);
    mockSend.mockResolvedValue({ success: true, data: [SAMPLE_STATUS] });

    await statusCommand.parseAsync(['node', 'status']);

    expect(stdoutChunks.join('')).toBe('');
    // Table output goes through console.log — confirm at least the header line fired.
    const consoleOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(consoleOutput).toContain('Agent Status');
    expect(consoleOutput).toContain('boss');
  });
});
