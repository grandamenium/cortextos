/**
 * Voice-default behavior for `cortextos bus send-telegram`.
 *
 * When the agent has a voice configured in config.json AND the target
 * chat_id matches $CTX_TELEGRAM_CHAT_ID AND no explicit --voice flag was
 * passed AND the CORTEXTOS_VOICE_DEFAULT kill switch is NOT set to "off",
 * the CLI auto-passes the message body as the voice content.
 *
 * Rationale: agents triggered from daemon-side processes (crons, codex
 * callbacks) cannot easily opt in to --voice through middleware, but
 * they should still deliver voice when their config says they speak.
 * This makes voice the default for any agent whose config.json carries
 * voice/voice_model/voice_speed.
 *
 * Agent-to-agent bus messages and any send to a chat OTHER than
 * $CTX_TELEGRAM_CHAT_ID stay text-only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';

const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 100 } });
const sendVoiceSpy = vi.fn().mockResolvedValue({ result: { message_id: 99 } });

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) { return sendMessageSpy(...args); }
    sendVoice(...args: unknown[]) { return sendVoiceSpy(...args); }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

const synthesizeVoiceSpy = vi.fn().mockResolvedValue(
  Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0, 0]),
);
vi.mock('../../../src/telegram/tts.js', () => ({
  synthesizeVoice: (...args: unknown[]) => synthesizeVoiceSpy(...args),
}));

import { busCommand } from '../../../src/cli/bus';

const USER_CHAT_ID = '6228364860';
const OTHER_AGENT_CHAT_ID = '7777777777';

let tempCtx: string;
let tempProjectRoot: string;
let originalEnv: Record<string, string | undefined>;
let originalCwd: string;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'voice-default-ctx-'));
  tempProjectRoot = mkdtempSync(join(tmpdir(), 'voice-default-fw-'));

  const agentDir = join(tempProjectRoot, 'orgs', 'test-org', 'agents', 'sage');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'sage', voice: 'cedar', voice_model: 'gpt-4o-mini-tts' }),
  );

  mkdirSync(join(tempCtx, 'logs', 'sage'), { recursive: true });

  originalEnv = {
    CTX_ROOT: process.env.CTX_ROOT,
    CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
    CTX_AGENT_DIR: process.env.CTX_AGENT_DIR,
    CTX_PROJECT_ROOT: process.env.CTX_PROJECT_ROOT,
    CTX_FRAMEWORK_ROOT: process.env.CTX_FRAMEWORK_ROOT,
    CTX_ORG: process.env.CTX_ORG,
    CTX_TELEGRAM_CHAT_ID: process.env.CTX_TELEGRAM_CHAT_ID,
    BOT_TOKEN: process.env.BOT_TOKEN,
    CORTEXTOS_VOICE_DEFAULT: process.env.CORTEXTOS_VOICE_DEFAULT,
  };
  originalCwd = process.cwd();

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'sage';
  process.env.CTX_AGENT_DIR = agentDir;
  process.env.CTX_PROJECT_ROOT = tempProjectRoot;
  process.env.CTX_FRAMEWORK_ROOT = tempProjectRoot;
  process.env.CTX_ORG = 'test-org';
  process.env.CTX_TELEGRAM_CHAT_ID = USER_CHAT_ID;
  process.env.BOT_TOKEN = 'fake-token-for-test';
  delete process.env.CORTEXTOS_VOICE_DEFAULT;
  process.chdir(tempProjectRoot);

  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  sendMessageSpy.mockClear();
  sendVoiceSpy.mockClear();
  synthesizeVoiceSpy.mockClear();
  synthesizeVoiceSpy.mockResolvedValue(
    Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempProjectRoot, { recursive: true, force: true });
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe('voice-default: agent with voice configured + Zach chat', () => {
  it('auto-fills voice with the message body when no --voice flag is passed', async () => {
    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Quick morning check-in.'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).toHaveBeenCalledTimes(1);
    const [text, voice] = synthesizeVoiceSpy.mock.calls[0];
    expect(text).toBe('Quick morning check-in.');
    expect(voice).toBe('cedar'); // from config.json

    expect(sendVoiceSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe('Quick morning check-in.');
  });

  it('explicit --voice overrides voice-default content', async () => {
    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Long body with detail', '--voice', 'TLDR'],
      { from: 'user' },
    );

    const [text] = synthesizeVoiceSpy.mock.calls[0];
    expect(text).toBe('TLDR');
    expect(sendMessageSpy.mock.calls[0][1]).toBe('Long body with detail');
  });

  it('respects normalized literal \\n in body when used as voice content', async () => {
    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Line one\\nLine two'],
      { from: 'user' },
    );

    const [text] = synthesizeVoiceSpy.mock.calls[0];
    expect(text).toBe('Line one\nLine two');
  });
});

describe('voice-default: agent without voice configured', () => {
  it('does not auto-fill voice when agent config has no voice field', async () => {
    const agentDir = process.env.CTX_AGENT_DIR!;
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ agent_name: 'sage' }), // no voice
    );

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Test message'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-fill voice when agent has no config.json at all', async () => {
    const agentDir = process.env.CTX_AGENT_DIR!;
    rmSync(join(agentDir, 'config.json'), { force: true });

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Test message'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
});

describe('voice-default: target chat_id check', () => {
  it('does not fire when target is NOT $CTX_TELEGRAM_CHAT_ID (agent-to-agent)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', OTHER_AGENT_CHAT_ID, 'Inter-agent ping'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('does not fire when $CTX_TELEGRAM_CHAT_ID is unset', async () => {
    delete process.env.CTX_TELEGRAM_CHAT_ID;

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Test message'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('matches even when chat_id has surrounding whitespace', async () => {
    await busCommand.parseAsync(
      ['send-telegram', `  ${USER_CHAT_ID}  `, 'Padded chat id'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).toHaveBeenCalledTimes(1);
  });
});

describe('voice-default: kill switch', () => {
  it('CORTEXTOS_VOICE_DEFAULT=off disables auto-fill', async () => {
    process.env.CORTEXTOS_VOICE_DEFAULT = 'off';

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Should stay text-only'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('kill switch does NOT block explicit --voice (explicit always wins)', async () => {
    process.env.CORTEXTOS_VOICE_DEFAULT = 'off';

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Body', '--voice', 'Explicit summary'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).toHaveBeenCalledTimes(1);
    expect(synthesizeVoiceSpy.mock.calls[0][0]).toBe('Explicit summary');
  });

  it('any value other than "off" leaves the default on', async () => {
    process.env.CORTEXTOS_VOICE_DEFAULT = 'on';

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Should still fire'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).toHaveBeenCalledTimes(1);
  });
});

describe('voice-default: mutex with --image / --file', () => {
  it('does not auto-fill when --image is passed', async () => {
    const imgPath = join(tempCtx, 'fake.png');
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Caption', '--image', imgPath],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
  });

  it('does not auto-fill when --file is passed', async () => {
    const filePath = join(tempCtx, 'fake.pdf');
    writeFileSync(filePath, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Caption', '--file', filePath],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
  });
});

describe('voice-default: fallback safety', () => {
  it('falls back to text-only when synthesizeVoice throws during auto-default', async () => {
    synthesizeVoiceSpy.mockRejectedValueOnce(new Error('OpenAI rate limited'));

    await busCommand.parseAsync(
      ['send-telegram', USER_CHAT_ID, 'Body still goes through'],
      { from: 'user' },
    );

    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe('Body still goes through');
    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errs.some((e) => /voice.*synthesis failed/i.test(e))).toBe(true);
  });
});
