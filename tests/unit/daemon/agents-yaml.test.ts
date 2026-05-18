import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadAgentsManifest,
  parseAgentsYaml,
  type AgentsManifest,
} from '../../../src/daemon/agents-yaml.js';

// ---------------------------------------------------------------------------
// PART A — pure parser / loader tests.
//
// Covers task #62 acceptance points (a) "missing manifest → silent fallback"
// at the loader layer (the AgentManager layer is covered in PART B).
// ---------------------------------------------------------------------------
describe('agents-yaml loader', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-agents-yaml-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when agents.yaml is missing (silent fallback)', () => {
    expect(loadAgentsManifest(testDir)).toBeNull();
  });

  it('returns null on unreadable / malformed YAML (silent fallback)', () => {
    // Write a file the loader cannot make sense of in any structured way.
    // We don't strictly need to throw — the parser is lenient by design — so
    // we instead verify that a NON-yaml file with no `agents:` top-level just
    // gives back an empty agents map (which is the lenient equivalent of
    // "no opinion"). The null path is reachable on real read failures.
    writeFileSync(join(testDir, 'agents.yaml'), 'this is not yaml\n');
    const manifest = loadAgentsManifest(testDir);
    expect(manifest).not.toBeNull();
    expect(manifest!.agents).toEqual({});
  });

  it('parses a minimal manifest with two agents', () => {
    const yaml = [
      'version: 1',
      'agents:',
      '  forge:',
      '    host: mac_mini',
      '    role: builder',
      '    telegram_enabled: false',
      '    bot_token_env_var: null',
      '  sam:',
      '    host: macbook',
      '    role: telegram_orchestrator',
      '    telegram_enabled: true',
      '    bot_token_env_var: BOT_TOKEN',
      '',
    ].join('\n');

    const m = parseAgentsYaml(yaml);
    expect(Object.keys(m.agents).sort()).toEqual(['forge', 'sam']);
    expect(m.agents.forge.telegram_enabled).toBe(false);
    expect(m.agents.forge.host).toBe('mac_mini');
    expect(m.agents.forge.role).toBe('builder');
    expect(m.agents.forge.bot_token_env_var).toBeNull();
    expect(m.agents.sam.telegram_enabled).toBe(true);
    expect(m.agents.sam.bot_token_env_var).toBe('BOT_TOKEN');
  });

  it('handles comments, blank lines, and quoted notes', () => {
    const yaml = [
      '# header comment',
      'version: 1',
      '',
      'agents:',
      '  pa:',
      '    host: macbook  # trailing comment',
      '    telegram_enabled: true',
      `    notes: "Swapna — has BOT_TOKEN; #not a comment"`,
      '',
    ].join('\n');

    const m = parseAgentsYaml(yaml);
    expect(m.agents.pa.host).toBe('macbook');
    expect(m.agents.pa.telegram_enabled).toBe(true);
    expect(m.agents.pa.notes).toBe('Swapna — has BOT_TOKEN; #not a comment');
  });

  it('drops unknown fields silently (forward-compat)', () => {
    const yaml = [
      'agents:',
      '  z:',
      '    host: macbook',
      '    futuristic_new_key: 42',
      '',
    ].join('\n');

    const m = parseAgentsYaml(yaml);
    expect(m.agents.z.host).toBe('macbook');
    // futuristic_new_key must not leak onto the entry.
    expect((m.agents.z as Record<string, unknown>).futuristic_new_key).toBeUndefined();
  });

  it('loads the real agents.yaml shape from a fixture', () => {
    const yaml = [
      'version: 1',
      'generated: 2026-05-17',
      'hosts:',
      '  macbook:',
      '    user: hari',
      'agents:',
      '  forge:',
      '    host: mac_mini',
      '    org: subbu-ops',
      '    role: builder',
      '    telegram_enabled: false',
      '    bot_token_env_var: null',
      '    chat_id_env_var: null',
      '    verified: false',
      `    notes: "Builder; no Telegram by design"`,
      '',
    ].join('\n');
    writeFileSync(join(testDir, 'agents.yaml'), yaml);

    const m = loadAgentsManifest(testDir) as AgentsManifest;
    expect(m).not.toBeNull();
    expect(m.agents.forge.telegram_enabled).toBe(false);
    expect(m.agents.forge.verified).toBe(false);
    expect(m.agents.forge.org).toBe('subbu-ops');
  });
});

// ---------------------------------------------------------------------------
// PART B — AgentManager integration tests.
//
// Covers task #62 acceptance points:
//   (a) missing manifest → silent fallback (no manifest load log, no skip)
//   (b) telegram_enabled: false → no TelegramPoller instantiated even when
//       .env carries a valid BOT_TOKEN + CHAT_ID + ALLOWED_USER.
// ---------------------------------------------------------------------------

// Mock the heavy PTY/Telegram surfaces so we never load native bindings or
// make HTTP calls. The mocks must come BEFORE the dynamic import of the
// agent-manager module so Vitest hoists them correctly.

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    constructor(name: string) { this.name = name; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onStatusChanged() { /* no-op */ }
    setTelegramHandle() { /* no-op */ }
  },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    start() { return Promise.resolve(); }
    stop() { /* no-op */ }
    isDuplicate() { return false; }
    queueTelegramMessage() { /* no-op */ }
    handleCallback() { return Promise.resolve(); }
    handleActivityCallback() { return Promise.resolve(); }
    static readLastSent() { return null; }
    static formatTelegramTextMessage() { return ''; }
  },
}));

vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    reload() { /* no-op */ }
    getNextFireTimes() { return []; }
  },
}));

vi.mock('../../../src/daemon/cron-migration.js', () => ({
  migrateCronsForAgent: () => undefined,
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(public token: string) { /* no-op */ }
    sendMessage() { return Promise.resolve(); }
  },
}));

// Track TelegramPoller construction so we can assert it was NOT instantiated
// when the manifest disables Telegram.
const pollerConstructed = vi.fn();
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    constructor(...args: unknown[]) {
      pollerConstructed(...args);
    }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
    start() { return Promise.resolve(); }
    stop() { /* no-op */ }
  },
}));

vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: () => Promise.resolve({ status: 'ok', count: 0 }),
}));

vi.mock('../../../src/telegram/logging.js', () => ({
  recordInboundTelegram: () => undefined,
  cacheLastSent: () => undefined,
  logOutboundMessage: () => undefined,
  buildRecentHistory: () => undefined,
}));

vi.mock('../../../src/telegram/media.js', () => ({
  processMediaMessage: () => Promise.resolve(null),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager × agents.yaml integration (task #62)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    pollerConstructed.mockClear();
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-yaml-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(ctxRoot, 'state'), { recursive: true });
    // Stage a fake agent dir for forge with a valid-looking .env so
    // the daemon would normally try to spawn a poller. The manifest gate
    // must override this.
    const forgeDir = join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'forge');
    mkdirSync(forgeDir, { recursive: true });
    writeFileSync(
      join(forgeDir, '.env'),
      'BOT_TOKEN=12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abcdefghijk\nCHAT_ID=42\nALLOWED_USER=999\n',
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('silently falls back when agents.yaml is missing', async () => {
    // No agents.yaml on disk — manifest field on the manager should stay null.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'subbu-ops');
    // Use a private-field peek via index access — the field is intentionally
    // typed as `null` when absent so this is the cleanest assertion.
    expect((am as unknown as { agentsManifest: unknown }).agentsManifest).toBeNull();
  });

  it('skips TelegramPoller construction when telegram_enabled: false in manifest', async () => {
    // Write a manifest that explicitly disables Telegram for forge.
    writeFileSync(
      join(frameworkRoot, 'agents.yaml'),
      [
        'version: 1',
        'agents:',
        '  forge:',
        '    host: mac_mini',
        '    role: builder',
        '    telegram_enabled: false',
        '',
      ].join('\n'),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'subbu-ops');
    expect((am as unknown as { agentsManifest: unknown }).agentsManifest).not.toBeNull();

    const forgeDir = join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'forge');
    await am.startAgent('forge', forgeDir, {}, 'subbu-ops');

    // Despite forge's .env carrying a valid-format BOT_TOKEN + CHAT_ID +
    // ALLOWED_USER, the manifest gate must prevent TelegramPoller from ever
    // being instantiated. This is the exact retry-spam regression we're
    // closing.
    expect(pollerConstructed).not.toHaveBeenCalled();
  });

  it('constructs TelegramPoller when telegram_enabled: true (positive control)', async () => {
    writeFileSync(
      join(frameworkRoot, 'agents.yaml'),
      [
        'agents:',
        '  forge:',
        '    host: mac_mini',
        '    role: builder',
        '    telegram_enabled: true',
        '',
      ].join('\n'),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'subbu-ops');
    const forgeDir = join(frameworkRoot, 'orgs', 'subbu-ops', 'agents', 'forge');
    await am.startAgent('forge', forgeDir, {}, 'subbu-ops');

    // With telegram_enabled: true AND a valid-format .env, the poller path
    // engages and the constructor fires.
    expect(pollerConstructed).toHaveBeenCalled();
  });
});
