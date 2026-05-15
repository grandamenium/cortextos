import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { main, readMaxCrashesPerDay, notifyAgents } from '../../../src/hooks/hook-crash-alert';

describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('main fresh-session suppression', () => {
  const originalEnv = { ...process.env };
  let instanceId: string;
  let ctxRoot: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    instanceId = `hook-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    ctxRoot = join(homedir(), '.cortextos', instanceId);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    execFileMock.mockReset();
    process.env = {
      ...originalEnv,
      CTX_INSTANCE_ID: instanceId,
      CTX_AGENT_NAME: 'dev-g',
      CTX_FRESH_SESSION_CRON: 'dev-g/heartbeat',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('returns before crashes.log, crash counter, Telegram, and agent notifications', async () => {
    await main();

    expect(existsSync(join(ctxRoot, 'logs', 'dev-g', 'crashes.log'))).toBe(false);
    expect(existsSync(join(ctxRoot, 'state', 'dev-g', '.crash_count_today'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('suppresses side effects even when Telegram credentials are present', async () => {
    process.env.BOT_TOKEN = 'token';
    process.env.CHAT_ID = 'chat';

    await main();

    expect(existsSync(join(ctxRoot, 'logs', 'dev-g', 'crashes.log'))).toBe(false);
    expect(existsSync(join(ctxRoot, 'state', 'dev-g', '.crash_count_today'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does not consume marker files before returning', async () => {
    const stateDir = join(ctxRoot, 'state', 'dev-g');
    mkdirSync(stateDir, { recursive: true });
    const markerPath = join(stateDir, '.restart-planned');
    writeFileSync(markerPath, 'planned restart', 'utf-8');

    await main();

    expect(existsSync(markerPath)).toBe(true);
  });

  it('normal crash still writes crashes.log when fresh-session marker is absent', async () => {
    delete process.env.CTX_FRESH_SESSION_CRON;
    delete process.env.BOT_TOKEN;
    delete process.env.CHAT_ID;

    await main();

    const crashesLog = join(ctxRoot, 'logs', 'dev-g', 'crashes.log');
    expect(readFileSync(crashesLog, 'utf-8')).toContain('type=crash');
    expect(readFileSync(join(ctxRoot, 'state', 'dev-g', '.crash_count_today'), 'utf-8')).toContain(':1');
  });
});
