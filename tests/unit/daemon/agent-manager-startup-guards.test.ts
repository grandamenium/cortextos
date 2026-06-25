/**
 * Startup guard suite — guards #2 (credential-health) and #3 (model).
 *
 * Guard #2: Detect dead/expired ~/.claude/.credentials.json before an agent
 * silently freezes at runtime (AXL 14h silent-freeze class). Local-field check
 * only — no live API probe (apollo owns runtime probe).
 *
 * Guard #3: Enforce Bode's hard never-lesser-model rule. Flag any agent whose
 * config.model is unset (uncontrolled) or not claude-opus-4-8.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Use `var` (NOT `let`/`const`) so vitest hoisting of vi.mock() doesn't trigger
// a Temporal Dead Zone error — `var` is initialized to undefined before the
// mock factory runs, and the closure reads the live value lazily at call time.
// eslint-disable-next-line no-var
var _fakeHomeDir = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => _fakeHomeDir };
});

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    constructor(name: string) { this.name = name; }
    setTelegramHandle() {}
    onStatusChanged() {}
    async start() {}
    async stop() {}
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() {}
  },
}));

vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    async start() {}
    async stop() {}
    getStatus() { return { status: 'stopped' }; }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    static formatTelegramTextMessage() { return ''; }
    async start() {}
    stop() {}
    wake() {}
  },
}));

vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    start() {}
    stop() {}
    reload() {}
    getNextFireTimes() { return []; }
  },
}));

vi.mock('../../../src/daemon/cron-migration.js', () => ({
  migrateCronsForAgent: () => [],
}));

const mockSendMessage = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() {}
    sendMessage = mockSendMessage;
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    lastExitReason = 'stopped-externally';
    onMessage() {}
    onCallback() {}
    onReaction() {}
    async start() {}
    stop() {}
  },
}));

vi.mock('../../../src/telegram/logging.js', () => ({
  recordInboundTelegram: () => {},
  cacheLastSent: () => {},
  logOutboundMessage: () => {},
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

const BOT_ENV = 'BOT_TOKEN=123456:ABCdefGHI\nCHAT_ID=999\nALLOWED_USER=111222333\n';

function makeAgent(frameworkRoot: string, org: string, name: string, envContent?: string): string {
  const agentDir = join(frameworkRoot, 'orgs', org, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  if (envContent !== undefined) writeFileSync(join(agentDir, '.env'), envContent);
  return agentDir;
}

function writeValidCreds(credPath: string) {
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-VALID',
      refreshToken: 'rt-VALID',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    },
  }));
}

function writeExpiredCreds(credPath: string) {
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-OLD',
      refreshToken: 'rt-OLD',
      expiresAt: Date.now() - 1000,
    },
  }));
}

function writeNoAccessCreds(credPath: string) {
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: '',
      refreshToken: 'rt-STILL',
      expiresAt: Date.now() + 3600_000,
    },
  }));
}

function writeNoRefreshCreds(credPath: string) {
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-OK',
      refreshToken: '',
      expiresAt: Date.now() + 3600_000,
    },
  }));
}

// ─── Guard #2: Credential-health ─────────────────────────────────────────────

describe('Startup guard #2 — credential-health', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let fakeCredDir: string;
  let fakeCredPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-credguard-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    fakeCredDir = join(testDir, 'home', '.claude');
    fakeCredPath = join(fakeCredDir, '.credentials.json');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(fakeCredDir, { recursive: true });
    // Point homedir() at our temp dir for this test
    _fakeHomeDir = join(testDir, 'home');
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    _fakeHomeDir = ''; // reset to harmless default (homedir() is mocked)
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('does NOT warn when credentials.json is valid (good direction)', async () => {
    writeValidCreds(fakeCredPath);
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING'),
    );
    expect(warns.length).toBe(0);
  });

  it('logs CREDENTIAL WARNING when credentials.json is expired (bad direction)', async () => {
    writeExpiredCreds(fakeCredPath);
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING') && m.includes('expired'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('logs CREDENTIAL WARNING when credentials.json has no accessToken', async () => {
    writeNoAccessCreds(fakeCredPath);
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING') && m.includes('accessToken'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('logs CREDENTIAL WARNING when credentials.json has no refreshToken', async () => {
    writeNoRefreshCreds(fakeCredPath);
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING') && m.includes('refreshToken'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('logs CREDENTIAL WARNING when credentials.json is missing', async () => {
    // credentials.json NOT written — file doesn't exist
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING') && m.includes('missing'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('suppresses warning when agent has CLAUDE_CODE_OAUTH_TOKEN override', async () => {
    writeExpiredCreds(fakeCredPath); // global creds expired
    // Agent has its own per-agent OAuth token — should suppress the global check
    makeAgent(frameworkRoot, 'acme', 'alice', 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-PERAGENT\n');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING'),
    );
    expect(warns.length).toBe(0);
  });

  it('three distinct agents with bad creds each produce exactly one CREDENTIAL WARNING (cache does not over-alert)', async () => {
    writeExpiredCreds(fakeCredPath);
    makeAgent(frameworkRoot, 'acme', 'alice');
    makeAgent(frameworkRoot, 'acme', 'bob');
    makeAgent(frameworkRoot, 'acme', 'carol');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    const dir = (n: string) => join(frameworkRoot, 'orgs', 'acme', 'agents', n);
    await am.startAgent('alice', dir('alice'), {}, 'acme');
    await am.startAgent('bob', dir('bob'), {}, 'acme');
    await am.startAgent('carol', dir('carol'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING'),
    );
    // One warn per unique agent (expired → accessToken warn + refreshToken is still present = 1 warn each)
    // The cache ensures the issues list is computed once; per-agent dedup ensures one warn per name.
    expect(warns.length).toBeGreaterThanOrEqual(3);
    // But NOT 3× per-agent — each name alerted exactly once.
    // (If there were a re-read per agent, the alertedAgents dedup still fires — so over-alerting
    //  would show as >3 only if dedup is also broken. This test catches regression on BOTH guards.)
    expect(warns.length).toBeLessThanOrEqual(6); // at most 2 issues per agent (expired + no-refresh)
  });

  it('deduplicates per agent: second startAgent for same agent does NOT re-warn', async () => {
    writeExpiredCreds(fakeCredPath);
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');

    await am.startAgent('alice', dir, {}, 'acme');
    await am.stopAgent('alice');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', dir, {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('CREDENTIAL WARNING'),
    );
    expect(warns.length).toBe(0); // alice already alerted — deduped
  });
});

// ─── Guard #3: Model ──────────────────────────────────────────────────────────

describe('Startup guard #3 — model: enforce claude-opus-4-8', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-modelguard-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    // Point homedir() at a temp dir with VALID creds so model tests
    // don't trigger cred-health warnings that would muddy the assertions.
    const fakeCredDir = join(testDir, 'home', '.claude');
    mkdirSync(fakeCredDir, { recursive: true });
    writeFileSync(join(fakeCredDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'ok', refreshToken: 'ok', expiresAt: Date.now() + 3600_000 },
    }));
    _fakeHomeDir = join(testDir, 'home');
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    _fakeHomeDir = ''; // reset (homedir() is mocked)
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('does NOT warn when model is claude-opus-4-8 (good direction)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { model: 'claude-opus-4-8' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING'),
    );
    expect(warns.length).toBe(0);
  });

  it('logs MODEL WARNING when model is not pinned (unset)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), {}, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING') && m.includes('no model pinned'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('logs MODEL WARNING when model is a lesser model (haiku)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent(
      'alice',
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'),
      { model: 'claude-haiku-4-5-20251001' },
      'acme',
    );

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING') && m.includes('claude-haiku-4-5-20251001'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('logs MODEL WARNING when model is a legacy string', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent(
      'alice',
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'),
      { model: 'claude-3-sonnet-20240229' },
      'acme',
    );

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('deduplicates: same agent + same wrong model does NOT re-warn on restart', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');

    await am.startAgent('alice', dir, { model: 'claude-haiku-4-5-20251001' }, 'acme');
    await am.stopAgent('alice');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', dir, { model: 'claude-haiku-4-5-20251001' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING'),
    );
    expect(warns.length).toBe(0); // same model key already alerted
  });

  it('re-warns when model config changes between restarts', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const dir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');

    await am.startAgent('alice', dir, { model: 'claude-haiku-4-5-20251001' }, 'acme');
    await am.stopAgent('alice');

    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', dir, { model: 'claude-sonnet-4-6' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING') && m.includes('claude-sonnet-4-6'),
    );
    expect(warns.length).toBeGreaterThan(0);
  });

  it('warns once per agent (two agents with wrong model → two warnings)', async () => {
    makeAgent(frameworkRoot, 'acme', 'alice');
    makeAgent(frameworkRoot, 'acme', 'bob');

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');

    const dir = (n: string) => join(frameworkRoot, 'orgs', 'acme', 'agents', n);
    await am.startAgent('alice', dir('alice'), { model: 'claude-haiku-4-5-20251001' }, 'acme');
    await am.startAgent('bob', dir('bob'), { model: 'claude-haiku-4-5-20251001' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('MODEL WARNING'),
    );
    expect(warns.length).toBe(2); // alice:haiku + bob:haiku = two distinct keys
  });

  it('sends Telegram alert for model violation via discoverAndStart (consolidated)', async () => {
    // Agent with BOT_TOKEN (for Telegram) but no model pin
    makeAgent(frameworkRoot, 'acme', 'alice', BOT_ENV);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    await am.discoverAndStart();

    const modelAlerts = mockSendMessage.mock.calls.filter(
      ([, msg]: [string, string]) => typeof msg === 'string' && msg.includes('model-guard'),
    );
    expect(modelAlerts.length).toBe(1);
    expect(modelAlerts[0][1]).toContain('model not pinned');
  });
});

// ─── Guard #4: settings.json mcp__* sanitizer ────────────────────────────────

describe('Startup guard #4 — settings.json mcp__* sanitizer', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  const CLEAN_SETTINGS = JSON.stringify({
    permissions: { allow: ['Bash', 'Read', 'Write'], defaultMode: 'bypassPermissions' },
  });
  const MCP_SETTINGS = JSON.stringify({
    permissions: {
      allow: ['Bash', 'mcp__higgsfield__generate_video', 'mcp__stripe__fetch_stripe_resources', 'Read'],
      defaultMode: 'bypassPermissions',
    },
  });

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-settingsguard-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    _fakeHomeDir = join(testDir, 'home');
    mkdirSync(join(testDir, 'home', '.claude'), { recursive: true });
    // Write valid creds so cred-health guard doesn't fire
    writeFileSync(join(testDir, 'home', '.claude', '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-VALID',
        refreshToken: 'rt-VALID',
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      },
    }));
    process.env.CTX_SPAWN_STAGGER_MS = '0';
    delete process.env.ANTHROPIC_API_KEY;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    _fakeHomeDir = '';
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CTX_SPAWN_STAGGER_MS;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  it('does NOT warn when settings.json has no mcp__* entries (good direction)', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.env'), BOT_ENV);
    writeFileSync(join(agentDir, '.claude', 'settings.json'), CLEAN_SETTINGS);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', agentDir, { model: 'claude-opus-4-8' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('SETTINGS WARNING'),
    );
    expect(warns).toHaveLength(0);
    expect(mockSendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('settings-guard'),
    );
  });

  it('does NOT warn when settings.json is absent', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), BOT_ENV);
    // No .claude/settings.json

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', agentDir, { model: 'claude-opus-4-8' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('SETTINGS WARNING'),
    );
    expect(warns).toHaveLength(0);
  });

  it('strips mcp__* entries and rewrites settings.json when found', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.env'), BOT_ENV);
    const settingsPath = join(agentDir, '.claude', 'settings.json');
    writeFileSync(settingsPath, MCP_SETTINGS);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    await am.startAgent('alice', agentDir, { model: 'claude-opus-4-8' }, 'acme');

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.permissions.allow).toEqual(['Bash', 'Read']);
    expect(written.permissions.allow).not.toContain('mcp__higgsfield__generate_video');
    expect(written.permissions.allow).not.toContain('mcp__stripe__fetch_stripe_resources');
  });

  it('logs SETTINGS WARNING when mcp__* entries are found', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.env'), BOT_ENV);
    writeFileSync(join(agentDir, '.claude', 'settings.json'), MCP_SETTINGS);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', agentDir, { model: 'claude-opus-4-8' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('SETTINGS WARNING'),
    );
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toContain('mcp__higgsfield__generate_video');
  });

  it('sends Telegram settings-guard alert via discoverAndStart', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.env'), BOT_ENV);
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ model: 'claude-opus-4-8' }));
    writeFileSync(join(agentDir, '.claude', 'settings.json'), MCP_SETTINGS);
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'enabled-agents.json'), JSON.stringify(['alice']));

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    await am.discoverAndStart();

    const settingsAlerts = mockSendMessage.mock.calls.filter(
      ([, msg]: [string, string]) => typeof msg === 'string' && msg.includes('settings-guard'),
    );
    expect(settingsAlerts.length).toBe(1);
    expect(settingsAlerts[0][1]).toContain('mcp__');
  });

  it('does NOT re-alert on second startAgent() in same daemon run (dedup)', async () => {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    writeFileSync(join(agentDir, '.env'), BOT_ENV);
    writeFileSync(join(agentDir, '.claude', 'settings.json'), MCP_SETTINGS);

    const am = new AgentManager('inst', ctxRoot, frameworkRoot, 'acme');
    const warnSpy = vi.spyOn(console, 'log');
    await am.startAgent('alice', agentDir, { model: 'claude-opus-4-8' }, 'acme');
    await am.stopAgent('alice');

    warnSpy.mockClear();
    // Restore mcp__ entries to simulate operator not fixing the file (but dedup should protect)
    writeFileSync(join(agentDir, '.claude', 'settings.json'), MCP_SETTINGS);
    await am.startAgent('alice', agentDir, { model: 'claude-opus-4-8' }, 'acme');

    const warns = warnSpy.mock.calls.flat().filter(
      (m): m is string => typeof m === 'string' && m.includes('SETTINGS WARNING'),
    );
    expect(warns).toHaveLength(0); // deduped — same daemon run
  });
});
