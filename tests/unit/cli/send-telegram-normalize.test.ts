/**
 * PR-12 regression: `cortextos bus send-telegram` must normalize literal
 * `\n` / `\t` (2-char escape sequences) into real newlines / tabs before
 * passing the message to the Telegram API and before logging it to the
 * outbound-messages.jsonl trail.
 *
 * Bug context: codex-app-server agents emit shell commands like
 *   cortextos bus send-telegram CHATID 'hello\n\nworld'
 * where the `\n` is inside a single-quoted bash string. Bash does NOT expand
 * escapes inside single quotes, so the CLI receives the literal 2-char
 * sequence `\n` in argv. Without normalization, Telegram renders the literal
 * backslash-n as visible text instead of a newline, which is what James saw
 * in the codex-research onboarding messages on 2026-05-08.
 *
 * Claude-runtime agents already use real newlines (their training favors
 * HEREDOC / multi-line strings), so the normalize is a no-op for them — the
 * fix is runtime-agnostic by construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Capture every sendMessage call so the test can assert on the second positional
// arg (the message text) after normalization.
const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'pr12-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'pr12-cwd-'));

  // logOutboundMessage writes under ctxRoot/logs/<agent>/. Provide both
  // so the action's bookkeeping does not throw and trip the outer catch.
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.chdir(tempCwd);

  sendMessageSpy.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;
  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;
  if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = originalBotToken;
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('PR-12: send-telegram normalizes literal \\n / \\t (codex agent fix)', () => {
  it('converts codex-style literal \\n into real newlines before sending', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345','hello\\n\\nworld'],
      { from: 'user' },
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('hello\n\nworld');
    // Sanity: no literal backslash-n survives.
    expect(sentMessage).not.toContain('\\n');
  });

  it('converts codex-style literal \\t into real tabs before sending', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345','col1\\tcol2'],
      { from: 'user' },
    );

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('col1\tcol2');
    expect(sentMessage).not.toContain('\\t');
  });

  it('leaves real newlines untouched (claude-runtime no-op)', async () => {
    // When the agent uses HEREDOC or multi-line strings, argv already contains
    // real newlines — the normalize must NOT double-process them.
    await busCommand.parseAsync(
      ['send-telegram', '12345','line1\nline2'],
      { from: 'user' },
    );

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('line1\nline2');
  });

  it('preserves other escape sequences verbatim (e.g. \\r, \\xHH)', async () => {
    // The patch is intentionally narrow — only \n and \t are converted.
    // Other less-common sequences pass through so we do not surprise users
    // who legitimately want literal backslash-r in a message.
    await busCommand.parseAsync(
      ['send-telegram', '12345','has\\rcarriage'],
      { from: 'user' },
    );

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('has\\rcarriage');
  });

  it('handles mixed literal \\n and real \\n in the same message', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345','real\nthen\\nliteral'],
      { from: 'user' },
    );

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toBe('real\nthen\nliteral');
  });

  it('normalizes the exact pattern observed in codex-research outbound log', async () => {
    // Verbatim shape from /Users/cortextos/.cortextos/default/logs/codex-research/
    // outbound-messages.jsonl (2026-05-08 16:48Z) — proves the patch covers the
    // production-observed bug.
    const codexShape = "Hey James! I'm codex-research.\\n\\nA few quick questions";
    await busCommand.parseAsync(
      ['send-telegram', '12345',codexShape],
      { from: 'user' },
    );

    const sentMessage = sendMessageSpy.mock.calls[0][1] as string;
    expect(sentMessage).toContain('codex-research.\n\nA few quick questions');
    expect(sentMessage).not.toContain('\\n');
  });
});
