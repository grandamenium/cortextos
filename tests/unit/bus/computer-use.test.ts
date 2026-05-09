/**
 * Unit tests for src/bus/computer-use.ts — fallback chain logic.
 *
 * Tests the SSH → localhost Codex CLI fallback added in feat/codex-fallback-chain:
 * - SSH connection-error pattern detection
 * - Fail-fast on computer-use tasks when Mac offline (noPlugin=false)
 * - Transparent fallback for code-only tasks (noPlugin=true)
 * - Kill switch (noFallback=true)
 * - Successful SSH path (no fallback triggered)
 * - Local codex exec JSON parse + non-zero exit code
 * - usedFallback field on result
 * - Logging (log-event calls for ssh_failure + fallback)
 *
 * Strategy: vi.mock('child_process') to intercept execFileSync without spawning
 * real SSH or codex processes. vi.resetAllMocks() between tests to prevent
 * mockReturnValueOnce bleed across tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { computerUse } from '../../../src/bus/computer-use';

const mockExecFileSync = execFileSync as unknown as Mock;

// Proper SSH connection-error messages (full format that matches regex patterns)
const SSH_CONNECTION_ERRORS = [
  'ssh: connect to host gregs-mac port 22: Connection refused',
  'ssh: connect to host gregs-mac port 22: No route to host',
  'ssh: connect to host gregs-mac port 22: Network is unreachable',
  'ssh: connect to host gregs-mac port 22: Operation timed out',
  'ConnectTimeout: connection timed out',
  'Connection timed out after 10 seconds',
  'No such host: gregs-mac',
  'Temporary failure in name resolution',
  'EHOSTUNREACH: Host unreachable',
  'ECONNREFUSED: Connection refused',
  'ssh_exchange_identification: Connection closed by remote host',
  'kex_exchange_identification: Connection closed by remote host',
];

// SSH non-connection errors — should NOT trigger fallback
const SSH_TASK_ERRORS = [
  'Permission denied (publickey)',
  'Process exited with code 1',
];

// Helper: set up a connection-error SSH throw + consume the log-event call
function mockSshConnectionError(errorMsg: string) {
  mockExecFileSync
    .mockImplementationOnce(() => { throw new Error(errorMsg); }) // SSH
    .mockReturnValueOnce(''); // log-event (ssh_failure) — fire-and-forget
}

describe('computerUse — SSH success path', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.AGENT_BUS_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.AGENT_BUS_SECRET;
  });

  it('returns ok result when SSH succeeds', async () => {
    mockExecFileSync.mockReturnValueOnce('Task complete: wrote 42 lines\n');

    const result = await computerUse('summarize /tmp/file.txt', { noPlugin: true });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('Task complete: wrote 42 lines');
    expect(result.usedFallback).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes ssh host, ConnectTimeout, and keepalive args', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    await computerUse('do something', { noPlugin: true, sshHost: 'custom-mac' });

    const [cmd, args] = mockExecFileSync.mock.calls[0];
    expect(cmd).toBe('ssh');
    expect(args).toContain('custom-mac');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('ServerAliveInterval=30');
    expect(args).toContain('ServerAliveCountMax=2');
    // TOFU host key checking (not =no)
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).not.toContain('StrictHostKeyChecking=no');
  });

  it('passes --workdir flag to dispatch script (embedded in command string)', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    await computerUse('build', { noPlugin: true, workdir: '/tmp/project' });

    // The remote command is a single string — the last element of the args array.
    const [, args] = mockExecFileSync.mock.calls[0];
    const remoteCmd = args[args.length - 1] as string;
    expect(remoteCmd).toContain('--workdir');
    expect(remoteCmd).toContain('/tmp/project');
  });

  it('passes --no-plugin when noPlugin=true (embedded in command string)', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    await computerUse('code task', { noPlugin: true });

    const [, args] = mockExecFileSync.mock.calls[0];
    const remoteCmd = args[args.length - 1] as string;
    expect(remoteCmd).toContain('--no-plugin');
  });

  it('omits --no-plugin when noPlugin is false/default', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    await computerUse('screenshot task');

    const [, args] = mockExecFileSync.mock.calls[0];
    const remoteCmd = args[args.length - 1] as string;
    expect(remoteCmd).not.toContain('--no-plugin');
  });

  it('does not fire log-event when SSH succeeds', async () => {
    mockExecFileSync.mockReturnValueOnce('success\n');

    await computerUse('task', { noPlugin: true });

    // Only the SSH call — no log-event
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('computerUse — SSH task-level failure (no fallback)', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(SSH_TASK_ERRORS)(
    'propagates task error without fallback: %s',
    async (errorMsg) => {
      mockExecFileSync.mockImplementationOnce(() => { throw new Error(errorMsg); });

      const result = await computerUse('some task', { noPlugin: true });

      expect(result.ok).toBe(false);
      expect(result.error).toContain(errorMsg);
      // Only the SSH call — task errors don't trigger log-event or fallback
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    },
  );
});

describe('computerUse — SSH connection failure, computer-use task (noPlugin=false)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.AGENT_BUS_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.AGENT_BUS_SECRET;
  });

  it.each(SSH_CONNECTION_ERRORS)(
    'fails fast with clear error (no local fallback): %s',
    async (errorMsg) => {
      mockSshConnectionError(errorMsg); // SSH throw + log-event mock

      const result = await computerUse('take a screenshot', { noPlugin: false });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Mac SSH unreachable.*computer-use tasks require Mac display session/i);
      expect(result.usedFallback).toBe(false);
      // No codex exec — only SSH + log-event calls
      const codexCalls = mockExecFileSync.mock.calls.filter(([cmd]) => cmd === 'codex');
      expect(codexCalls).toHaveLength(0);
    },
  );

  it('fails fast when noPlugin is omitted (defaults to computer-use mode)', async () => {
    mockSshConnectionError('ConnectTimeout: connection timed out');

    const result = await computerUse('move the mouse');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/computer-use tasks require Mac display session/i);
    const codexCalls = mockExecFileSync.mock.calls.filter(([cmd]) => cmd === 'codex');
    expect(codexCalls).toHaveLength(0);
  });
});

describe('computerUse — SSH connection failure, code-only task (noPlugin=true)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.AGENT_BUS_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.AGENT_BUS_SECRET;
  });

  it('falls back to local codex exec and returns ok result', async () => {
    mockSshConnectionError('ConnectTimeout: connection timed out');
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ message: 'Refactored 3 functions', exit_code: 0 })) // codex exec
      .mockReturnValueOnce(''); // fallback log-event

    const result = await computerUse('refactor utils.ts', { noPlugin: true });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('Refactored 3 functions');
    expect(result.usedFallback).toBe(true);
  });

  it('passes workdir as cwd to local codex exec', async () => {
    mockSshConnectionError('EHOSTUNREACH: Host unreachable');
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ message: 'done', exit_code: 0 }))
      .mockReturnValueOnce(''); // fallback log-event

    await computerUse('build project', { noPlugin: true, workdir: '/tmp/repo' });

    const codexCall = mockExecFileSync.mock.calls.find(([cmd]) => cmd === 'codex');
    expect(codexCall).toBeDefined();
    const [, codexArgs, codexOpts] = codexCall!;
    expect(codexArgs).toContain('exec');
    expect(codexArgs).toContain('--json');
    expect(codexOpts?.cwd).toBe('/tmp/repo');
  });

  it('returns ok=false when local codex exec exits non-zero', async () => {
    mockSshConnectionError('ssh: connect to host gregs-mac port 22: No route to host');
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify({ message: 'compilation failed', exit_code: 1 }));
    // No fallback log-event since it's a failure

    const result = await computerUse('compile', { noPlugin: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 1/);
    expect(result.usedFallback).toBe(true);
  });

  it('handles non-JSON output from codex exec gracefully', async () => {
    mockSshConnectionError('Connection timed out after 10 seconds');
    mockExecFileSync
      .mockReturnValueOnce('plain text output from codex') // codex exec — non-JSON
      .mockReturnValueOnce(''); // fallback log-event

    const result = await computerUse('run script', { noPlugin: true });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('plain text output from codex');
    expect(result.usedFallback).toBe(true);
  });

  it('returns ok=false when local codex exec also throws', async () => {
    mockSshConnectionError('ConnectTimeout: connection timed out');
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('codex: command not found'); });

    const result = await computerUse('run task', { noPlugin: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/localhost codex exec also failed/i);
    expect(result.usedFallback).toBe(true);
  });
});

describe('computerUse — noFallback opt-out', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.AGENT_BUS_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.AGENT_BUS_SECRET;
  });

  it('skips fallback when noFallback=true even for code-only tasks', async () => {
    mockSshConnectionError('ConnectTimeout: connection timed out');

    const result = await computerUse('run task', { noPlugin: true, noFallback: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fallback disabled/i);
    expect(result.usedFallback).toBe(false);
    const codexCalls = mockExecFileSync.mock.calls.filter(([cmd]) => cmd === 'codex');
    expect(codexCalls).toHaveLength(0);
  });
});

describe('computerUse — logging behavior', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_RGOS_URL = 'https://test.supabase.co';
    process.env.AGENT_BUS_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.SUPABASE_RGOS_URL;
    delete process.env.AGENT_BUS_SECRET;
  });

  it('fires computer_use_ssh_failure warn log on connection error', async () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('EHOSTUNREACH: Host unreachable'); })
      .mockReturnValueOnce('') // log-event (ssh_failure)
      .mockReturnValueOnce(JSON.stringify({ message: 'ok', exit_code: 0 })) // codex exec
      .mockReturnValueOnce(''); // log-event (fallback)

    await computerUse('task', { noPlugin: true });

    const logCall = mockExecFileSync.mock.calls.find(
      ([cmd, args]) => cmd === 'cortextos' && Array.isArray(args) && args.includes('computer_use_ssh_failure'),
    );
    expect(logCall).toBeDefined();
    const [, logArgs] = logCall!;
    expect(logArgs).toContain('warn');
  });

  it('fires computer_use_fallback info log on successful fallback', async () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('No such host: gregs-mac'); })
      .mockReturnValueOnce('') // log-event (ssh_failure)
      .mockReturnValueOnce(JSON.stringify({ message: 'done', exit_code: 0 })) // codex exec
      .mockReturnValueOnce(''); // log-event (fallback info)

    await computerUse('task', { noPlugin: true });

    const fallbackLog = mockExecFileSync.mock.calls.find(
      ([cmd, args]) => cmd === 'cortextos' && Array.isArray(args) && args.includes('computer_use_fallback'),
    );
    expect(fallbackLog).toBeDefined();
    const [, logArgs] = fallbackLog!;
    expect(logArgs).toContain('info');
  });

  it('does not fire any log-event when SSH succeeds', async () => {
    mockExecFileSync.mockReturnValueOnce('success\n');

    await computerUse('task', { noPlugin: true });

    const cortextosCalls = mockExecFileSync.mock.calls.filter(([cmd]) => cmd === 'cortextos');
    expect(cortextosCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt shell-escaping — regression tests for the curly-brace bug
// (zsh: parse error near }) and related shell metacharacters.
// ---------------------------------------------------------------------------

describe('computerUse — prompt shell escaping (base64 encoding)', () => {
  beforeEach(() => vi.resetAllMocks());

  /**
   * The remote command must encode the prompt as base64 so the remote shell
   * never interprets the prompt content. We verify by:
   *   1. Capturing the remote command string (last SSH arg)
   *   2. Extracting the base64 token from printf '%s' <TOKEN>
   *   3. Decoding it and asserting it equals the original prompt
   */
  function extractDecodedPrompt(remoteCmd: string): string {
    // The pattern is: "$(printf '%s' <BASE64> | base64 -d)"
    const match = remoteCmd.match(/printf '%s' ([A-Za-z0-9+/=]+)/);
    if (!match) throw new Error(`No base64 token found in: ${remoteCmd}`);
    return Buffer.from(match[1], 'base64').toString('utf-8');
  }

  const METACHAR_PROMPTS = [
    ['curly braces',    'do something with { type: object, properties: {} }'],
    ['single quotes',   "it's a prompt with 'quoted text'"],
    ['double quotes',   'say "hello world" and exit'],
    ['dollar variable', 'echo $HOME and $PATH and ${USER}'],
    ['backticks',       'run `ls -la` and show me the output'],
    ['semicolons',      'do A; then do B; finally C'],
    ['pipe + redirect', 'cat /etc/passwd | grep root > /tmp/out.txt'],
    ['newlines',        'line one\nline two\nline three'],
    ['mixed',           'deploy { env: "prod" } with $TOKEN and `git rev-parse HEAD`'],
  ] as const;

  it.each(METACHAR_PROMPTS)(
    'safely encodes prompt containing %s',
    async (_label, prompt) => {
      mockExecFileSync.mockReturnValueOnce('done\n');

      await computerUse(prompt, { noPlugin: true });

      const [cmd, args] = mockExecFileSync.mock.calls[0];
      expect(cmd).toBe('ssh');

      const remoteCmd = args[args.length - 1] as string;
      // The raw prompt must NOT appear literally in the remote command
      // (if it did, the remote shell would interpret the metacharacters)
      expect(remoteCmd).not.toContain('{');
      expect(remoteCmd).not.toContain('}');

      // The decoded prompt must round-trip exactly
      const decoded = extractDecodedPrompt(remoteCmd);
      expect(decoded).toBe(prompt);
    },
  );

  it('embeds the base64-decoded prompt via printf + base64 -d in the command string', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    const prompt = 'analyze { type: "object", properties: { id: { type: "string" } } }';
    await computerUse(prompt, { noPlugin: true });

    const [, args] = mockExecFileSync.mock.calls[0];
    const remoteCmd = args[args.length - 1] as string;

    // Must use printf + base64 -d (not echo, which adds a newline)
    expect(remoteCmd).toMatch(/printf '%s'.*\| base64 -d/);

    // base64 string must only contain safe characters
    const b64Match = remoteCmd.match(/printf '%s' ([A-Za-z0-9+/=]+)/);
    expect(b64Match).not.toBeNull();
    expect(b64Match![1]).toMatch(/^[A-Za-z0-9+/=]+$/);

    // Decoded value must match original prompt exactly
    const decoded = Buffer.from(b64Match![1], 'base64').toString('utf-8');
    expect(decoded).toBe(prompt);
  });

  it('does not regress: plain ASCII prompts also round-trip correctly', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    const prompt = 'summarize the changes in the last 5 commits';
    await computerUse(prompt, { noPlugin: true });

    const [, args] = mockExecFileSync.mock.calls[0];
    const remoteCmd = args[args.length - 1] as string;
    const decoded = extractDecodedPrompt(remoteCmd);
    expect(decoded).toBe(prompt);
  });

  it('sets maxBuffer=10MB on the SSH execFileSync call', async () => {
    mockExecFileSync.mockReturnValueOnce('done\n');

    await computerUse('task', { noPlugin: true });

    const [, , opts] = mockExecFileSync.mock.calls[0];
    expect(opts?.maxBuffer).toBe(10 * 1024 * 1024);
  });

  it('sets maxBuffer=10MB on the local codex exec fallback call', async () => {
    mockExecFileSync
      .mockImplementationOnce(() => { throw new Error('ConnectTimeout: timed out'); })
      .mockReturnValueOnce('')  // log-event
      .mockReturnValueOnce(JSON.stringify({ message: 'done', exit_code: 0 })) // codex
      .mockReturnValueOnce(''); // fallback log-event

    await computerUse('task', { noPlugin: true });

    const codexCall = mockExecFileSync.mock.calls.find(([cmd]) => cmd === 'codex');
    expect(codexCall).toBeDefined();
    const [, , codexOpts] = codexCall!;
    expect(codexOpts?.maxBuffer).toBe(10 * 1024 * 1024);
  });
});
