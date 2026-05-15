import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, CronDefinition, CtxEnv } from '../../../src/types/index';

const spawnMock = vi.fn();
const appendExecutionLogMock = vi.fn();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('../../../src/daemon/cron-execution-log.js', () => ({
  appendExecutionLog: (...args: unknown[]) => appendExecutionLogMock(...args),
}));

const FIRED_AT = '2026-05-15T00:00:00.000Z';

function makeCron(overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name: 'heartbeat',
    prompt: 'Run heartbeat.',
    schedule: '4h',
    enabled: true,
    created_at: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function appendSystemPromptValue(args: unknown[]): string | undefined {
  const idx = args.indexOf('--append-system-prompt');
  return idx === -1 ? undefined : String(args[idx + 1]);
}

function appendSystemPromptFlagCount(args: unknown[]): number {
  return args.filter(arg => arg === '--append-system-prompt').length;
}

function attachAgent(manager: any, agentName: string, config: AgentConfig = {}, extra: Record<string, unknown> = {}) {
  const process = {
    getConfig: vi.fn(() => config),
    getAgentDir: vi.fn(() => extra.agentDir ?? '/tmp/agent'),
    buildRuntimeEnv: vi.fn(() => extra.runtimeEnv ?? { CTX_ROOT: extra.ctxRoot ?? '/tmp/ctx' }),
    injectMessage: vi.fn(() => true),
  };
  manager.agents.set(agentName, { process, checker: {} });
  return process;
}

describe('cron fresh-session dispatch', () => {
  let tmpRoot: string;
  const originalCtxRoot = process.env.CTX_ROOT;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cron-fresh-'));
    process.env.CTX_ROOT = tmpRoot;
    spawnMock.mockReset();
    appendExecutionLogMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot; else delete process.env.CTX_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('dispatchCron injects into PTY when fresh_session is absent', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    const proc = attachAgent(manager, 'ops-g');

    await manager.dispatchCron('ops-g', makeCron(), '2026-05-15T00:00:00Z');

    expect(proc.injectMessage).toHaveBeenCalledWith(expect.stringContaining('[CRON FIRED'));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('dispatchCron uses fireCronFreshSession when fresh_session is true', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g');
    manager.fireCronFreshSession = vi.fn().mockResolvedValue(undefined);

    await manager.dispatchCron('ops-g', makeCron({ fresh_session: true }), FIRED_AT);

    expect(manager.fireCronFreshSession).toHaveBeenCalledWith(
      'ops-g',
      expect.objectContaining({ fresh_session: true }),
      expect.stringContaining(`[CRON FIRED ${FIRED_AT}]`),
      FIRED_AT,
    );
  });

  it('dispatchCron protects top-g/morning-review and injects', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    const proc = attachAgent(manager, 'top-g');
    manager.emitGuardrailEvent = vi.fn();

    await manager.dispatchCron(
      'top-g',
      makeCron({ name: 'morning-review', fresh_session: true }),
      FIRED_AT,
    );

    expect(manager.emitGuardrailEvent).toHaveBeenCalledWith('top-g', 'morning-review');
    expect(proc.injectMessage).toHaveBeenCalledOnce();
  });

  it('dispatchCron allows top-g/heartbeat fresh session', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'top-g');
    manager.fireCronFreshSession = vi.fn().mockResolvedValue(undefined);

    await manager.dispatchCron('top-g', makeCron({ name: 'heartbeat', fresh_session: true }), FIRED_AT);

    expect(manager.fireCronFreshSession).toHaveBeenCalledOnce();
  });

  it('dispatchCron allows top-g/check-approvals fresh session', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'top-g');
    manager.fireCronFreshSession = vi.fn().mockResolvedValue(undefined);

    await manager.dispatchCron(
      'top-g',
      makeCron({ name: 'check-approvals', fresh_session: true }),
      FIRED_AT,
    );

    expect(manager.fireCronFreshSession).toHaveBeenCalledOnce();
  });

  it('dispatchCron protects all smart-g crons through wildcard and injects', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    const proc = attachAgent(manager, 'smart-g');
    manager.emitGuardrailEvent = vi.fn();

    await manager.dispatchCron('smart-g', makeCron({ name: 'heartbeat', fresh_session: true }), FIRED_AT);

    expect(manager.emitGuardrailEvent).toHaveBeenCalledWith('smart-g', 'heartbeat');
    expect(proc.injectMessage).toHaveBeenCalledOnce();
  });

  it('fireCronFreshSession rejects unsupported codex-app-server runtime', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'codex-g', { runtime: 'codex-app-server' });
    manager.emitFreshSessionUnsupportedEvent = vi.fn();

    await expect(
      manager.fireCronFreshSession('codex-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT),
    ).rejects.toThrow(/not supported/);
    expect(manager.emitFreshSessionUnsupportedEvent).toHaveBeenCalledWith('codex-g', 'heartbeat', 'codex-app-server');
    expect(appendExecutionLogMock).toHaveBeenCalledWith(
      'codex-g',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('pre_spawn:'),
      }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fireCronFreshSession resolves on child close code 0', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.emit('close', 0, null);

    await expect(promise).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith('claude', expect.arrayContaining(['--print', '--no-session-persistence']), expect.any(Object));
  });

  it('fireCronFreshSession writes execution log on child close code 0', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.emit('close', 0, null);
    await promise;

    expect(appendExecutionLogMock).toHaveBeenCalledTimes(1);
    expect(appendExecutionLogMock).toHaveBeenCalledWith(
      'ops-g',
      expect.objectContaining({
        cron: 'heartbeat',
        status: 'fired',
        attempt: 1,
        duration_ms: expect.any(Number),
        error: null,
      }),
    );
  });

  it('fireCronFreshSession rejects on non-zero child close', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.emit('close', 1, null);

    await expect(promise).rejects.toThrow(/exited code=1/);
    expect(appendExecutionLogMock).toHaveBeenCalledTimes(1);
    expect(appendExecutionLogMock).toHaveBeenCalledWith(
      'ops-g',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('exit_code_1'),
      }),
    );
  });

  it('fireCronFreshSession rejects timeout even when child exits code 0 after SIGTERM', async () => {
    vi.useFakeTimers();
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, fresh_session_timeout_ms: 100 }),
      'prompt',
      FIRED_AT,
    );
    vi.advanceTimersByTime(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0, 'SIGTERM');

    await expect(promise).rejects.toThrow(/timed out/);
    expect(appendExecutionLogMock).toHaveBeenCalledTimes(1);
    expect(appendExecutionLogMock).toHaveBeenCalledWith(
      'ops-g',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('timed_out'),
      }),
    );
  });

  it('fireCronFreshSession writes execution log once on spawn error', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.emit('error', new Error('spawn failed'));
    child.emit('close', 0, null);

    await expect(promise).rejects.toThrow(/spawn failed/);
    expect(appendExecutionLogMock).toHaveBeenCalledTimes(1);
    expect(appendExecutionLogMock).toHaveBeenCalledWith(
      'ops-g',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('spawn_error'),
      }),
    );
  });

  it('fireCronFreshSession sends SIGKILL after timeout grace', async () => {
    vi.useFakeTimers();
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, fresh_session_timeout_ms: 100 }),
      'prompt',
      FIRED_AT,
    );
    vi.advanceTimersByTime(5_100);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');

    await expect(promise).rejects.toThrow(/timed out/);
  });

  it('fireCronFreshSession passes skill_file content via --append-system-prompt', async () => {
    const agentDir = join(tmpRoot, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), 'heartbeat instructions');
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { agentDir, ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, skill_file: 'HEARTBEAT.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    const args = spawnMock.mock.calls[0][1];
    expect(appendSystemPromptFlagCount(args)).toBe(1);
    expect(appendSystemPromptValue(args)).toBe('heartbeat instructions');
  });

  it('fireCronFreshSession passes protocol_file content via --append-system-prompt', async () => {
    const agentDir = join(tmpRoot, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), 'heartbeat protocol');
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { agentDir, ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, protocol_file: 'HEARTBEAT.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    const args = spawnMock.mock.calls[0][1];
    expect(appendSystemPromptFlagCount(args)).toBe(1);
    expect(appendSystemPromptValue(args)).toBe('heartbeat protocol');
  });

  it('fireCronFreshSession combines skill_file and protocol_file in deterministic order', async () => {
    const agentDir = join(tmpRoot, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'SKILL.md'), 'skill instructions');
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), 'heartbeat protocol');
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { agentDir, ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, skill_file: 'SKILL.md', protocol_file: 'HEARTBEAT.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    const args = spawnMock.mock.calls[0][1];
    expect(appendSystemPromptFlagCount(args)).toBe(1);
    expect(appendSystemPromptValue(args)).toBe('skill instructions\n\n---\n\nheartbeat protocol');
  });

  it('fireCronFreshSession ignores absolute protocol_file', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, protocol_file: '/tmp/secret.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    expect(spawnMock.mock.calls[0][1]).not.toContain('--append-system-prompt');
  });

  it('fireCronFreshSession keeps readable protocol_file when skill_file is unreadable', async () => {
    const agentDir = join(tmpRoot, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), 'heartbeat protocol');
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { agentDir, ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, skill_file: 'missing.md', protocol_file: 'HEARTBEAT.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    expect(appendSystemPromptValue(spawnMock.mock.calls[0][1])).toBe('heartbeat protocol');
  });

  it('fireCronFreshSession ignores unreadable protocol_file without suppressing skill_file', async () => {
    const agentDir = join(tmpRoot, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'SKILL.md'), 'skill instructions');
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { agentDir, ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, skill_file: 'SKILL.md', protocol_file: 'missing.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    expect(appendSystemPromptValue(spawnMock.mock.calls[0][1])).toBe('skill instructions');
  });

  it('fireCronFreshSession ignores unreadable skill_file', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, skill_file: 'missing.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    expect(spawnMock.mock.calls[0][1]).not.toContain('--append-system-prompt');
  });

  it('fireCronFreshSession ignores absolute skill_file', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, skill_file: '/tmp/secret.md' }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    expect(spawnMock.mock.calls[0][1]).not.toContain('--append-system-prompt');
  });

  it('fireCronFreshSession uses buildRuntimeEnv output and configured working directory', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    const proc = attachAgent(
      manager,
      'ops-g',
      { working_directory: '/work' },
      { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot, CUSTOM: 'yes' } },
    );
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.emit('close', 0, null);
    await promise;

    expect(proc.buildRuntimeEnv).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0][2]).toMatchObject({
      cwd: '/work',
      env: {
        CTX_ROOT: tmpRoot,
        CUSTOM: 'yes',
        CTX_CRON_FIRED_AT: FIRED_AT,
        CTX_FRESH_SESSION_CRON: 'ops-g/heartbeat',
      },
    });
  });

  it('fireCronFreshSession persists last_fire_attempted_at before spawn', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const { readCrons, writeCrons } = await import('../../../src/bus/crons.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    writeCrons('ops-g', [makeCron({ fresh_session: true })]);
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      expect(readCrons('ops-g')[0].last_fire_attempted_at).toBe(FIRED_AT);
      return child;
    });

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.emit('close', 0, null);
    await promise;

    expect(readCrons('ops-g')[0].last_fire_attempted_at).toBe(FIRED_AT);
  });

  it('fireCronFreshSession persists last_fire_attempted_at before spawn error', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const { readCrons, writeCrons } = await import('../../../src/bus/crons.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    writeCrons('ops-g', [makeCron({ fresh_session: true })]);
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    expect(readCrons('ops-g')[0].last_fire_attempted_at).toBe(FIRED_AT);
    child.emit('error', new Error('spawn failed'));

    await expect(promise).rejects.toThrow(/spawn failed/);
    expect(readCrons('ops-g')[0].last_fire_attempted_at).toBe(FIRED_AT);
  });

  it('fireCronFreshSession caps captured stdout and labels stdout/stderr log writes', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession('ops-g', makeCron({ fresh_session: true }), 'prompt', FIRED_AT);
    child.stdout.emit('data', Buffer.alloc(300 * 1024, 'a'));
    child.stderr.emit('data', Buffer.from('warn'));
    child.emit('close', 0, null);
    await promise;

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('fireCronFreshSession persists crons.json fire state on exit 0', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const { readCrons, writeCrons } = await import('../../../src/bus/crons.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    writeCrons('ops-g', [makeCron({ fresh_session: true, fire_count: 2 })]);
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, fire_count: 2 }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 0, null);
    await promise;

    expect(readCrons('ops-g')[0]).toMatchObject({
      last_fired_at: FIRED_AT,
      fire_count: 3,
    });
  });

  it('fireCronFreshSession does not persist crons.json fire state on non-zero exit', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
    const { readCrons, writeCrons } = await import('../../../src/bus/crons.js');
    const manager: any = new AgentManager('test', tmpRoot, tmpRoot, 'acme');
    attachAgent(manager, 'ops-g', {}, { ctxRoot: tmpRoot, runtimeEnv: { CTX_ROOT: tmpRoot } });
    writeCrons('ops-g', [makeCron({ fresh_session: true, fire_count: 2 })]);
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const promise = manager.fireCronFreshSession(
      'ops-g',
      makeCron({ fresh_session: true, fire_count: 2 }),
      'prompt',
      FIRED_AT,
    );
    child.emit('close', 1, null);
    await expect(promise).rejects.toThrow(/exited code=1/);

    expect(readCrons('ops-g')[0]).not.toHaveProperty('last_fired_at');
    expect(readCrons('ops-g')[0].fire_count).toBe(2);
  });
});

describe('runtime env builder and fresh-session guards', () => {
  let tmpRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cron-env-'));
    process.env = { ...originalEnv, PATH: '/bin', IS_SANDBOX: '1' };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('buildAgentRuntimeEnv includes CTX vars, org secrets, agent env, timezone, and orchestrator', async () => {
    const projectRoot = join(tmpRoot, 'fw');
    const agentDir = join(projectRoot, 'orgs', 'acme', 'agents', 'ops-g');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(projectRoot, 'orgs', 'acme', 'secrets.env'), 'SHARED_KEY=shared\nOVERRIDE=org\n');
    writeFileSync(join(agentDir, '.env'), 'CHAT_ID=123\nOVERRIDE=agent\n');
    writeFileSync(join(projectRoot, 'orgs', 'acme', 'context.json'), JSON.stringify({ orchestrator: 'top-g' }));

    const { buildAgentRuntimeEnv } = await import('../../../src/utils/env.js');
    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: tmpRoot,
      frameworkRoot: projectRoot,
      projectRoot,
      org: 'acme',
      agentName: 'ops-g',
      agentDir,
    };

    const runtimeEnv = buildAgentRuntimeEnv(env, { timezone: 'Asia/Bangkok' });

    expect(runtimeEnv).toMatchObject({
      CTX_ROOT: tmpRoot,
      CTX_AGENT_NAME: 'ops-g',
      CTX_ORG: 'acme',
      CTX_TELEGRAM_CHAT_ID: '123',
      CTX_ORCHESTRATOR_AGENT: 'top-g',
      TZ: 'Asia/Bangkok',
      SHARED_KEY: 'shared',
      OVERRIDE: 'agent',
      IS_SANDBOX: '1',
    });
  });

  it('buildAgentRuntimeEnv propagates TZ when config.timezone is absent', async () => {
    const projectRoot = join(tmpRoot, 'fw');
    const agentDir = join(projectRoot, 'orgs', 'acme', 'agents', 'ops-g');
    mkdirSync(agentDir, { recursive: true });
    process.env.TZ = 'Asia/Bangkok';

    const { buildAgentRuntimeEnv } = await import('../../../src/utils/env.js');
    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: tmpRoot,
      frameworkRoot: projectRoot,
      projectRoot,
      org: 'acme',
      agentName: 'ops-g',
      agentDir,
    };

    const runtimeEnv = buildAgentRuntimeEnv(env, {});

    expect(runtimeEnv).toMatchObject({
      CTX_TIMEZONE: 'Asia/Bangkok',
      TZ: 'Asia/Bangkok',
    });
  });

  it('guard helpers protect specific cron patterns', async () => {
    const { isFreshSessionProtectedCron } = await import('../../../src/utils/fresh-session-guards.js');
    expect(isFreshSessionProtectedCron('top-g', 'morning-review')).toBe(true);
    expect(isFreshSessionProtectedCron('top-g', 'evening-review')).toBe(true);
    expect(isFreshSessionProtectedCron('top-g', 'weekly-review')).toBe(true);
    expect(isFreshSessionProtectedCron('top-g', 'heartbeat')).toBe(false);
    expect(isFreshSessionProtectedCron('top-g', 'check-approvals')).toBe(false);
    expect(isFreshSessionProtectedCron('smart-g', 'heartbeat')).toBe(true);
    expect(isFreshSessionProtectedCron('ops-g', 'heartbeat')).toBe(false);
  });

  it('guard helpers support only undefined and claude-code runtimes', async () => {
    const { isFreshSessionSupportedRuntime } = await import('../../../src/utils/fresh-session-guards.js');
    expect(isFreshSessionSupportedRuntime(undefined)).toBe(true);
    expect(isFreshSessionSupportedRuntime('claude-code')).toBe(true);
    expect(isFreshSessionSupportedRuntime('codex-app-server')).toBe(false);
    expect(isFreshSessionSupportedRuntime('hermes')).toBe(false);
  });
});

describe('IPC fresh-session mutation and manual fire validation', () => {
  let tmpRoot: string;
  let frameworkRoot: string;
  const originalCtxRoot = process.env.CTX_ROOT;
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cron-ipc-'));
    frameworkRoot = join(tmpRoot, 'fw');
    process.env.CTX_ROOT = tmpRoot;
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
    mkdirSync(join(tmpRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'ops-g'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'codex-g'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'top-g'), { recursive: true });
    writeFileSync(join(tmpRoot, 'config', 'enabled-agents.json'), JSON.stringify({
      'ops-g': { enabled: true, org: 'acme' },
      'codex-g': { enabled: true, org: 'acme' },
      'top-g': { enabled: true, org: 'acme' },
    }));
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'ops-g', 'config.json'), '{}');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'codex-g', 'config.json'), '{"runtime":"codex-app-server"}');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'top-g', 'config.json'), '{}');
    vi.resetModules();
  });

  afterEach(() => {
    if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot; else delete process.env.CTX_ROOT;
    if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot; else delete process.env.CTX_FRAMEWORK_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('handleAddCron copies fresh-session fields', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const { readCrons } = await import('../../../src/bus/crons.js');

    const result = handleAddCron('ops-g', {
      name: 'heartbeat',
      prompt: 'Run heartbeat.',
      schedule: '4h',
      fresh_session: true,
      skill_file: 'HEARTBEAT.md',
      fresh_session_timeout_ms: 120_000,
    });

    expect(result.ok).toBe(true);
    expect(readCrons('ops-g')[0]).toMatchObject({
      fresh_session: true,
      skill_file: 'HEARTBEAT.md',
      fresh_session_timeout_ms: 120_000,
    });
  });

  it('handleUpdateCron copies fresh-session fields', async () => {
    const { handleAddCron, handleUpdateCron } = await import('../../../src/daemon/ipc-server.js');
    const { readCrons } = await import('../../../src/bus/crons.js');
    handleAddCron('ops-g', { name: 'heartbeat', prompt: 'x', schedule: '4h' });

    const result = handleUpdateCron('ops-g', 'heartbeat', {
      fresh_session: true,
      skill_file: 'HEARTBEAT.md',
      fresh_session_timeout_ms: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(readCrons('ops-g')[0]).toMatchObject({
      fresh_session: true,
      skill_file: 'HEARTBEAT.md',
      fresh_session_timeout_ms: 60_000,
    });
  });

  it('handleAddCron rejects protected top-g/morning-review', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('top-g', {
      name: 'morning-review',
      prompt: 'x',
      schedule: '4h',
      fresh_session: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/protected/);
  });

  it('handleAddCron allows top-g/heartbeat', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('top-g', {
      name: 'heartbeat',
      prompt: 'x',
      schedule: '4h',
      fresh_session: true,
    });
    expect(result.ok).toBe(true);
  });

  it('handleAddCron rejects unsupported codex-app-server runtime', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('codex-g', {
      name: 'heartbeat',
      prompt: 'x',
      schedule: '4h',
      fresh_session: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not supported/);
  });

  it('handleAddCron rejects absolute skill_file', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('ops-g', {
      name: 'heartbeat',
      prompt: 'x',
      schedule: '4h',
      skill_file: '/tmp/HEARTBEAT.md',
    });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('skill_file');
  });

  it('handleAddCron rejects invalid fresh_session_timeout_ms', async () => {
    const { handleAddCron } = await import('../../../src/daemon/ipc-server.js');
    const result = handleAddCron('ops-g', {
      name: 'heartbeat',
      prompt: 'x',
      schedule: '4h',
      fresh_session_timeout_ms: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.field).toBe('fresh_session_timeout_ms');
  });

  it('handleFireCron dispatches through provided dispatch function and records cooldown only on success', async () => {
    const { handleAddCron, handleFireCron, manualFireCooldownRemaining } = await import('../../../src/daemon/ipc-server.js');
    handleAddCron('ops-g', { name: 'heartbeat', prompt: 'x', schedule: '4h', fresh_session: true });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const now = 1_000_000;

    const result = await handleFireCron('ops-g', 'heartbeat', dispatch, now);

    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith('ops-g', expect.objectContaining({ fresh_session: true }), new Date(now).toISOString());
    expect(manualFireCooldownRemaining('ops-g', 'heartbeat', now + 1)).toBeGreaterThan(0);
  });

  it('handleFireCron does not record cooldown when dispatch fails', async () => {
    const { handleAddCron, handleFireCron, manualFireCooldownRemaining } = await import('../../../src/daemon/ipc-server.js');
    handleAddCron('ops-g', { name: 'heartbeat', prompt: 'x', schedule: '4h' });
    const dispatch = vi.fn().mockRejectedValue(new Error('boom'));
    const now = 1_000_000;

    const result = await handleFireCron('ops-g', 'heartbeat', dispatch, now);

    expect(result.ok).toBe(false);
    expect(manualFireCooldownRemaining('ops-g', 'heartbeat', now + 1)).toBe(0);
  });
});
