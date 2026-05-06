/**
 * tests/unit/cli/bus-crons.test.ts — Subtask 1.4 CLI command tests.
 *
 * Tests the 5 new bus subcommands:
 *   add-cron, remove-cron, list-crons, update-cron, test-cron-fire
 *
 * Strategy
 * --------
 * Because `busCommand` is a module-level singleton we cannot re-import it per
 * test (the command registrations only run once at module load time).  Instead
 * we test the commands by:
 *
 *   1. Setting CTX_ROOT to a per-test tempdir before each test so the I/O
 *      functions read from an isolated, clean slate.
 *   2. Mocking `process.exit` to throw so we can assert error paths.
 *   3. Spying on `console.log` / `console.error` to capture output.
 *   4. Mocking the IPC module so daemon calls don't require a live daemon.
 *   5. Setting CTX_FRAMEWORK_ROOT to a tempdir that includes a known agent
 *      directory so the `agentExistsInFramework` helper returns true.
 *
 * The tests exercise the full CLI-to-disk path: parseAsync → action →
 * I/O functions → crons.json on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// IPC mock — prevent real socket connections in unit tests.
// ---------------------------------------------------------------------------

// Default mock: daemon is running and all IPC calls succeed.
const mockIpcSend = vi.fn().mockResolvedValue({ success: true, data: 'mocked' });
const mockIpcIsDaemonRunning = vi.fn().mockResolvedValue(true);

vi.mock('../../../src/daemon/ipc-server.js', () => {
  // Must use a real class so `new IPCClient(...)` works.
  class MockIPCClient {
    send = mockIpcSend;
    isDaemonRunning = mockIpcIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

// ---------------------------------------------------------------------------
// Per-test environment setup
// ---------------------------------------------------------------------------

let tmpRoot: string;
let frameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalInstanceId = process.env.CTX_INSTANCE_ID;

/** The agent whose crons.json we write in the test setup */
const TEST_AGENT = 'boris';

/**
 * Path to TEST_AGENT's crons.json under tmpRoot.
 * Mirrors the path computed by cronsFilePath() in crons.ts.
 */
function cronsJsonPath(): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', TEST_AGENT, 'crons.json');
}

/** Read the raw crons array from disk (for assertions) */
function readCronsFile(): CronDefinition[] {
  const raw = readFileSync(cronsJsonPath(), 'utf-8');
  return JSON.parse(raw).crons as CronDefinition[];
}

/** Write a crons.json with an initial set of cron definitions */
function seedCrons(crons: CronDefinition[]): void {
  const dir = join(tmpRoot, '.cortextOS', 'state', 'agents', TEST_AGENT);
  mkdirSync(dir, { recursive: true });
  const envelope = { updated_at: new Date().toISOString(), crons };
  const { writeFileSync } = require('fs');
  writeFileSync(join(dir, 'crons.json'), JSON.stringify(envelope, null, 2), 'utf-8');
}

function makeCron(name: string, overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name,
    prompt: `Execute ${name} workflow.`,
    schedule: '6h',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bus-crons-test-'));

  // Create a minimal framework root with an agent directory so
  // agentExistsInFramework() can find TEST_AGENT.
  frameworkRoot = mkdtempSync(join(tmpdir(), 'bus-crons-fw-'));
  mkdirSync(join(frameworkRoot, 'orgs', 'lifeos', 'agents', TEST_AGENT), { recursive: true });

  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_INSTANCE_ID = 'default';
});

afterEach(() => {
  // Restore env vars
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;

  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;

  if (originalAgentName !== undefined) process.env.CTX_AGENT_NAME = originalAgentName;
  else delete process.env.CTX_AGENT_NAME;

  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
  else delete process.env.CTX_INSTANCE_ID;

  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }

  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import the bus command ONCE (singleton — cannot re-import per-test).
// The CTX_ROOT is read at action-call time, not at import time, so the
// per-test env setup above is sufficient.
// ---------------------------------------------------------------------------
import { busCommand } from '../../../src/cli/bus';

// Helper to mock process.exit so it throws instead of terminating the process.
function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

// ---------------------------------------------------------------------------
// add-cron
// ---------------------------------------------------------------------------

describe('bus add-cron', () => {
  it('success: adds a cron with interval schedule', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h',
      'Read HEARTBEAT.md and run heartbeat workflow.',
    ]);

    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(`Added cron 'heartbeat' for ${TEST_AGENT}`);

    const crons = readCronsFile();
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');
    expect(crons[0].schedule).toBe('6h');
    expect(crons[0].prompt).toBe('Read HEARTBEAT.md and run heartbeat workflow.');
    expect(crons[0].enabled).toBe(true);
  });

  it('success: adds a cron with 5-field cron expression', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'morning-briefing', '0 13 * * *',
      'Prepare and send the morning briefing.',
    ]);

    expect(logSpy).toHaveBeenCalledWith(`Added cron 'morning-briefing' for ${TEST_AGENT}`);

    const crons = readCronsFile();
    expect(crons).toHaveLength(1);
    expect(crons[0].schedule).toBe('0 13 * * *');
  });

  it('error: duplicate cron name → exits 1 with message', async () => {
    seedCrons([makeCron('heartbeat')]);

    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync([
        'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h', 'Duplicate cron.',
      ])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('already exists');
  });

  it('error: invalid agent name → exits 1', async () => {
    const exitSpy = mockExit();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync([
        'node', 'bus', 'add-cron', 'BadAgent', 'heartbeat', '6h', 'Some prompt.',
      ])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('error: agent not found in framework → exits 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // 'unknown-agent' has no directory in frameworkRoot
    await expect(
      busCommand.parseAsync([
        'node', 'bus', 'add-cron', 'unknown-agent', 'heartbeat', '6h', 'Some prompt.',
      ])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('not found');
  });

  it('error: invalid interval → exits 1 with helpful message', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync([
        'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', 'every-6-hours', 'Some prompt.',
      ])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('Invalid');
  });
});

// ---------------------------------------------------------------------------
// remove-cron
// ---------------------------------------------------------------------------

describe('bus remove-cron', () => {
  it('success: removes an existing cron', async () => {
    seedCrons([makeCron('heartbeat'), makeCron('morning-briefing')]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'remove-cron', TEST_AGENT, 'heartbeat']);

    expect(logSpy).toHaveBeenCalledWith(`Removed cron 'heartbeat' from ${TEST_AGENT}`);

    const crons = readCronsFile();
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('morning-briefing');
  });

  it('error: cron not found → exits 1', async () => {
    seedCrons([makeCron('heartbeat')]);

    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'remove-cron', TEST_AGENT, 'nonexistent'])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// list-crons
// ---------------------------------------------------------------------------

describe('bus list-crons', () => {
  it('empty state: prints "No crons configured" message', async () => {
    // No crons.json at all
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-crons', TEST_AGENT]);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain(`No crons configured for ${TEST_AGENT}`);
  });

  it('populated: prints table with name, schedule, last_fire, next_fire, prompt', async () => {
    seedCrons([
      makeCron('heartbeat', { last_fired_at: '2026-04-28T12:00:00.000Z' }),
      makeCron('morning-briefing', { schedule: '0 13 * * *', prompt: 'Prepare and send the morning briefing to James.' }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-crons', TEST_AGENT]);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('heartbeat');
    expect(output).toContain('morning-briefing');
    expect(output).toContain('6h');
    expect(output).toContain('0 13 * * *');
  });

  it('json flag: emits raw JSON array', async () => {
    seedCrons([makeCron('heartbeat')]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'list-crons', TEST_AGENT, '--json']);

    const rawOutput = logSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(rawOutput);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('heartbeat');
  });
});

// ---------------------------------------------------------------------------
// update-cron
// ---------------------------------------------------------------------------

describe('bus update-cron', () => {
  beforeEach(() => {
    seedCrons([makeCron('heartbeat')]);
  });

  it('updates interval (--interval)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat', '--interval', '12h',
    ]);

    const crons = readCronsFile();
    expect(crons[0].schedule).toBe('12h');
  });

  it('updates schedule via --cron-expr', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat', '--cron-expr', '0 */4 * * *',
    ]);

    const crons = readCronsFile();
    expect(crons[0].schedule).toBe('0 */4 * * *');
  });

  it('updates prompt (--prompt)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat', '--prompt', 'New prompt text.',
    ]);

    const crons = readCronsFile();
    expect(crons[0].prompt).toBe('New prompt text.');
  });

  it('disables a cron (--enabled false)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat', '--enabled', 'false',
    ]);

    const crons = readCronsFile();
    expect(crons[0].enabled).toBe(false);
  });

  it('updates description (--desc)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat', '--desc', 'New description.',
    ]);

    const crons = readCronsFile();
    expect(crons[0].description).toBe('New description.');
  });

  it('error: no options provided → exits 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat'])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('at least one');
  });

  it('error: cron not found → exits 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync([
        'node', 'bus', 'update-cron', TEST_AGENT, 'nonexistent', '--interval', '1h',
      ])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// test-cron-fire
// ---------------------------------------------------------------------------

describe('bus test-cron-fire', () => {
  it('success: sends fire-cron IPC and prints confirmation', async () => {
    seedCrons([makeCron('heartbeat')]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'test-cron-fire', TEST_AGENT, 'heartbeat']);

    expect(logSpy).toHaveBeenCalledWith(`Fired cron 'heartbeat' for ${TEST_AGENT}`);
  });

  it('error: cron not found → exits 1', async () => {
    // No crons.json at all
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'test-cron-fire', TEST_AGENT, 'nonexistent'])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('not found');
  });

  it('error: daemon not running → exits 1', async () => {
    seedCrons([makeCron('heartbeat')]);

    // Override the shared mock to simulate daemon not running for this test only.
    mockIpcIsDaemonRunning.mockResolvedValueOnce(false);

    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'test-cron-fire', TEST_AGENT, 'heartbeat'])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('daemon');
  });
});

// ---------------------------------------------------------------------------
// get-cron-log
// ---------------------------------------------------------------------------

import { writeFileSync } from 'fs';

/** Write a JSONL cron execution log under tmpRoot for the test agent */
function seedExecutionLog(entries: Array<Record<string, unknown>>): void {
  const dir = join(tmpRoot, '.cortextOS', 'state', 'agents', TEST_AGENT);
  mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, 'cron-execution.log'), lines, 'utf-8');
}

function makeLogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: '2026-04-30T10:00:00.000Z',
    cron: 'heartbeat',
    status: 'fired',
    attempt: 1,
    duration_ms: 42,
    error: null,
    ...overrides,
  };
}

describe('bus get-cron-log', () => {
  it('empty state (no log file): prints "No log entries for {agent}"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT]);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain(`No log entries for ${TEST_AGENT}`);
  });

  it('empty state with cron filter: prints "No log entries for cron {name} on {agent}"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT, 'heartbeat']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain(`No log entries for cron 'heartbeat' on ${TEST_AGENT}`);
  });

  it('success: shows table with cron name, status, attempt, duration', async () => {
    seedExecutionLog([
      makeLogEntry({ cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 100 }),
      makeLogEntry({ cron: 'morning-briefing', status: 'retried', attempt: 1, error: 'timeout' }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT]);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('heartbeat');
    expect(output).toContain('morning-briefing');
    expect(output).toContain('fired');
    expect(output).toContain('retried');
  });

  it('filters by cron name', async () => {
    seedExecutionLog([
      makeLogEntry({ cron: 'heartbeat', status: 'fired' }),
      makeLogEntry({ cron: 'morning-briefing', status: 'fired' }),
      makeLogEntry({ cron: 'heartbeat', status: 'fired' }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT, 'heartbeat']);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('heartbeat');
    // Should NOT show morning-briefing table rows (may appear in header/title only)
    const dataLines = output.split('\n').filter(l => l.includes('morning-briefing'));
    expect(dataLines).toHaveLength(0);
  });

  it('--json flag emits raw JSON array', async () => {
    seedExecutionLog([
      makeLogEntry({ cron: 'heartbeat' }),
      makeLogEntry({ cron: 'morning-briefing' }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT, '--json']);

    const rawOutput = logSpy.mock.calls.flat().join('');
    const parsed = JSON.parse(rawOutput);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].cron).toBe('heartbeat');
  });

  it('--limit restricts number of entries shown', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeLogEntry({ cron: `cron-${i}` })
    );
    seedExecutionLog(entries);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT, '--limit', '3']);

    const output = logSpy.mock.calls.flat().join('\n');
    // Last 3 entries: cron-7, cron-8, cron-9
    expect(output).toContain('cron-9');
    expect(output).toContain('cron-8');
    expect(output).toContain('cron-7');
    expect(output).not.toContain('cron-0');
  });

  it('invalid --limit exits 1', async () => {
    const exitSpy = mockExit();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      busCommand.parseAsync(['node', 'bus', 'get-cron-log', TEST_AGENT, '--limit', 'abc'])
    ).rejects.toThrow('__PROCESS_EXIT_1__');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.flat().join(' ');
    expect(errOut).toContain('--limit');
  });
});
