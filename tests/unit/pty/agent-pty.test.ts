import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// A stub node-pty handle injected via spawnFn so spawn() never touches the native addon.
const mockPty = { pid: 7, write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn() };

function newPty(config: any) {
  const pty = new AgentPTY(mockEnv, config);
  (pty as any).spawnFn = () => mockPty;
  return pty;
}

describe('AgentPTY working_directory validation', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('rejects a whitespace-only working_directory', async () => {
    await expect(newPty({ working_directory: '   ' }).spawn('fresh', 'P'))
      .rejects.toThrow(/whitespace-only/);
  });

  it('rejects a nonexistent working_directory (existsSync=false)', async () => {
    await expect(newPty({ working_directory: '/no/such/dir' }).spawn('fresh', 'P'))
      .rejects.toThrow(/does not exist/);
  });

  it('does NOT validate an unset working_directory (falls through to agentDir)', async () => {
    const pty = newPty({});
    await expect(pty.spawn('fresh', 'P')).resolves.toBeUndefined();
    pty.kill();
  });

  it('does NOT reject the empty-string "unset" sentinel', async () => {
    const pty = newPty({ working_directory: '' });
    await expect(pty.spawn('fresh', 'P')).resolves.toBeUndefined();
    pty.kill();
  });
});

describe('AgentPTY first-run wedge detection (awaiting interactive confirmation)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('flags awaiting when a bypass prompt is still showing at the backstop and not bootstrapped', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    // Capital-P "Permissions" is NOT the lowercase "permissions" bootstrap token.
    pty.getOutputBuffer().push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });

  it('never flags once the session has bootstrapped', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('accept edits · permissions');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });

  it('clears the wedge flag on late recovery (bootstrap after the backstop)', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
    pty.getOutputBuffer().push('permissions');
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });
});

describe('AgentPTY broadened auto-accept token match (rec B)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('injects Down+Enter for a "directory" trust-prompt variant', async () => {
    // The trust screen's default selection is "No, exit" (the same "No"-first
    // ordering as the bypass screen), so a bare Enter QUITS the agent — exit 1 on
    // every spawn. The selection must move DOWN to "Yes, I trust this folder" and
    // only then confirm.
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('Do you trust the files in this directory?');
    await vi.advanceTimersByTimeAsync(1300);
    expect(mockPty.write).toHaveBeenCalledWith('\x1b[B');
    await vi.advanceTimersByTimeAsync(400);
    expect(mockPty.write).toHaveBeenCalledWith('\r');
  });

  it('injects Down+Enter for a lowercase "bypass" prompt variant', async () => {
    // Fixture avoids the lowercase "permissions" bootstrap token so the poll's
    // top-of-tick bootstrap self-stop does not fire before the bypass branch.
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('bypass mode ... 2. Yes, I accept');
    await vi.advanceTimersByTimeAsync(1700);
    expect(mockPty.write).toHaveBeenCalledWith('\x1b[B');
  });

  it('does NOT inject on benign single-token output', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('please accept the changes and open the directory');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});

describe('AgentPTY credit-metered model modal (renders POST-bootstrap)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // A credit-metered model (e.g. Fable 5.1 on a Claude Pro plan) only raises its
  // confirmation modal on the session's FIRST model call — by which point the
  // status bar (containing "permissions") has already bootstrapped the session and
  // the first-run poll has self-stopped. So this modal needs its own watcher that
  // deliberately runs past bootstrap; the fixtures below all include "permissions".
  it('injects Down+Enter to KEEP the configured model, after bootstrap', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('permissions');
    pty.getOutputBuffer().push(
      'Fable 5.1 now uses usage credits. Switch to Sonnet 5 and continue / ' +
      'Continue with Fable 5.1. Enter to confirm',
    );
    await vi.advanceTimersByTimeAsync(1300);
    // Default is "Switch to <other model> and continue" — taking it would silently
    // run the agent on a different model than config.json specifies.
    expect(mockPty.write).toHaveBeenCalledWith('\x1b[B');
    await vi.advanceTimersByTimeAsync(400);
    expect(mockPty.write).toHaveBeenCalledWith('\r');
  });

  it('does NOT inject when only SOME of the modal tokens are present', async () => {
    // Three of the four tokens (credits/Switch/Continue) but no "confirm" footer:
    // live agent prose must never trigger a keystroke into a running session.
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('permissions');
    pty.getOutputBuffer().push('Continue with the credits report, then Switch the branch');
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });

  it('injects at most once even while the modal text lingers in the buffer', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('permissions');
    pty.getOutputBuffer().push('usage credits Switch Continue confirm');
    await vi.advanceTimersByTimeAsync(10000);
    const downs = mockPty.write.mock.calls.filter((c: unknown[]) => c[0] === '\x1b[B');
    expect(downs).toHaveLength(1);
  });
});

describe('AgentPTY structural no-keystroke-into-live-session invariant', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('writes NO keystroke once bootstrapped even if prompt tokens linger in the buffer', async () => {
    // The real session is up ("permissions" status bar) but the recent buffer
    // still carries first-run prompt tokens. The poll must self-stop at the top
    // of the tick BEFORE any bypass/trust branch, so no stray Down/Enter leaks
    // into the live session. Fails against the old ordering (branches first).
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('Bypass Permissions ... 2. Yes, I accept · permissions');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});
