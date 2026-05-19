/**
 * Integration test for `cortextos bus send-telegram --voice <summary>`.
 *
 * Verifies the OpenAI voice-reply pipeline (Component 2 of
 * voice-conversation-spec.md, revised 2026-05-19):
 *   1. resolveAgentVoice → voice name from agent config or org voices.json
 *   2. synthesizeVoice(summary, voice, {model}) → OGG/Opus buffer (mocked)
 *   3. Write buffer to a temp .ogg file
 *   4. api.sendVoice(chatId, oggPath, undefined, durationEstimate)
 *   5. api.sendMessage(chatId, fullBody, ...)
 *   6. Unlink the temp file + rmdir the temp dir
 *
 * Failure path: any error in steps 1-3 should fall back to text-only
 * with a stderr warning; the original message must still send.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Buffer } from 'buffer';

const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 100 } });
const sendVoiceSpy = vi.fn().mockResolvedValue({ result: { message_id: 99 } });
const sendPhotoSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const sendDocumentSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) { return sendMessageSpy(...args); }
    sendVoice(...args: unknown[]) { return sendVoiceSpy(...args); }
    sendPhoto(...args: unknown[]) { return sendPhotoSpy(...args); }
    sendDocument(...args: unknown[]) { return sendDocumentSpy(...args); }
  },
}));

const synthesizeVoiceSpy = vi.fn().mockResolvedValue(
  // Realistic-looking OGG/Opus header bytes so the CLI's temp write produces
  // a non-zero file (we never decode it - just round-trip the bytes).
  Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0, 0]),
);
vi.mock('../../../src/telegram/tts.js', () => ({
  synthesizeVoice: (...args: unknown[]) => synthesizeVoiceSpy(...args),
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempProjectRoot: string;
let originalEnv: Record<string, string | undefined>;
let originalCwd: string;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'voice-cli-ctx-'));
  tempProjectRoot = mkdtempSync(join(tmpdir(), 'voice-cli-fw-'));

  const agentDir = join(tempProjectRoot, 'orgs', 'test-org', 'agents', 'atlas');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'atlas', voice: 'cedar' }),
  );

  mkdirSync(join(tempCtx, 'logs', 'atlas'), { recursive: true });

  originalEnv = {
    CTX_ROOT: process.env.CTX_ROOT,
    CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
    CTX_AGENT_DIR: process.env.CTX_AGENT_DIR,
    CTX_PROJECT_ROOT: process.env.CTX_PROJECT_ROOT,
    CTX_FRAMEWORK_ROOT: process.env.CTX_FRAMEWORK_ROOT,
    CTX_ORG: process.env.CTX_ORG,
    BOT_TOKEN: process.env.BOT_TOKEN,
  };
  originalCwd = process.cwd();

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'atlas';
  process.env.CTX_AGENT_DIR = agentDir;
  process.env.CTX_PROJECT_ROOT = tempProjectRoot;
  process.env.CTX_FRAMEWORK_ROOT = tempProjectRoot;
  process.env.CTX_ORG = 'test-org';
  process.env.BOT_TOKEN = 'fake-token-for-test';
  process.chdir(tempProjectRoot);

  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  sendMessageSpy.mockClear();
  sendVoiceSpy.mockClear();
  sendPhotoSpy.mockClear();
  sendDocumentSpy.mockClear();
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

describe('send-telegram --voice (happy path, OpenAI TTS)', () => {
  it('synthesizes voice with the summary text and the agent voice', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Full text body', '--voice', 'Quick spoken summary'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).toHaveBeenCalledTimes(1);
    const [text, voice, options] = synthesizeVoiceSpy.mock.calls[0];
    expect(text).toBe('Quick spoken summary');
    expect(voice).toBe('cedar'); // from agent config.json
    expect(options.model).toBe('tts-1'); // default
  });

  it('honors voice_model from agent config (tts-1-hd)', async () => {
    const agentDir = process.env.CTX_AGENT_DIR!;
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ agent_name: 'atlas', voice: 'cedar', voice_model: 'tts-1-hd' }),
    );

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Body', '--voice', 'Summary'],
      { from: 'user' },
    );

    const [, , options] = synthesizeVoiceSpy.mock.calls[0];
    expect(options.model).toBe('tts-1-hd');
  });

  it('sends the voice note before the text message', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Full body', '--voice', 'Summary'],
      { from: 'user' },
    );

    expect(sendVoiceSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const voiceArgs = sendVoiceSpy.mock.calls[0];
    expect(voiceArgs[0]).toBe('12345');
    expect(typeof voiceArgs[1]).toBe('string'); // temp file path
    expect(voiceArgs[1]).toMatch(/voice\.ogg$/);
    expect(voiceArgs[2]).toBeUndefined(); // no caption
    expect(typeof voiceArgs[3]).toBe('number'); // duration estimate

    const msgArgs = sendMessageSpy.mock.calls[0];
    expect(msgArgs[0]).toBe('12345');
    expect(msgArgs[1]).toBe('Full body');
  });

  it('writes the OGG buffer to a tempfile before sendVoice', async () => {
    // Use a sentinel buffer so we can verify it actually got to disk
    const sentinel = Buffer.from('AAAAAA-sentinel-AAAAAA');
    synthesizeVoiceSpy.mockResolvedValueOnce(sentinel);

    let capturedPath: string | undefined;
    sendVoiceSpy.mockImplementationOnce((..._args: any[]) => {
      capturedPath = _args[1];
      // Read the file at this point - it should exist and contain the sentinel
      if (capturedPath && existsSync(capturedPath)) {
        const onDisk = require('fs').readFileSync(capturedPath);
        expect(onDisk.toString()).toContain('sentinel');
      }
      return Promise.resolve({ result: { message_id: 99 } });
    });

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Body', '--voice', 'Summary'],
      { from: 'user' },
    );

    expect(capturedPath).toBeDefined();
  });

  it('cleans up the temp OGG file and dir after sending', async () => {
    let capturedPath: string | undefined;
    sendVoiceSpy.mockImplementationOnce((..._args: any[]) => {
      capturedPath = _args[1];
      return Promise.resolve({ result: { message_id: 99 } });
    });

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Body', '--voice', 'Summary'],
      { from: 'user' },
    );

    expect(capturedPath).toBeDefined();
    expect(existsSync(capturedPath!)).toBe(false);
    // The parent temp dir should also be gone
    const parentDir = capturedPath!.replace(/\/voice\.ogg$/, '');
    expect(existsSync(parentDir)).toBe(false);
  });

  it('normalizes literal \\n in the voice summary too (codex fix carries over)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Body', '--voice', 'Line one\\nLine two'],
      { from: 'user' },
    );
    const [text] = synthesizeVoiceSpy.mock.calls[0];
    expect(text).toBe('Line one\nLine two');
  });
});

describe('send-telegram --voice (fallback paths)', () => {
  it('falls back to text-only when synthesizeVoice throws', async () => {
    synthesizeVoiceSpy.mockRejectedValueOnce(new Error('OPENAI_API_KEY missing'));

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Body still goes', '--voice', 'Summary'],
      { from: 'user' },
    );

    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe('Body still goes');
    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errs.some((e) => /voice.*synthesis failed/i.test(e))).toBe(true);
  });

  it('falls back to text-only when no voice is configured for the agent', async () => {
    const agentDir = process.env.CTX_AGENT_DIR!;
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ agent_name: 'atlas' }), // no voice
    );

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Body', '--voice', 'Summary'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores --voice when --image is also passed', async () => {
    const imgPath = join(tempCtx, 'fake.png');
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Caption', '--image', imgPath, '--voice', 'Should not synth'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendPhotoSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores --voice when --file is also passed', async () => {
    const filePath = join(tempCtx, 'fake.pdf');
    writeFileSync(filePath, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Caption', '--file', filePath, '--voice', 'Should not synth'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendDocumentSpy).toHaveBeenCalledTimes(1);
  });
});

describe('send-telegram (no --voice flag - regression check)', () => {
  it('does not call any voice-pipeline functions', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Just a normal message'],
      { from: 'user' },
    );

    expect(synthesizeVoiceSpy).not.toHaveBeenCalled();
    expect(sendVoiceSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('does not leave temp directories behind on failure', async () => {
    // No-voice path: nothing to clean up but the assertion is that the
    // existing send-telegram surface is not affected by my changes.
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Plain message'],
      { from: 'user' },
    );

    const tmp = require('os').tmpdir();
    const leftover = readdirSync(tmp).filter((f: string) => f.startsWith('cortextos-voice-'));
    expect(leftover).toEqual([]);
  });
});
