/**
 * ANTHROPIC_API_KEY startup guard tests.
 *
 * Verifies that the daemon emits LOUD warnings (both directions) when a stray
 * ANTHROPIC_API_KEY is found in any of the three sources it injects into agents:
 *   1. agent .env
 *   2. org secrets.env
 *   3. process.env (daemon launch environment)
 *
 * Also verifies:
 * - secrets.env alert fires ONCE per path even with multiple agents in the org
 * - process.env alert fires once per daemon lifetime
 * - No warning when key is absent (clean direction)
 * - ONE consolidated Telegram alert sent when a bot is configured
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub AgentProcess so no PTY or node-pty is loaded.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    constructor(name: string) { this.name = name; }
    setTelegramHandle() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));

// Stub WorkerProcess.
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { status: 'stopped' }; }
  },
}));

// Stub FastChecker.
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    static formatTelegramTextMessage() { return ''; }
    async start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
  },
}));

// Stub CronScheduler.
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));

// Stub cron-migration — not needed in guard tests.
vi.mock('../../../src/daemon/cron-migration.js', () => ({
  migrateCronsForAgent: () => [],
}));

// TelegramAPI with a sendMessage stub we can spy on.
const mockSendMessage = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
    sendMessage = mockSendMessage;
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason = 'stopped-externally';
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
    async start() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

// Stub Telegram logging helpers.
vi.mock('../../../src/telegram/logging.js', () => ({
  recordInboundTelegram: () => { /* no-op */ },
  cacheLastSent: () => { /* no-op */ },
  logOutboundMessage: () => { /* no-op */ },
  buildRecentHistory: () => '',
}));

vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: () => Promise.resolve(),
}));

vi.mock('../../../src/telegram/media.js', () => ({
  processMediaMessage: () => Promise.resolve(null),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

/** Build a minimal agent directory with the given .env content. */
function makeAgent(frameworkRoot: string, org: string, name: string, envContent?: string): string {
  const agentDir = join(frameworkRoot, 'orgs', org, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  if (envContent !== undefined) {
    writeFileSync(join(agentDir, '.env'), envContent);
  }
  return agentDir;
}

/** Minimal valid bot .env (BOT_TOKEN + CHAT_ID + ALLOWED_USER). */
const BOT_ENV = 'BOT_TOKEN=123456:ABCdefGHI\nCHAT_ID=999\nALLOWED_USER=111222333\n';

describe('ANTHROPIC_API_KEY startup guard — agent .env', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-guard-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('logs SECURITY WARNING when ANTHROPIC_API_KEY is in agent .env (bad direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV + 'ANTHROPIC_API_KEY=sk-ant-TEST\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('alice'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does NOT warn when ANTHROPIC_API_KEY is absent from agent .env (good direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(warnings.length).toBe(0);
  });

  it('deduplicates: second startAgent for same agent does NOT re-warn', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice', 'ANTHROPIC_API_KEY=sk-ant-DUPE\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    await am.startAgent('alice', dir, {}, 'acme');
    warnSpy.mockClear();
    await am.startAgent('alice', dir, {}, 'acme');

    // Second call: same .env path already in alertedPaths — no new warning
    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(warnings.length).toBe(0);
  });
});

describe('ANTHROPIC_API_KEY startup guard — org secrets.env', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-secrets-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('logs SECURITY WARNING when ANTHROPIC_API_KEY is in org secrets.env (bad direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'secrets.env'), 'ANTHROPIC_API_KEY=sk-ant-ORG\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('secrets.env'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does NOT warn when ANTHROPIC_API_KEY is absent from org secrets.env (good direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'secrets.env'), 'GEMINI_API_KEY=fake-gemini\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(warnings.length).toBe(0);
  });

  it('deduplicates: multiple agents sharing same secrets.env → only ONE warning', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    makeAgent(frameworkRoot, 'acme', 'bob');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'secrets.env'), 'ANTHROPIC_API_KEY=sk-ant-ORG\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    const dir = (name: string) => join(frameworkRoot, 'orgs', 'acme', 'agents', name);
    await am.startAgent('alice', dir('alice'), {}, 'acme');
    await am.startAgent('bob', dir('bob'), {}, 'acme');

    const secretsWarnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('secrets.env'),
    );
    // alice triggers the check; bob's startAgent should see path in alertedPaths → skip
    expect(secretsWarnings.length).toBe(1);
  });
});

describe('ANTHROPIC_API_KEY startup guard — process.env', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-procenv-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('logs SECURITY WARNING when ANTHROPIC_API_KEY is in process.env (bad direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-PROC';

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('process.env'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does NOT warn when ANTHROPIC_API_KEY is absent from process.env (good direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    // process.env.ANTHROPIC_API_KEY is deleted in beforeEach

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('process.env'),
    );
    expect(warnings.length).toBe(0);
  });

  it('deduplicates: two agents in same daemon, process.env set → only ONE warning', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    makeAgent(frameworkRoot, 'acme', 'bob');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-DUPE';

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    const dir = (name: string) => join(frameworkRoot, 'orgs', 'acme', 'agents', name);
    await am.startAgent('alice', dir('alice'), {}, 'acme');
    await am.startAgent('bob', dir('bob'), {}, 'acme');

    const procWarnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('process.env'),
    );
    expect(procWarnings.length).toBe(1);
  });
});

describe('ANTHROPIC_API_KEY startup guard — consolidated Telegram alert', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-telegram-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('sends ONE consolidated Telegram alert via discoverAndStart when key found in agent .env', async () => {
    // Agent with both BOT_TOKEN (for Telegram) and ANTHROPIC_API_KEY (stray)
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV + 'ANTHROPIC_API_KEY=sk-ant-TEST\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    await am.discoverAndStart();

    // Should have sent exactly one Telegram alert (not multiple per source)
    const apiKeyCalls = mockSendMessage.mock.calls.filter(
      ([_chatId, msg]: [string, string]) => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(apiKeyCalls.length).toBe(1);
    // Alert should name the source
    expect(apiKeyCalls[0][1]).toContain('agent .env');
  });

  it('sends NO Telegram alert when ANTHROPIC_API_KEY is absent (good direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    await am.discoverAndStart();

    const apiKeyCalls = mockSendMessage.mock.calls.filter(
      ([_chatId, msg]: [string, string]) => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(apiKeyCalls.length).toBe(0);
  });
});

// H1 fix: space-before-equals evasion
describe('ANTHROPIC_API_KEY startup guard — H1 fix: space-before-equals', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-h1-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('detects ANTHROPIC_API_KEY with space before = in agent .env (H1 fix)', async () => {
    // agent-pty.ts strips surrounding spaces from key names via .trim(),
    // so `ANTHROPIC_API_KEY =value` IS injected into the agent. Guard must match it.
    makeAgent(frameworkRoot, 'acme', 'alice', 'ANTHROPIC_API_KEY =sk-ant-SPACE\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('detects ANTHROPIC_API_KEY with spaces around = in secrets.env (H1 fix)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'secrets.env'), 'ANTHROPIC_API_KEY = sk-ant-BOTH\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warnings = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('secrets.env'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// H2 fix: secrets.env path not permanently blinded by transient read failure
describe('ANTHROPIC_API_KEY startup guard — H2 fix: transient-unread does not blind guard', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-h2-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('detects key after a previous clean read (path not pre-marked, retried on next call)', async () => {
    // First call: secrets.env has no key → path NOT added to alertedPaths (H2 fix:
    // path is only marked when key IS found, so clean reads stay unmarked).
    // Second call (after stop+key-add): guard re-reads and detects the new key.
    makeAgent(frameworkRoot, 'acme', 'alice');
    const secretsPath = join(frameworkRoot, 'orgs', 'acme', 'secrets.env');
    writeFileSync(secretsPath, 'GEMINI_API_KEY=other\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');

    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', dir, {}, 'acme');
    const warningsAfterClean = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(warningsAfterClean.length).toBe(0); // clean pass

    // Stop the agent, add the stray key, then restart (simulates IPC restart post-boot)
    await am.stopAgent('alice');
    writeFileSync(secretsPath, 'ANTHROPIC_API_KEY=sk-ant-ADDED\n');
    warnSpy.mockClear();
    await am.startAgent('alice', dir, {}, 'acme');

    const warningsAfterAdd = warnSpy.mock.calls.flat().filter(
      (msg): msg is string => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY') && msg.includes('secrets.env'),
    );
    expect(warningsAfterAdd.length).toBeGreaterThan(0); // detected on retry ✓
  });
});

// H3 fix: IPC/dashboard restart post-boot flushes Telegram immediately
describe('ANTHROPIC_API_KEY startup guard — H3 fix: IPC restart Telegram alert', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-apikey-h3-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('sends Telegram immediately on IPC startAgent (not in discoverAndStart) when key found', async () => {
    // IPC restart scenario: startAgent called directly, NOT via discoverAndStart.
    // The guard detects the key and must flush Telegram immediately without waiting
    // for discoverAndStart() to run (it won't run again after boot).
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV + 'ANTHROPIC_API_KEY=sk-ant-IPC\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    // Direct call — NOT via discoverAndStart (inDiscoverAndStart stays false)
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const apiKeyCalls = mockSendMessage.mock.calls.filter(
      ([_chatId, msg]: [string, string]) => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    // Must have fired immediately (not deferred to discoverAndStart)
    expect(apiKeyCalls.length).toBe(1);
    expect(apiKeyCalls[0][1]).toContain('agent .env');
  });

  it('does NOT send Telegram during discoverAndStart sweep (deferred to end)', async () => {
    // During the startup sweep (inDiscoverAndStart=true), startAgent() must NOT
    // send per-agent Telegrams — only the consolidated one at the end fires.
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV + 'ANTHROPIC_API_KEY=sk-ant-SWEEP\n');
    makeAgent(frameworkRoot, 'acme', 'bob', 'ANTHROPIC_API_KEY=sk-ant-BOB\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');

    // Intercept startAgent calls to count mid-sweep Telegram sends
    const sendCounts: number[] = [];
    const originalStart = am.startAgent.bind(am);
    vi.spyOn(am, 'startAgent').mockImplementation(async (...args) => {
      const before = mockSendMessage.mock.calls.filter(
        ([, msg]: [string, string]) => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
      ).length;
      await originalStart(...args as Parameters<typeof am.startAgent>);
      const after = mockSendMessage.mock.calls.filter(
        ([, msg]: [string, string]) => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
      ).length;
      sendCounts.push(after - before); // 0 = no mid-sweep send for this agent
    });

    await am.discoverAndStart();

    // Each individual startAgent() call during the sweep must NOT have sent Telegram
    expect(sendCounts.every(n => n === 0)).toBe(true);
    // But the consolidated alert at end of discoverAndStart MUST have fired
    const totalApiKeyCalls = mockSendMessage.mock.calls.filter(
      ([, msg]: [string, string]) => typeof msg === 'string' && msg.includes('ANTHROPIC_API_KEY'),
    );
    expect(totalApiKeyCalls.length).toBe(1);
  });
});
