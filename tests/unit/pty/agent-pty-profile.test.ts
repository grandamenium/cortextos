/**
 * BL-2026-05-08-003 phase 1 — claude_profile + env wiring in agent-pty.
 *
 * Verifies the spawn-time resolution chain:
 *   config.claude_profile → orgs/<org>/profiles.json → CLAUDE_CONFIG_DIR
 *   config.env → applied AFTER profile resolution (explicit overrides).
 *
 * Asserts on the env dict actually passed to node-pty's spawn, not on
 * intermediate state — that's the contract the spawned Claude reads.
 *
 * AgentPTY uses a CommonJS `require('node-pty')` lazy-load that bypasses
 * vitest's ESM mock. We work around by injecting a fake spawn function
 * directly into the private `spawnFn` field BEFORE calling spawn() —
 * the constructor leaves it null and the lazy-require only fires when
 * still null at spawn time. Cleaner than monkey-patching require() and
 * keeps the test isolated from node-pty's native addon.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let lastSpawnEnv: Record<string, string> | undefined;
const fakeSpawn = (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
  lastSpawnEnv = opts.env;
  return {
    pid: 99,
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  };
};

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

function makePty(env: ReturnType<typeof makeEnv>, config: object): InstanceType<typeof AgentPTY> {
  const pty = new AgentPTY(env, config as Parameters<typeof AgentPTY.prototype.constructor>[1]);
  (pty as unknown as { spawnFn: typeof fakeSpawn }).spawnFn = fakeSpawn;
  return pty;
}

let projectRoot: string;

function makeEnv() {
  return {
    instanceId: 'test',
    ctxRoot: '/tmp/ctx',
    frameworkRoot: projectRoot,
    agentName: 'engineer',
    agentDir: join(projectRoot, 'orgs', 'sb-personal', 'agents', 'engineer'),
    org: 'sb-personal',
    projectRoot,
  };
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agent-pty-profile-'));
  mkdirSync(join(projectRoot, 'orgs', 'sb-personal', 'agents', 'engineer'), { recursive: true });
  lastSpawnEnv = undefined;
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeProfilesJson(contents: object): void {
  writeFileSync(
    join(projectRoot, 'orgs', 'sb-personal', 'profiles.json'),
    JSON.stringify(contents),
    'utf-8',
  );
}

describe('AgentPTY claude_profile resolution', () => {
  it('sets CLAUDE_CONFIG_DIR from the agent config.claude_profile', async () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: {
        personal: { config_dir: '/Users/x/.claude' },
        work: { config_dir: '/Users/x/.claude-work' },
      },
    });
    const pty = makePty(makeEnv(), { claude_profile: 'work' });
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CONFIG_DIR']).toBe('/Users/x/.claude-work');
  });

  it('falls back to default_profile when config.claude_profile is unset', async () => {
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/Users/x/.claude' } },
    });
    const pty = makePty(makeEnv(), {});
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CONFIG_DIR']).toBe('/Users/x/.claude');
  });

  it('writes no CLAUDE_CONFIG_DIR when registry is missing (preserves pre-BL-003 behaviour)', async () => {
    const pty = makePty(makeEnv(), { claude_profile: 'work' });
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('writes no CLAUDE_CONFIG_DIR when registry is malformed', async () => {
    writeFileSync(
      join(projectRoot, 'orgs', 'sb-personal', 'profiles.json'),
      'not json {{{',
      'utf-8',
    );
    const pty = makePty(makeEnv(), { claude_profile: 'work' });
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('writes no CLAUDE_CONFIG_DIR when claude_profile is dangling', async () => {
    // Don't silently fall back to default — the operator explicitly
    // named a profile, so the safe move is "no override" rather than
    // "different override than asked for". Doctor surfaces the
    // dangling reference at fleet boot.
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/Users/x/.claude' } },
    });
    const pty = makePty(makeEnv(), { claude_profile: 'enterprise' });
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });
});

describe('AgentPTY config.env passthrough', () => {
  it('applies arbitrary env values from config.env', async () => {
    const pty = makePty(makeEnv(), {
      env: { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: 'true', FOO: 'bar' },
    });
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING']).toBe('true');
    expect(lastSpawnEnv?.['FOO']).toBe('bar');
  });

  it('config.env overrides profile-resolved CLAUDE_CONFIG_DIR (explicit > registry)', async () => {
    // Order matters: the registry resolution lands first, then env
    // applies. A config.env CLAUDE_CONFIG_DIR is the "I know what I'm
    // doing" escape hatch — useful for one-off testing without
    // editing profiles.json. Documented in the AgentConfig.env JSDoc.
    writeProfilesJson({
      default_profile: 'personal',
      profiles: { personal: { config_dir: '/Users/x/.claude' } },
    });
    const pty = makePty(makeEnv(), {
      claude_profile: 'personal',
      env: { CLAUDE_CONFIG_DIR: '/tmp/override' },
    });
    await pty.spawn('fresh', 'hi');
    expect(lastSpawnEnv?.['CLAUDE_CONFIG_DIR']).toBe('/tmp/override');
  });
});
