/**
 * Unit tests for `cortextos provision-orgo`.
 *
 * All HTTP calls are mocked via vi.stubGlobal('fetch', ...).
 * No real Orgo API calls are made.
 *
 * Implementation note: runInstaller uses a background+poll approach because
 * Orgo /exec has a ~30s hard HTTP timeout. The sequence per install is:
 *   1. (optional) GitHub API fetch to resolve release asset ID (only if GH_TOKEN set)
 *   2. POST /exec — launch installer as background Popen, returns { pid }
 *   3. POST /exec (×N) — poll until { still_running: false, exit_code }
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { provisionOrgoCommand, resolveInstallScriptPath } from '../../../src/cli/provision-orgo';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Silence console output during tests
function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

// Capture process.exit without actually exiting
function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__EXIT_${code}__`);
  }) as never);
}

// Launch response: background Popen started, returns PID
function launchSuccess(pid = 1234) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      output: JSON.stringify({ pid, status: 'launched' }),
      timeout: false,
      error: null,
    }),
    text: async () => '',
  };
}

// Poll response: installer finished
function pollDone(exitCode = 0, logTail = '[provision] Install complete.') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      output: JSON.stringify({ still_running: false, exit_code: exitCode, log_tail: logTail }),
      timeout: false,
      error: null,
    }),
    text: async () => '',
  };
}

// Poll response: still running
function pollRunning(logTail = '[provision] Installing cortextos...') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      output: JSON.stringify({ still_running: true, exit_code: -99, log_tail: logTail }),
      timeout: false,
      error: null,
    }),
    text: async () => '',
  };
}

// ---------------------------------------------------------------------------
// Tests: option validation
// ---------------------------------------------------------------------------

describe('provision-orgo — install script path resolution', () => {
  it('resolves the built dist layout before falling through to parent directories', () => {
    const root = join(tmpdir(), `ctx-orgo-path-${Date.now()}`);
    const distDir = join(root, 'dist');
    const scriptPath = join(root, 'scripts', 'install-cortextos-on-orgo.sh');

    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(distDir, { recursive: true });
      writeFileSync(scriptPath, '#!/usr/bin/env bash\n');

      expect(resolveInstallScriptPath(distDir, join(root, 'other-cwd'))).toBe(scriptPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the source TypeScript layout', () => {
    const root = join(tmpdir(), `ctx-orgo-source-path-${Date.now()}`);
    const srcCliDir = join(root, 'src', 'cli');
    const scriptPath = join(root, 'scripts', 'install-cortextos-on-orgo.sh');

    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(srcCliDir, { recursive: true });
      writeFileSync(scriptPath, '#!/usr/bin/env bash\n');

      expect(resolveInstallScriptPath(srcCliDir, join(root, 'other-cwd'))).toBe(scriptPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('provision-orgo — option validation', () => {
  let exitSpy: ReturnType<typeof mockExit>;

  beforeEach(() => {
    exitSpy = mockExit();
    silenceConsole();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exits 1 when neither --computer nor --create is provided', async () => {
    await expect(
      provisionOrgoCommand.parseAsync(['node', 'cli', '--api-key', 'test-key'])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when --create is used without --workspace', async () => {
    await expect(
      provisionOrgoCommand.parseAsync(['node', 'cli', '--api-key', 'test-key', '--create'])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when --computer and --create are both provided', async () => {
    await expect(
      provisionOrgoCommand.parseAsync([
        'node', 'cli',
        '--api-key', 'test-key',
        '--computer', 'vm-abc',
        '--create',
        '--workspace', 'ws-1',
      ])
    ).rejects.toThrow('__EXIT_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: existing computer path (--computer)
// ---------------------------------------------------------------------------

describe('provision-orgo — existing computer path (--computer)', () => {
  let exitSpy: ReturnType<typeof mockExit>;

  beforeEach(() => {
    exitSpy = mockExit();
    silenceConsole();
    vi.useFakeTimers();
    // Ensure GH_TOKEN is unset so GitHub API fetch is skipped in tests
    delete process.env['GH_TOKEN'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('runs the installer and exits 0 on success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(launchSuccess())   // POST /exec (launch)
      .mockResolvedValueOnce(pollDone());        // POST /exec (poll — done)

    vi.stubGlobal('fetch', fetchMock);

    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key-abc',
      '--computer', 'vm-xyz',
      '--agent-name', 'dev',
    ]);

    // Advance past the 15s poll interval
    await vi.runAllTimersAsync();
    await parsePromise;

    // launch + 1 poll = 2 calls (no GitHub API since GH_TOKEN unset)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [launchUrl, launchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(launchUrl).toContain('computers/vm-xyz/exec');
    expect((launchInit.headers as Record<string, string>)['Authorization']).toBe('Bearer orgo-key-abc');

    const [pollUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toContain('computers/vm-xyz/exec');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when the installer exits non-zero', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(launchSuccess())
      .mockResolvedValueOnce(pollDone(1, 'npm error: something failed'));

    vi.stubGlobal('fetch', fetchMock);

    // Attach .catch() immediately so the rejection is always handled,
    // even if it fires during vi.runAllTimersAsync() before the assertion.
    let caughtError: Error | undefined;
    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key-abc',
      '--computer', 'vm-xyz',
    ]).catch((e: Error) => { caughtError = e; });

    await vi.runAllTimersAsync();
    await parsePromise;
    expect(caughtError?.message).toMatch(/__EXIT_1__/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 on Orgo API HTTP error during launch', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
      text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    let caughtError: Error | undefined;
    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'bad-key',
      '--computer', 'vm-xyz',
    ]).catch((e: Error) => { caughtError = e; });

    await vi.runAllTimersAsync();
    await parsePromise;
    expect(caughtError?.message).toMatch(/__EXIT_1__/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('polls multiple times while installer is still running', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(launchSuccess())
      .mockResolvedValueOnce(pollRunning())   // still running
      .mockResolvedValueOnce(pollRunning())   // still running
      .mockResolvedValueOnce(pollDone());     // done

    vi.stubGlobal('fetch', fetchMock);

    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key-abc',
      '--computer', 'vm-xyz',
    ]);

    await vi.runAllTimersAsync();
    await parsePromise;

    // 1 launch + 3 polls
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: create new computer path (--create)
// ---------------------------------------------------------------------------

describe('provision-orgo — create new computer path (--create)', () => {
  let exitSpy: ReturnType<typeof mockExit>;

  beforeEach(() => {
    exitSpy = mockExit();
    silenceConsole();
    vi.useFakeTimers();
    delete process.env['GH_TOKEN'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves workspace by name and creates computer, then installs', async () => {
    const fetchMock = vi.fn()
      // GET /api/projects
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          projects: [{ id: 'ws-001', name: 'RevOps Global', desktops: [] }],
        }),
        text: async () => '',
      })
      // POST /api/computers
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'vm-new-001', name: 'dev-agent-vm', status: 'creating' }),
        text: async () => '',
      })
      // POST /api/computers/vm-new-001/exec (launch)
      .mockResolvedValueOnce(launchSuccess())
      // POST /api/computers/vm-new-001/exec (poll)
      .mockResolvedValueOnce(pollDone());

    vi.stubGlobal('fetch', fetchMock);

    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key',
      '--workspace', 'RevOps Global',
      '--create', 'dev-agent-vm',
      '--agent-name', 'dev',
    ]);

    // Advance past the 15s VM boot wait + 15s poll interval
    await vi.runAllTimersAsync();
    await parsePromise;

    // 4 calls: projects, create, launch, poll
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [projectsUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(projectsUrl).toContain('projects');

    const [computersUrl, computersInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(computersUrl).toContain('computers');
    const createBody = JSON.parse(computersInit.body as string);
    expect(createBody.workspace_id).toBe('ws-001');
    expect(createBody.name).toBe('dev-agent-vm');

    const [execUrl] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(execUrl).toContain('computers/vm-new-001/exec');

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when workspace is not found', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ projects: [{ id: 'ws-001', name: 'Other Workspace', desktops: [] }] }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    let caughtError: Error | undefined;
    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'orgo-key',
      '--workspace', 'Nonexistent Workspace',
      '--create',
      '--agent-name', 'dev',
    ]).catch((e: Error) => { caughtError = e; });

    await vi.runAllTimersAsync();
    await parsePromise;
    expect(caughtError?.message).toMatch(/__EXIT_1__/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Python exec payload structure (launch phase)
// ---------------------------------------------------------------------------

describe('provision-orgo — Python exec payload structure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env['GH_TOKEN'];
    silenceConsole();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('launch payload embeds base64-encoded bash source and uses Popen', async () => {
    const exitSpy = mockExit();
    let capturedLaunchBody: { code: string; timeout: number } | null = null;

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (!capturedLaunchBody) {
        // First exec call = launch
        capturedLaunchBody = JSON.parse(init.body as string) as { code: string; timeout: number };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            output: JSON.stringify({ pid: 9999, status: 'launched' }),
            timeout: false,
            error: null,
          }),
          text: async () => '',
        };
      }
      // Subsequent calls = poll
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          output: JSON.stringify({ still_running: false, exit_code: 0, log_tail: 'ok' }),
          timeout: false,
          error: null,
        }),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'key',
      '--computer', 'vm-1',
    ]);

    await vi.runAllTimersAsync();
    await parsePromise;

    expect(capturedLaunchBody).not.toBeNull();
    // Launch code uses Popen (not subprocess.run) for background execution
    expect(capturedLaunchBody!.code).toContain('import base64');
    expect(capturedLaunchBody!.code).toContain('subprocess.Popen');
    // Launch uses a short timeout (not 265s — that was the old synchronous approach)
    expect(capturedLaunchBody!.timeout).toBeLessThanOrEqual(25);

    void exitSpy;
  });

  it('poll payload checks PID and reads log file', async () => {
    const exitSpy = mockExit();
    let callCount = 0;
    let capturedPollBody: { code: string; timeout: number } | null = null;

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // Launch
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            output: JSON.stringify({ pid: 5678, status: 'launched' }),
            timeout: false,
            error: null,
          }),
          text: async () => '',
        };
      }
      // Poll
      capturedPollBody = JSON.parse(init.body as string) as { code: string; timeout: number };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          output: JSON.stringify({ still_running: false, exit_code: 0, log_tail: 'done' }),
          timeout: false,
          error: null,
        }),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const parsePromise = provisionOrgoCommand.parseAsync([
      'node', 'cli',
      '--api-key', 'key',
      '--computer', 'vm-1',
    ]);

    await vi.runAllTimersAsync();
    await parsePromise;

    expect(capturedPollBody).not.toBeNull();
    expect(capturedPollBody!.code).toContain('5678');     // PID embedded in poll code
    expect(capturedPollBody!.code).toContain('ctx-install.log'); // reads log file
    expect(capturedPollBody!.code).toContain('still_running');

    void exitSpy;
  });
});
