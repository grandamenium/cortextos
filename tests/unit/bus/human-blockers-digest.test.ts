import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// ---------------------------------------------------------------------------
// Mock TelegramAPI so no network calls are made in tests.
// ---------------------------------------------------------------------------
const telegramSendSpy = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
vi.mock('../../../src/telegram/api', () => ({
  TelegramAPI: class {
    constructor(public token: string) {}
    sendMessage(...args: unknown[]) { return telegramSendSpy(...args); }
  },
}));

// ---------------------------------------------------------------------------
// We need to control the home directory so digestHumanBlockers reads our
// temp fixture dirs.  Override os.homedir() before the module is imported.
// ---------------------------------------------------------------------------
let fakeHome: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

// Import AFTER mocks are installed.
import { digestHumanBlockers, sendHumanBlockersDigest } from '../../../src/bus/human-blockers-digest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePaths(root: string, instanceId = 'default') {
  const ctxRoot = join(root, '.cortextos', instanceId);
  return ctxRoot;
}

function writeTask(
  taskDir: string,
  overrides: Record<string, unknown> = {},
): void {
  mkdirSync(taskDir, { recursive: true });
  const id = `task_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const task = {
    id,
    title: '[HUMAN] Approve deployment to prod',
    description: '',
    type: 'human',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'orchestrator',
    created_by: 'dev',
    org: 'revops-global',
    priority: 'high',
    project: '',
    kpi_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
  writeFileSync(join(taskDir, `${id}.json`), JSON.stringify(task));
}

function writeApproval(
  pendingDir: string,
  overrides: Record<string, unknown> = {},
): void {
  mkdirSync(pendingDir, { recursive: true });
  const id = `approval_${Date.now()}_abc${Math.floor(Math.random() * 1000)}`;
  const approval = {
    id,
    title: 'Deploy API v2',
    requesting_agent: 'dev',
    org: 'revops-global',
    category: 'deployment',
    status: 'pending',
    description: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
  writeFileSync(join(pendingDir, `${id}.json`), JSON.stringify(approval));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('digestHumanBlockers', () => {
  let tempDir: string;
  let ctxRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cortextos-hbd-test-'));
    fakeHome = tempDir;
    ctxRoot = makePaths(tempDir);
    telegramSendSpy.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns "No human blockers pending." when stores are empty', () => {
    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toBe('No human blockers pending.');
  });

  it('includes [HUMAN]-prefixed pending tasks in the digest', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTask(taskDir, { title: '[HUMAN] Review budget', assigned_to: 'analyst', priority: 'normal' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('Review budget');
    expect(result).toContain('analyst');
  });

  it('excludes completed tasks', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTask(taskDir, { title: '[HUMAN] Done task', status: 'completed' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toBe('No human blockers pending.');
  });

  it('excludes tasks without [HUMAN] prefix', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTask(taskDir, { title: 'Regular task', status: 'pending' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toBe('No human blockers pending.');
  });

  it('includes pending approvals in the digest', () => {
    const pendingDir = join(ctxRoot, 'orgs', 'revops-global', 'approvals', 'pending');
    writeApproval(pendingDir, { title: 'Deploy v3', requesting_agent: 'codex' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('Deploy v3');
    expect(result).toContain('codex');
    expect(result).toContain('[approval]');
  });

  it('includes both tasks and approvals in the same digest', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    const pendingDir = join(ctxRoot, 'orgs', 'revops-global', 'approvals', 'pending');
    writeTask(taskDir, { title: '[HUMAN] Check logs', assigned_to: 'orchestrator', priority: 'high' });
    writeApproval(pendingDir, { title: 'Release feature flag', requesting_agent: 'dev' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('Check logs');
    expect(result).toContain('Release feature flag');
  });

  it('filters tasks by --since timestamp', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 2 days ago
    writeTask(taskDir, {
      title: '[HUMAN] Old task',
      assigned_to: 'orchestrator',
      created_at: oldDate,
      updated_at: oldDate,
    });

    const sinceYesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = digestHumanBlockers({ instanceId: 'default', since: sinceYesterday, chatId: '123' });
    expect(result).toBe('No human blockers pending.');
  });

  it('groups by priority in the digest header', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTask(taskDir, { title: '[HUMAN] Urgent item', priority: 'urgent', assigned_to: 'orchestrator' });
    writeTask(taskDir, { title: '[HUMAN] Normal item', priority: 'normal', assigned_to: 'dev' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('[URGENT]');
    expect(result).toContain('[NORMAL]');
    // URGENT should appear before NORMAL
    expect(result.indexOf('[URGENT]')).toBeLessThan(result.indexOf('[NORMAL]'));
  });

  it('reports item count in header', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTask(taskDir, { title: '[HUMAN] Item one', priority: 'high', assigned_to: 'orchestrator' });
    writeTask(taskDir, { title: '[HUMAN] Item two', priority: 'normal', assigned_to: 'dev' });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('2 items');
  });

  it('includes task description as step-by-step details block', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    writeTask(taskDir, {
      title: '[HUMAN] Top up Google AI Studio credits',
      assigned_to: 'orchestrator',
      priority: 'high',
      description: '1. Go to https://ai.studio/projects\n2. Click "Billing" in left nav\n3. Click "Add credits" and enter $20\n4. Paste confirmation number back here',
    });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('Top up Google AI Studio credits');
    expect(result).toContain('https://ai.studio/projects');
    expect(result).toContain('Add credits');
    expect(result).toContain('Paste confirmation number back here');
  });

  it('truncates very long details to 600 chars', () => {
    const taskDir = join(ctxRoot, 'orgs', 'revops-global', 'tasks');
    const longDesc = 'step '.repeat(200); // 1000 chars
    writeTask(taskDir, {
      title: '[HUMAN] Long description task',
      assigned_to: 'dev',
      priority: 'normal',
      description: longDesc,
    });

    const result = digestHumanBlockers({ instanceId: 'default', chatId: '123' });
    expect(result).toContain('…');
    // Details block should not exceed 600 chars + overhead
    const detailsStart = result.indexOf('step ');
    const detailsChunk = result.slice(detailsStart);
    expect(detailsChunk.length).toBeLessThan(700);
  });
});

describe('sendHumanBlockersDigest --dry-run', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cortextos-hbd-dry-'));
    fakeHome = tempDir;
    telegramSendSpy.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not call TelegramAPI.sendMessage when --dry-run is set', async () => {
    const writtenLines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        if (typeof chunk === 'string') writtenLines.push(chunk);
        return true;
      });

    await sendHumanBlockersDigest({
      chatId: '999',
      instanceId: 'default',
      dryRun: true,
      botToken: 'fake-token',
    });

    spy.mockRestore();

    expect(telegramSendSpy).not.toHaveBeenCalled();
    expect(writtenLines.join('')).toContain('No human blockers pending.');
  });

  it('calls TelegramAPI.sendMessage when not in dry-run mode', async () => {
    await sendHumanBlockersDigest({
      chatId: '123',
      instanceId: 'default',
      dryRun: false,
      botToken: 'fake-token',
    });

    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
    const [chatId, message] = telegramSendSpy.mock.calls[0];
    expect(chatId).toBe('123');
    expect(typeof message).toBe('string');
    expect(message).toContain('No human blockers pending.');
  });

  it('throws when botToken is missing and not in dry-run mode', async () => {
    const savedToken = process.env.BOT_TOKEN;
    delete process.env.BOT_TOKEN;

    await expect(
      sendHumanBlockersDigest({
        chatId: '123',
        instanceId: 'default',
        dryRun: false,
        botToken: '',
      }),
    ).rejects.toThrow('BOT_TOKEN not set');

    if (savedToken !== undefined) process.env.BOT_TOKEN = savedToken;
  });
});
