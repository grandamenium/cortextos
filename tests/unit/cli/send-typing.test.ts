/**
 * `cortextos bus send-typing <chat-id> [action]` wraps Telegram's
 * sendChatAction Bot API method. Lets agents fire a typing indicator
 * (or other chat action: record_voice, upload_photo, etc) when they
 * know a response will take more than a couple seconds.
 *
 * Telegram shows the indicator for ~5s automatically; agents on longer
 * turns can re-fire to keep it visible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sendChatActionSpy = vi.fn().mockResolvedValue({ ok: true, result: true });

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendChatAction(...args: unknown[]) { return sendChatActionSpy(...args); }
    sendMessage = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendPhoto = vi.fn();
    sendDocument = vi.fn();
    sendVoice = vi.fn();
    setMessageReaction = vi.fn();
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalEnv: Record<string, string | undefined>;
let originalCwd: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'send-typing-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'send-typing-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalEnv = {
    CTX_ROOT: process.env.CTX_ROOT,
    CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
    BOT_TOKEN: process.env.BOT_TOKEN,
  };
  originalCwd = process.cwd();
  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.chdir(tempCwd);

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  sendChatActionSpy.mockClear();
  sendChatActionSpy.mockResolvedValue({ ok: true, result: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe('cortextos bus send-typing', () => {
  it('fires sendChatAction with the default "typing" action when no action arg is passed', async () => {
    await busCommand.parseAsync(
      ['send-typing', '12345'],
      { from: 'user' },
    );

    expect(sendChatActionSpy).toHaveBeenCalledTimes(1);
    expect(sendChatActionSpy).toHaveBeenCalledWith('12345', 'typing');
  });

  it('passes through a custom action when provided', async () => {
    await busCommand.parseAsync(
      ['send-typing', '12345', 'record_voice'],
      { from: 'user' },
    );

    expect(sendChatActionSpy).toHaveBeenCalledWith('12345', 'record_voice');
  });

  it('logs the action sent on success', async () => {
    await busCommand.parseAsync(
      ['send-typing', '12345', 'upload_photo'],
      { from: 'user' },
    );

    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => /Sent action: upload_photo/.test(l))).toBe(true);
  });

  it('surfaces sendChatAction errors via stderr + non-zero exit intent', async () => {
    sendChatActionSpy.mockRejectedValueOnce(new Error('Telegram API error: chat not found'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    await busCommand.parseAsync(
      ['send-typing', '999999'],
      { from: 'user' },
    );

    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errs.some((e) => /Failed to send chat action/.test(e))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('errors clearly when BOT_TOKEN is not configured', async () => {
    delete process.env.BOT_TOKEN;
    // Throw in the exit mock so execution actually stops at the BOT_TOKEN
    // guard, matching real process.exit behavior. Without this the action
    // handler continues past the check and the test's later assertions
    // observe the WRONG stderr line.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as any);

    await expect(
      busCommand.parseAsync(['send-typing', '12345'], { from: 'user' }),
    ).rejects.toThrow(/__test_exit_1__/);

    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errs.some((e) => /BOT_TOKEN not configured/.test(e))).toBe(true);
    expect(sendChatActionSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
