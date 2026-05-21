/**
 * Unit tests for `cortextos bus send-slack`.
 *
 * Mirrors the send-telegram-normalize test pattern:
 * - Mock SlackAPI so no network calls hit Slack
 * - Test happy path, bad channel, missing token, thread reply, blocks, file upload stub
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const postMessageSpy = vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.123456', channel: '#general-communication', message: { text: 'hello' } });
const uploadFileSpy = vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.999', channel: '#general-communication', message: { text: '' } });

vi.mock('../../../src/slack/api.js', () => ({
  SlackAPI: class {
    constructor(_token: string) {}
    postMessage(...args: unknown[]) { return postMessageSpy(...args); }
    uploadFile(...args: unknown[]) { return uploadFileSpy(...args); }
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalEnv: Record<string, string | undefined>;
let originalCwd: string;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'slack-test-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'slack-test-cwd-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });

  originalEnv = {
    CTX_ROOT: process.env.CTX_ROOT,
    CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  };
  originalCwd = process.cwd();

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.SLACK_BOT_TOKEN = 'xoxb-fake-token-for-tests';
  process.chdir(tempCwd);

  postMessageSpy.mockClear();
  uploadFileSpy.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('send-slack: happy path', () => {
  it('posts to a #channel and prints the ts on success', async () => {
    let output = '';
    const origLog = console.log;
    console.log = (s: string) => { output += s; };

    await busCommand.parseAsync(
      ['send-slack', '#general-communication', 'hello from forge'],
      { from: 'user' },
    );

    console.log = origLog;
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const call = postMessageSpy.mock.calls[0][0] as { channel: string; text: string };
    expect(call.channel).toBe('#general-communication');
    expect(call.text).toBe('hello from forge');
    expect(output).toContain('1234567890.123456');
  });

  it('accepts a bare C-channel-id without # prefix', async () => {
    await busCommand.parseAsync(
      ['send-slack', 'C020ABXA403', 'direct channel id'],
      { from: 'user' },
    );
    const call = postMessageSpy.mock.calls[0][0] as { channel: string };
    expect(call.channel).toBe('C020ABXA403');
  });

  it('passes thread_ts when --thread-ts is supplied', async () => {
    await busCommand.parseAsync(
      ['send-slack', '#general-communication', 'threaded reply', '--thread-ts', '9999.000001'],
      { from: 'user' },
    );
    const call = postMessageSpy.mock.calls[0][0] as { threadTs?: string };
    expect(call.threadTs).toBe('9999.000001');
  });

  it('normalizes literal \\n in message text (matches send-telegram codex-agent fix)', async () => {
    await busCommand.parseAsync(
      ['send-slack', '#general-communication', 'line1\\n\\nline2'],
      { from: 'user' },
    );
    const call = postMessageSpy.mock.calls[0][0] as { text: string };
    expect(call.text).toBe('line1\n\nline2');
    expect(call.text).not.toContain('\\n');
  });

  it('triggers uploadFile when --file is provided', async () => {
    const tmpFile = join(tempCwd, 'test.txt');
    writeFileSync(tmpFile, 'file content');

    await busCommand.parseAsync(
      ['send-slack', '#general-communication', 'see attached', '--file', tmpFile],
      { from: 'user' },
    );

    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    const call = uploadFileSpy.mock.calls[0][0] as { channel: string; filePath: string };
    expect(call.channel).toBe('#general-communication');
    expect(call.filePath).toBe(tmpFile);
  });
});

describe('send-slack: error paths', () => {
  it('exits non-zero when SLACK_BOT_TOKEN is missing and 1pw is unavailable', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    // Ensure op is not on PATH for this test by using a mock that throws
    const origSpawnSync = require('child_process').spawnSync;
    require('child_process').spawnSync = () => ({ status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') });

    let exitCode = 0;
    const origExit = process.exit;
    process.exit = ((code: number) => { exitCode = code; throw new Error('exit'); }) as never;

    try {
      await busCommand.parseAsync(
        ['send-slack', '#general-communication', 'should fail'],
        { from: 'user' },
      );
    } catch { /* expected */ }

    process.exit = origExit;
    require('child_process').spawnSync = origSpawnSync;
    expect(exitCode).toBe(1);
  });

  it('exits non-zero when Slack API returns ok: false', async () => {
    postMessageSpy.mockResolvedValueOnce({ ok: false, error: 'channel_not_found' });

    let exitCode = 0;
    const origExit = process.exit;
    process.exit = ((code: number) => { exitCode = code; throw new Error('exit'); }) as never;

    try {
      await busCommand.parseAsync(
        ['send-slack', '#nonexistent', 'should fail'],
        { from: 'user' },
      );
    } catch { /* expected */ }

    process.exit = origExit;
    expect(exitCode).toBe(1);
  });
});
