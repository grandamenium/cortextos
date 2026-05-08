/**
 * tests/integration/context-update-cli.test.ts
 *
 * Drives `cortextos bus context-update` as a real subprocess and asserts on
 * the JSON file that downstream consumers (heartbeat scripts, dashboard) will
 * read. Per code-quality.md: "Integration tests must read the artifact the
 * production consumer reads, not just the side-channel state the test wrote."
 *
 * The test sets up a fake Claude Code projects directory with a synthetic
 * transcript, runs the built CLI, then verifies (a) the context-pct.json
 * file was written with correct content, and (b) a context_threshold_crossed
 * event was logged when severity is non-green.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli.js');

function runBus(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI_ENTRY, 'bus', ...args], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: any) {
    return {
      stdout: typeof e?.stdout === 'string' ? e.stdout : (e?.stdout?.toString?.() ?? ''),
      stderr: typeof e?.stderr === 'string' ? e.stderr : (e?.stderr?.toString?.() ?? ''),
      code: typeof e?.status === 'number' ? e.status : 1,
    };
  }
}

describe('cortextos bus context-update (integration)', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let ctxRoot: string;
  let projectsRoot: string;
  let agentCwd: string;
  let projectDir: string;

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry missing at ${CLI_ENTRY}; run \`npm run build\` before integration tests.`);
    }
  });

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cortextos-context-cli-'));
    // resolvePaths() ignores CTX_ROOT and computes paths from homedir() + instanceId.
    // We override HOME so the CLI's writes land inside tmpRoot, not the user's real ~/.cortextos.
    fakeHome = join(tmpRoot, 'home');
    ctxRoot = join(fakeHome, '.cortextos', 'default');
    projectsRoot = join(tmpRoot, 'claude-projects');
    agentCwd = join(tmpRoot, 'work', 'agent-fullstack');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(ctxRoot, { recursive: true });
    mkdirSync(projectsRoot, { recursive: true });
    mkdirSync(agentCwd, { recursive: true });
    projectDir = join(projectsRoot, agentCwd.replace(/\//g, '-'));
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeTranscript(rawUsage: { input: number; cache_creation: number; cache_read: number }, model = 'claude-opus-4-7'): string {
    const tp = join(projectDir, 'session.jsonl');
    const obj = {
      type: 'assistant',
      sessionId: 'test-sess',
      message: {
        model,
        usage: {
          input_tokens: rawUsage.input,
          cache_creation_input_tokens: rawUsage.cache_creation,
          cache_read_input_tokens: rawUsage.cache_read,
        },
      },
    };
    writeFileSync(tp, JSON.stringify(obj) + '\n');
    return tp;
  }

  function busEnv(extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: fakeHome,
      CTX_AGENT_NAME: 'fullstack',
      CTX_ORG: 'sb-personal',
      CTX_INSTANCE_ID: 'default',
      CTX_ROOT: ctxRoot,
      // Strip CLAUDE_CODE_DISABLE_1M_CONTEXT so the test env controls 1M behavior
      CLAUDE_CODE_DISABLE_1M_CONTEXT: undefined,
      ...extra,
    } as NodeJS.ProcessEnv;
  }

  it('writes context-pct.json the consumer reads, with green severity at low pct', () => {
    writeTranscript({ input: 1, cache_creation: 100, cache_read: 1000 });
    const env = busEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: 'false' });
    const result = runBus(['context-update', '--cwd', agentCwd, '--projects-root', projectsRoot, '--format', 'json'], env);
    expect(result.code).toBe(0);

    const pctPath = join(ctxRoot, 'state', 'fullstack', 'context-pct.json');
    expect(existsSync(pctPath)).toBe(true);
    const pct = JSON.parse(readFileSync(pctPath, 'utf-8'));
    expect(pct.agent).toBe('fullstack');
    expect(pct.context_limit).toBe(1_000_000);
    expect(pct.current_loaded_tokens).toBe(1101);
    expect(pct.severity).toBe('green');
    expect(pct.session_id).toBe('test-sess');
  });

  it('logs a context_threshold_crossed event when severity escalates above green', () => {
    // 450k loaded against 1M = 45% → orange
    writeTranscript({ input: 0, cache_creation: 0, cache_read: 450_000 });
    const env = busEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: 'false' });
    const result = runBus(['context-update', '--cwd', agentCwd, '--projects-root', projectsRoot], env);
    expect(result.code).toBe(0);

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(ctxRoot, 'orgs', 'sb-personal', 'analytics', 'events', 'fullstack', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);
    const lines = readFileSync(eventFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const crossings = lines.filter(l => l.event === 'context_threshold_crossed');
    expect(crossings.length).toBeGreaterThan(0);
    const crossing = crossings[crossings.length - 1];
    expect(crossing.category).toBe('context');
    expect(crossing.severity).toBe('warning'); // orange → warning
    expect(crossing.metadata.severity).toBe('orange');
    expect(crossing.metadata.pct).toBeCloseTo(45, 1);
  });

  it('exits non-zero with no_data warning when no transcript exists for the cwd', () => {
    // No transcript written — directory exists but is empty
    const env = busEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: 'false' });
    const result = runBus(['context-update', '--cwd', agentCwd, '--projects-root', projectsRoot], env);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('No transcript found');

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(ctxRoot, 'orgs', 'sb-personal', 'analytics', 'events', 'fullstack', `${today}.jsonl`);
    if (existsSync(eventFile)) {
      const lines = readFileSync(eventFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      const noData = lines.find(l => l.event === 'context_monitor_no_data');
      expect(noData).toBeTruthy();
    }
  });

  it('respects CLAUDE_CODE_DISABLE_1M_CONTEXT=true and applies 200k thresholds', () => {
    // 130k loaded against 200k = 65% → yellow on 200k table
    writeTranscript({ input: 0, cache_creation: 0, cache_read: 130_000 });
    const env = busEnv({ CLAUDE_CODE_DISABLE_1M_CONTEXT: 'true' });
    const result = runBus(['context-update', '--cwd', agentCwd, '--projects-root', projectsRoot], env);
    expect(result.code).toBe(0);

    const pct = JSON.parse(readFileSync(join(ctxRoot, 'state', 'fullstack', 'context-pct.json'), 'utf-8'));
    expect(pct.context_limit).toBe(200_000);
    expect(pct.severity).toBe('yellow');
    expect(pct.pct).toBeCloseTo(65, 1);
  });
});
