import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Spy on postActivity at module scope so createApproval's fire-and-forget
// call is observable without the test having to await it.
const postActivitySpy = vi.fn().mockResolvedValue(true);
vi.mock('../../../src/bus/system', () => ({
  postActivity: (...args: unknown[]) => postActivitySpy(...args),
}));
vi.mock('../../../src/bus/message', () => ({
  sendMessage: vi.fn(),
}));

// Mock TelegramAPI so the agent-bot ping is observable without hitting the
// network. Constructor records the bot token; sendMessage records its call.
const telegramSendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const telegramConstructorSpy = vi.fn();
vi.mock('../../../src/telegram/api', () => ({
  TelegramAPI: class {
    constructor(token: string) {
      telegramConstructorSpy(token);
    }
    sendMessage(...args: unknown[]) {
      return telegramSendMessageSpy(...args);
    }
  },
}));

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApproval, updateApproval, listPendingApprovals } from '../../../src/bus/approval';
import type { BusPaths } from '../../../src/types';

let testDir: string;
let frameworkRoot: string;
let paths: BusPaths;

function mkPaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox'),
    inflight: join(root, 'inflight'),
    processed: join(root, 'processed'),
    logDir: join(root, 'logs'),
    stateDir: join(root, 'state'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'orgs', 'TestOrg', 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-approval-test-'));
  // Distinct framework root so the path-resolution regression test can
  // verify postActivity receives the FRAMEWORK path, not the runtime
  // state (ctxRoot) path. In production these are separate directories
  // (~/cortextOS/ vs ~/.cortextos/default/) and the approval bug shipped
  // because the original code conflated them.
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-framework-test-'));
  paths = mkPaths(testDir);
  postActivitySpy.mockClear();
  postActivitySpy.mockResolvedValue(true);
  telegramSendMessageSpy.mockClear();
  telegramSendMessageSpy.mockResolvedValue({ result: { message_id: 1 } });
  telegramConstructorSpy.mockClear();
  delete process.env.CTX_FRAMEWORK_ROOT;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  rmSync(frameworkRoot, { recursive: true, force: true });
  delete process.env.CTX_FRAMEWORK_ROOT;
});

describe('createApproval', () => {
  it('writes the approval JSON to pending/ and returns a stable id', async () => {
    const id = await createApproval(paths, 'alice', 'TestOrg', 'Deploy to prod', 'deployment', 'why this matters', frameworkRoot);
    expect(id).toMatch(/^approval_\d+_[a-zA-Z0-9]+$/);

    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(true);

    const approval = JSON.parse(readFileSync(pendingFile, 'utf-8'));
    expect(approval.title).toBe('Deploy to prod');
    expect(approval.category).toBe('deployment');
    expect(approval.status).toBe('pending');
    expect(approval.requesting_agent).toBe('alice');
    expect(approval.org).toBe('TestOrg');
  });

  it('posts to the activity channel with Approve/Deny inline keyboard (framework orgDir, not ctxRoot)', async () => {
    const id = await createApproval(paths, 'alice', 'TestOrg', 'Push to main', 'deployment', 'rationale', frameworkRoot);

    expect(postActivitySpy).toHaveBeenCalledTimes(1);
    const [orgDir, ctxRoot, org, message, replyMarkup] = postActivitySpy.mock.calls[0] as [
      string,
      string,
      string,
      string,
      any,
    ];
    // REGRESSION GUARD: orgDir must resolve under the FRAMEWORK root
    // (where activity-channel.env actually lives in production), NOT
    // under the runtime state ctxRoot. An earlier version of this code
    // used ctxRoot, which silently resolved to the wrong filesystem root
    // and caused every activity-channel post to fail — the bug that
    // motivated this test.
    expect(String(orgDir)).toBe(join(frameworkRoot, 'orgs', 'TestOrg'));
    expect(String(orgDir)).not.toBe(join(testDir, 'orgs', 'TestOrg'));
    expect(String(ctxRoot)).toBe(testDir);
    expect(String(org)).toBe('TestOrg');
    expect(String(message)).toContain('Push to main');
    expect(String(message)).toContain('deployment');
    expect(String(message)).toContain('alice');
    expect(String(message)).toContain(id);

    // Inline keyboard: single row, two buttons, callback_data prefixes
    // keyed on the approval id.
    expect(replyMarkup).toBeDefined();
    const rows = replyMarkup.inline_keyboard;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0].callback_data).toBe(`appr_allow_${id}`);
    expect(rows[0][1].callback_data).toBe(`appr_deny_${id}`);
    // Button labels should clearly say Approve / Deny regardless of emoji.
    expect(String(rows[0][0].text)).toMatch(/Approve/);
    expect(String(rows[0][1].text)).toMatch(/Deny/);
  });

  it('activity-channel post failure is suppressed: approval creation succeeds even when postActivity rejects', async () => {
    postActivitySpy.mockRejectedValueOnce(new Error('activity channel unreachable'));

    // Must NOT throw — approval creation is the primary path, activity
    // channel posting is best-effort. Errors are caught inside
    // postApprovalToActivityChannel so createApproval's await resolves
    // normally even on a rejected post promise.
    const id = await createApproval(paths, 'alice', 'TestOrg', 'Silent-skip test', 'other', 'context', frameworkRoot);

    // The approval file still lands on disk.
    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(true);
  });

  it('REGRESSION GUARD: warns when postActivity returns false (not-configured signal)', async () => {
    // Silent false-return is the observability gap that hid the path
    // resolution bug for hours. If postActivity ever returns false
    // (activity-channel.env missing or unparseable), there must be a
    // visible [approval] warn on stderr. This test locks in the warn.
    postActivitySpy.mockResolvedValueOnce(false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const id = await createApproval(paths, 'alice', 'TestOrg', 'Warn test', 'deployment', 'ctx', frameworkRoot);

    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((w) => w.includes('[approval]') && w.includes(id))).toBe(true);
    // Warn must name the expected path so the operator can fix it.
    expect(warnCalls.some((w) => w.includes('activity-channel.env'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('REGRESSION GUARD: skips activity-channel post with warn when frameworkRoot is unavailable', async () => {
    // The earlier version fell back to paths.ctxRoot when frameworkRoot
    // was missing, silently resolving to the wrong path. That fallback
    // is DELIBERATELY removed — we skip + warn rather than try a
    // known-wrong path. This test locks in that decision.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // No frameworkRoot, no CTX_FRAMEWORK_ROOT env (cleared in beforeEach).
    const id = await createApproval(paths, 'alice', 'TestOrg', 'Skip-with-warn test', 'deployment');

    // postActivity must NEVER have been called — we skipped, not tried.
    expect(postActivitySpy).not.toHaveBeenCalled();

    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((w) => w.includes('[approval]') && w.includes('No frameworkRoot'))).toBe(true);
    // Warn must name the approval id and point operators at the fix path.
    expect(warnCalls.some((w) => w.includes(id))).toBe(true);
    expect(warnCalls.some((w) => w.includes('CTX_FRAMEWORK_ROOT'))).toBe(true);

    // Approval file still lands on disk — missing frameworkRoot is a
    // degradation for the activity-channel fan-out, NOT an approval
    // creation failure.
    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(true);
    warnSpy.mockRestore();
  });

  it('falls back to CTX_FRAMEWORK_ROOT env var when frameworkRoot arg is not passed', async () => {
    // Documents the supported fallback: explicit arg first, then env.
    // Daemon-side callers may rely on the env var; CLI callers should
    // pass explicitly but env-fallback keeps them working if they miss.
    process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

    await createApproval(paths, 'alice', 'TestOrg', 'Env-fallback test', 'deployment', 'ctx');

    expect(postActivitySpy).toHaveBeenCalledTimes(1);
    const [orgDir] = postActivitySpy.mock.calls[0] as [string];
    expect(String(orgDir)).toBe(join(frameworkRoot, 'orgs', 'TestOrg'));
  });

  it('REGRESSION GUARD: postActivity fan-out MUST settle before createApproval returns', async () => {
    // This locks in the fix for the CLI-exit bug shipped in commit 36ae543
    // (the first version of the activity-channel approvals feature). The
    // original code fired postActivity without awaiting, so short-lived
    // callers like the CLI action handler would exit before the fetch
    // completed and the Telegram post silently never sent.
    //
    // Mechanism: mock postActivity with a deferred-resolve promise. Assert
    // that createApproval's returned promise does NOT resolve before the
    // postActivity mock has resolved. If a future refactor restores the
    // fire-and-forget pattern, this test fails because createApproval
    // would resolve immediately while the postActivity promise is still
    // pending.
    let postActivityResolver: (() => void) | undefined;
    const postActivityPromise = new Promise<boolean>((resolve) => {
      postActivityResolver = () => resolve(true);
    });
    postActivitySpy.mockReturnValueOnce(postActivityPromise);

    let createApprovalResolved = false;
    const createApprovalPromise = createApproval(
      paths,
      'alice',
      'TestOrg',
      'Regression test',
      'deployment',
      undefined,
      frameworkRoot,
    ).then((id) => {
      createApprovalResolved = true;
      return id;
    });

    // Let the event loop tick so any synchronous-completing paths finish.
    await new Promise((r) => setImmediate(r));
    // postActivity has been CALLED but the returned promise is still
    // pending. createApproval MUST still be pending too (if it resolved
    // here, that would mean it did not await the fan-out).
    expect(postActivitySpy).toHaveBeenCalledTimes(1);
    expect(createApprovalResolved).toBe(false);

    // Now release the postActivity promise. createApproval should resolve
    // shortly after.
    postActivityResolver!();
    const id = await createApprovalPromise;
    expect(createApprovalResolved).toBe(true);
    expect(id).toMatch(/^approval_\d+_[a-zA-Z0-9]+$/);
  });
});

describe('createApproval — agent-bot Telegram ping (closes 50h+ Repo-B-style stall)', () => {
  // The activity-channel post handles the operator-via-orchestrator UX
  // (Approve/Deny inline buttons), but operators on a per-agent bot would
  // otherwise miss approvals entirely. createApproval also pings the
  // requesting agent's own .env BOT_TOKEN+CHAT_ID so those operators see
  // it on the bot they're actually watching.
  function writeAgentEnv(agentDir: string, vars: Record<string, string>): void {
    mkdirSync(agentDir, { recursive: true });
    const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
    writeFileSync(join(agentDir, '.env'), lines.join('\n') + '\n');
  }

  it('pings the agent bot when agentDir/.env/BOT_TOKEN/CHAT_ID are all present', async () => {
    const agentDir = join(testDir, 'agent-with-bot');
    writeAgentEnv(agentDir, { BOT_TOKEN: 'test-token-123', CHAT_ID: '987654321' });

    const id = await createApproval(
      paths,
      'alice',
      'TestOrg',
      'Deploy to prod',
      'deployment',
      'rationale here',
      frameworkRoot,
      agentDir,
    );

    expect(telegramConstructorSpy).toHaveBeenCalledWith('test-token-123');
    expect(telegramSendMessageSpy).toHaveBeenCalledTimes(1);
    const [chatId, message, , opts] = telegramSendMessageSpy.mock.calls[0] as [
      string,
      string,
      unknown,
      { parseMode: string | null },
    ];
    expect(chatId).toBe('987654321');
    expect(String(message)).toContain('Deploy to prod');
    expect(String(message)).toContain('deployment');
    expect(String(message)).toContain('alice');
    expect(String(message)).toContain(id);
    expect(String(message)).toContain('rationale here');
    // Plain text — must NOT trip Telegram's HTML/Markdown parser on
    // arbitrary approval titles. parseMode: null sends as plain text.
    expect(opts.parseMode).toBeNull();
  });

  it('skips with a warn when agentDir is not provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const id = await createApproval(paths, 'alice', 'TestOrg', 'No agentDir', 'deployment', undefined, frameworkRoot);

    expect(telegramSendMessageSpy).not.toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((w) => w.includes('[approval]') && w.includes('No agentDir') && w.includes(id))).toBe(true);
    warnSpy.mockRestore();
  });

  it('skips silently when the agent .env file is missing (bot-less agent)', async () => {
    // A hermes runtime or pre-onboarding agent has no .env yet. Approval
    // creation must still succeed without a noisy warn — this is the
    // expected steady state, not a misconfiguration.
    const agentDir = join(testDir, 'bot-less-agent');
    mkdirSync(agentDir, { recursive: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createApproval(paths, 'alice', 'TestOrg', 'No env', 'deployment', undefined, frameworkRoot, agentDir);

    expect(telegramSendMessageSpy).not.toHaveBeenCalled();
    // No agent-bot warn for this case (the missing-keys case below DOES warn).
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((w) => w.includes('agent-bot Telegram ping') || w.includes('BOT_TOKEN or CHAT_ID missing'))).toBe(
      false,
    );
    warnSpy.mockRestore();
  });

  it('skips with a warn when BOT_TOKEN is missing from .env', async () => {
    const agentDir = join(testDir, 'agent-missing-token');
    writeAgentEnv(agentDir, { CHAT_ID: '987654321' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const id = await createApproval(paths, 'alice', 'TestOrg', 'Missing token', 'deployment', undefined, frameworkRoot, agentDir);

    expect(telegramSendMessageSpy).not.toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((w) => w.includes('BOT_TOKEN or CHAT_ID missing') && w.includes(id))).toBe(true);
    warnSpy.mockRestore();
  });

  it('skips with a warn when CHAT_ID is missing from .env', async () => {
    const agentDir = join(testDir, 'agent-missing-chat');
    writeAgentEnv(agentDir, { BOT_TOKEN: 'test-token-123' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const id = await createApproval(paths, 'alice', 'TestOrg', 'Missing chat', 'deployment', undefined, frameworkRoot, agentDir);

    expect(telegramSendMessageSpy).not.toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warnCalls.some((w) => w.includes('BOT_TOKEN or CHAT_ID missing') && w.includes(id))).toBe(true);
    warnSpy.mockRestore();
  });

  it('approval creation succeeds even when the Telegram ping rejects (errors suppressed)', async () => {
    // Telegram outage must NEVER block approval creation. The activity
    // channel is best-effort, so is the agent-bot ping.
    const agentDir = join(testDir, 'agent-tg-down');
    writeAgentEnv(agentDir, { BOT_TOKEN: 'test-token-123', CHAT_ID: '987654321' });
    telegramSendMessageSpy.mockRejectedValueOnce(new Error('telegram unreachable'));

    const id = await createApproval(paths, 'alice', 'TestOrg', 'Telegram down', 'deployment', undefined, frameworkRoot, agentDir);

    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(true);
  });

  it('message body includes title, category, agent, id, context, and the orchestrator-chat hint', async () => {
    const agentDir = join(testDir, 'agent-body-test');
    writeAgentEnv(agentDir, { BOT_TOKEN: 'test-token-123', CHAT_ID: '987654321' });

    const id = await createApproval(
      paths,
      'bob',
      'TestOrg',
      'Body shape test',
      'other',
      'detailed context paragraph',
      frameworkRoot,
      agentDir,
    );

    const [, message] = telegramSendMessageSpy.mock.calls[0] as [string, string, unknown, unknown];
    const text = String(message);
    expect(text).toContain('Body shape test');
    expect(text).toContain('other');
    expect(text).toContain('bob');
    expect(text).toContain(id);
    expect(text).toContain('detailed context paragraph');
    // The ping must point operators at the action surface — they cannot
    // act from the per-agent bot, so the body tells them where to go.
    expect(text).toMatch(/orchestrator|dashboard/i);
  });
});

describe('updateApproval (regression guard for activity-channel callback path)', () => {
  it('moves the approval file from pending/ to resolved/ with status+note', async () => {
    // The handleActivityCallback path calls updateApproval with an audit
    // note ("via Telegram activity channel by <user>"). This test
    // regression-guards that updateApproval still produces the exact file
    // shape (move + status + resolved_by note) that the rest of the
    // system expects downstream.
    const id = await createApproval(paths, 'alice', 'TestOrg', 'Test resolve', 'deployment', undefined, frameworkRoot);
    updateApproval(paths, id, 'approved', 'via Telegram activity channel by Alice (@alice)');

    const pendingFile = join(paths.approvalDir, 'pending', `${id}.json`);
    const resolvedFile = join(paths.approvalDir, 'resolved', `${id}.json`);
    expect(existsSync(pendingFile)).toBe(false);
    expect(existsSync(resolvedFile)).toBe(true);

    const approval = JSON.parse(readFileSync(resolvedFile, 'utf-8'));
    expect(approval.status).toBe('approved');
    expect(approval.resolved_by).toBe('via Telegram activity channel by Alice (@alice)');
    expect(approval.resolved_at).toBeTruthy();
  });

  it('throws a clear error when the approval id does not exist', () => {
    expect(() => updateApproval(paths, 'approval_999_nope', 'approved')).toThrow(/not found/);
  });
});

describe('listPendingApprovals', () => {
  it('returns only approvals still in pending/ (not resolved)', async () => {
    const id1 = await createApproval(paths, 'alice', 'TestOrg', 'Still pending', 'deployment', undefined, frameworkRoot);
    const id2 = await createApproval(paths, 'alice', 'TestOrg', 'Will be resolved', 'deployment', undefined, frameworkRoot);
    updateApproval(paths, id2, 'approved');

    const pending = listPendingApprovals(paths);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id1);
  });
});
