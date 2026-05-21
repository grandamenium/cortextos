import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BusPaths } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Mock collaborators so unit tests do not touch the network or real inboxes.
// ---------------------------------------------------------------------------
const sendMessageMock = vi.fn();
vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

const telegramSendSpy = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(public token: string) {}
    sendMessage(...args: unknown[]) {
      return telegramSendSpy(...args);
    }
  },
}));

// The event logger writes JSONL + tries to refresh the heartbeat + mirror to
// Supabase. Stub it to a pure spy so tests do not depend on any of that.
const logEventMock = vi.fn();
vi.mock('../../../src/bus/event.js', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
}));

import { runWipEnforcer } from '../../../src/bus/wip-enforcer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'orchestrator'),
    inflight: join(root, 'inflight', 'orchestrator'),
    processed: join(root, 'processed', 'orchestrator'),
    logDir: join(root, 'logs', 'orchestrator'),
    stateDir: join(root, 'state', 'orchestrator'),
    taskDir: join(root, 'orgs', 'revops-global', 'tasks'),
    approvalDir: join(root, 'orgs', 'revops-global', 'approvals'),
    analyticsDir: join(root, 'orgs', 'revops-global', 'analytics'),
    deliverablesDir: join(root, 'orgs', 'revops-global', 'deliverables'),
  };
}

function writeTask(paths: BusPaths, overrides: Record<string, unknown>): void {
  mkdirSync(paths.taskDir, { recursive: true });
  const id = `task_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const task = {
    id,
    title: 't',
    description: '',
    type: 'agent',
    needs_approval: false,
    status: 'in_progress',
    assigned_to: 'dev',
    created_by: 'orchestrator',
    org: 'revops-global',
    priority: 'normal',
    project: '',
    kpi_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
  writeFileSync(join(paths.taskDir, `${id}.json`), JSON.stringify(task));
}

function writeGoals(paths: BusPaths, content: unknown): void {
  const orgDir = join(paths.ctxRoot, 'orgs', 'revops-global');
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(orgDir, 'goals.json'), JSON.stringify(content));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('wip-enforcer', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-wip-enforcer-'));
    sendMessageMock.mockReset();
    telegramSendSpy.mockClear();
    logEventMock.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.CTX_TELEGRAM_CHAT_ID;
    delete process.env.BOT_TOKEN;
  });

  it('pings under-target agents and bumps tick counter, no Telegram on first tick', async () => {
    const paths = makePaths(root);
    // dev is at 1/3 (under), analyst is at 3/3 (at target).
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'analyst', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'analyst', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'analyst', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'dev', status: 'completed' }); // should not count
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress', archived: true }); // should not count

    const result = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {
      telegramChatId: '12345',
      botToken: 'BOT',
    });

    const devRow = result.agents.find(a => a.agent === 'dev')!;
    const analystRow = result.agents.find(a => a.agent === 'analyst')!;
    expect(devRow.in_progress).toBe(1);
    expect(devRow.wip_target).toBe(3);
    expect(devRow.under_target).toBe(true);
    expect(devRow.ticks_under_target).toBe(1);
    expect(devRow.message_sent).toBe(true);
    expect(devRow.telegram_alerted).toBe(false);

    expect(analystRow.in_progress).toBe(3);
    expect(analystRow.under_target).toBe(false);
    expect(analystRow.message_sent).toBe(false);

    // FORCE-SPAWN ping only to dev, never to the at-target analyst.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [, from, to, priority, text] = sendMessageMock.mock.calls[0];
    expect(from).toBe('orchestrator');
    expect(to).toBe('dev');
    expect(priority).toBe('high');
    expect(text).toContain('FORCE-SPAWN');
    expect(text).toContain('1/3');

    // No Telegram alert on the first under-target tick.
    expect(telegramSendSpy).not.toHaveBeenCalled();

    // log-event fires regardless of whether anyone was under.
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const [, agentName, org, category, eventName, severity, meta] = logEventMock.mock.calls[0];
    expect(agentName).toBe('orchestrator');
    expect(org).toBe('revops-global');
    expect(category).toBe('action');
    expect(eventName).toBe('wip_enforcer_tick');
    expect(severity).toBe('info');
    expect(meta).toMatchObject({
      agents_checked: 2,
      agents_under_target: 1,
      messages_sent: 1,
      telegram_alerts: 0,
    });
  });

  it('fires Telegram alert on the 2nd consecutive under-target tick', async () => {
    const paths = makePaths(root);
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });

    // First tick: under target, ticks=1, no Telegram yet.
    const tick1 = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {
      telegramChatId: '12345',
      botToken: 'BOT',
    });
    expect(tick1.agents[0].ticks_under_target).toBe(1);
    expect(tick1.agents[0].telegram_alerted).toBe(false);

    // Second tick: still under, ticks=2, Telegram fires.
    const tick2 = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {
      telegramChatId: '12345',
      botToken: 'BOT',
    });
    expect(tick2.agents[0].ticks_under_target).toBe(2);
    expect(tick2.agents[0].telegram_alerted).toBe(true);
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
    expect(telegramSendSpy).toHaveBeenCalledWith(
      '12345',
      expect.stringContaining('dev under WIP target'),
      undefined,
      { parseMode: null },
    );

    // State file persists ticks across runs.
    const statePath = join(paths.ctxRoot, 'orgs', 'revops-global', 'wip-enforcer-state.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.ticks_under_target.dev).toBe(2);
  });

  it('resets tick counter when an agent reaches target', async () => {
    const paths = makePaths(root);

    // Prime state with dev under target for 5 prior ticks.
    const orgDir = join(paths.ctxRoot, 'orgs', 'revops-global');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(
      join(orgDir, 'wip-enforcer-state.json'),
      JSON.stringify({ updated_at: new Date(0).toISOString(), ticks_under_target: { dev: 5 } }),
    );

    // dev is now at target (3/3).
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });

    const result = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {});
    const devRow = result.agents.find(a => a.agent === 'dev')!;
    expect(devRow.under_target).toBe(false);
    expect(devRow.ticks_under_target).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('honors per-agent wip_target override from goals.json', async () => {
    const paths = makePaths(root);
    writeGoals(paths, {
      wip_target: 3,
      agents: {
        dev: { wip_target: 5 },
        analyst: { wip_target: 1 },
      },
    });
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'analyst', status: 'in_progress' });

    const result = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {});
    const dev = result.agents.find(a => a.agent === 'dev')!;
    const analyst = result.agents.find(a => a.agent === 'analyst')!;
    // dev: 2/5 → under, analyst: 1/1 → at target
    expect(dev.wip_target).toBe(5);
    expect(dev.under_target).toBe(true);
    expect(analyst.wip_target).toBe(1);
    expect(analyst.under_target).toBe(false);
  });

  it('skips agents with wip_target=0 (enforcement disabled)', async () => {
    const paths = makePaths(root);
    writeGoals(paths, { agents: { dev: { wip_target: 0 } } });
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });
    writeTask(paths, { assigned_to: 'analyst', status: 'in_progress' });

    const result = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {});
    expect(result.agents.some(a => a.agent === 'dev')).toBe(false);
    expect(result.agents.find(a => a.agent === 'analyst')!.under_target).toBe(true);
  });

  it('dry-run computes counters but sends nothing and does not persist state', async () => {
    const paths = makePaths(root);
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });

    const result = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {
      telegramChatId: '12345',
      botToken: 'BOT',
      dryRun: true,
    });

    const dev = result.agents.find(a => a.agent === 'dev')!;
    expect(dev.under_target).toBe(true);
    expect(dev.ticks_under_target).toBe(1);
    expect(dev.message_sent).toBe(false);
    expect(dev.telegram_alerted).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(telegramSendSpy).not.toHaveBeenCalled();

    // Dry-run must not persist the new tick state — otherwise back-to-back
    // dry-runs would silently inflate counters.
    expect(() =>
      readFileSync(join(paths.ctxRoot, 'orgs', 'revops-global', 'wip-enforcer-state.json'), 'utf-8'),
    ).toThrow();
  });

  it('self-excludes the calling agent', async () => {
    const paths = makePaths(root);
    // orchestrator itself is under target — it must not ping itself.
    writeTask(paths, { assigned_to: 'orchestrator', status: 'in_progress' });

    const result = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {});
    expect(result.agents.some(a => a.agent === 'orchestrator')).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not Telegram-alert when chat id or bot token is missing', async () => {
    const paths = makePaths(root);
    writeTask(paths, { assigned_to: 'dev', status: 'in_progress' });

    // Tick to ticks=1
    await runWipEnforcer(paths, 'orchestrator', 'revops-global', {
      telegramChatId: '',
      botToken: '',
    });
    // Tick to ticks=2; threshold met but no chat id → no Telegram.
    const tick2 = await runWipEnforcer(paths, 'orchestrator', 'revops-global', {
      telegramChatId: '',
      botToken: '',
    });
    expect(tick2.agents[0].ticks_under_target).toBe(2);
    expect(tick2.agents[0].telegram_alerted).toBe(false);
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });
});
