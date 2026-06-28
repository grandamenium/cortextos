/**
 * SECURITY (task: send-message non-shell input channel) — `cortextos bus
 * send-message` must accept the message body via `--body-file <path>` (and
 * `--stdin`) so untrusted/dynamic content is passed through a NON-SHELL channel.
 *
 * Root cause this closes: agents inline the message into a shell-evaluated
 * `<text>` arg, so backticks / $() / $VAR in the body get command-substituted
 * by the caller's bash BEFORE the CLI ever runs (this is exactly how a
 * backtick-wrapped `env` dumped live creds into a bus message on 2026-06-28).
 * No wrapper/CLI change can stop caller-side shell-eval of an inline arg — the
 * fix is to provide a path/stdin channel whose body is read RAW.
 *
 * These tests assert the body is delivered VERBATIM (shell metacharacters
 * intact, never executed) and that the legacy positional <text> still works.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Capture the text arg (5th positional) handed to the bus message layer.
const sendMessageSpy = vi.fn().mockReturnValue('msg-test-id');
vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageSpy(...args),
  checkInbox: vi.fn(),
  ackInbox: vi.fn(),
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'bodyfile-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'bodyfile-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.chdir(tempCwd);

  sendMessageSpy.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

// The text arg is the 5th positional of sendMessage(paths, from, to, priority, text, replyTo).
const capturedText = () => sendMessageSpy.mock.calls[0][4] as string;

describe('send-message --body-file (non-shell safe channel)', () => {
  it('delivers shell-metachar body VERBATIM (backticks/$() NOT executed)', async () => {
    // This exact body, if inlined into a double-quoted shell arg, would run
    // `env` + the $(...) and splice their output into the message. Via the file
    // channel it must arrive byte-for-byte.
    const dangerous = 'see `env` and $(whoami) and ${HOME} — keep literal';
    const f = join(tempCwd, 'body.txt');
    writeFileSync(f, dangerous);

    await busCommand.parseAsync(
      ['send-message', 'platform-director', 'normal', '--body-file', f],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(capturedText()).toBe(dangerous);
  });

  it('reads the file body RAW including newlines', async () => {
    const body = 'line1\nline2\n`backtick line`';
    const f = join(tempCwd, 'multiline.txt');
    writeFileSync(f, body);

    await busCommand.parseAsync(
      ['send-message', 'platform-director', 'high', '--body-file', f],
      { from: 'user' },
    );

    expect(capturedText()).toBe(body);
  });

  it('still accepts the legacy positional <text> arg (regression)', async () => {
    await busCommand.parseAsync(
      ['send-message', 'platform-director', 'normal', 'plain inline text'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(capturedText()).toBe('plain inline text');
  });
});
