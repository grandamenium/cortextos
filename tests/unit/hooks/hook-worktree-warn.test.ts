import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  isUnderCanonical,
  matchedCanonical,
  buildWarningMessage,
  worktreeDirFor,
} from '../../../src/hooks/hook-worktree-warn';

const CANONICAL = '/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork';
const CANONICAL_JARVIS = '/Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis';

describe('matchedCanonical / isUnderCanonical', () => {
  it('matches exact canonical cortextos-fork path', () => {
    expect(matchedCanonical(CANONICAL)).toBe(CANONICAL);
    expect(isUnderCanonical(CANONICAL)).toBe(true);
  });

  it('matches exact canonical jarvis path', () => {
    expect(matchedCanonical(CANONICAL_JARVIS)).toBe(CANONICAL_JARVIS);
    expect(isUnderCanonical(CANONICAL_JARVIS)).toBe(true);
  });

  it('returns the cortextos-fork root when cwd is a subdirectory of it', () => {
    expect(matchedCanonical(`${CANONICAL}/orgs/sb-personal/agents/fullstack`)).toBe(CANONICAL);
    expect(matchedCanonical(`${CANONICAL}/src/hooks`)).toBe(CANONICAL);
  });

  it('returns the jarvis root when cwd is under it', () => {
    expect(matchedCanonical(`${CANONICAL_JARVIS}/docs/roadmap`)).toBe(CANONICAL_JARVIS);
  });

  it('matches deep subdirectory', () => {
    expect(matchedCanonical(`${CANONICAL}/templates/agent/.claude/skills/onboarding`)).toBe(CANONICAL);
  });

  it('does NOT match a worktree path', () => {
    expect(matchedCanonical('/Users/sauravb/cortextos-worktrees/fullstack/feat-x')).toBeNull();
    expect(matchedCanonical('/Users/sauravb/jarvis-worktrees/engineer/feat-y')).toBeNull();
  });

  it('does NOT match a sibling path that shares a prefix', () => {
    // The trailing-slash discipline prevents `sb-cortextos-fork-other` from
    // matching `sb-cortextos-fork`. Critical for canonical-path detection.
    expect(matchedCanonical(`${CANONICAL}-other`)).toBeNull();
    expect(matchedCanonical(`${CANONICAL}-fork`)).toBeNull();
  });

  it('does NOT match an unrelated path', () => {
    expect(matchedCanonical('/tmp/somewhere')).toBeNull();
    expect(matchedCanonical('/Users/sauravb')).toBeNull();
    expect(matchedCanonical('/')).toBeNull();
  });

  it('honors a custom canonical-paths list', () => {
    expect(matchedCanonical('/foo/bar', ['/foo'])).toBe('/foo');
    expect(matchedCanonical('/baz', ['/foo'])).toBeNull();
  });
});

describe('worktreeDirFor', () => {
  it('maps cortextos-fork to ~/cortextos-worktrees', () => {
    expect(worktreeDirFor(CANONICAL)).toBe('~/cortextos-worktrees');
  });

  it('maps sb-claude-jarvis to ~/jarvis-worktrees', () => {
    expect(worktreeDirFor(CANONICAL_JARVIS)).toBe('~/jarvis-worktrees');
  });

  it('falls back to ~/<basename>-worktrees for unknown canonical roots', () => {
    // Useful for forks of either repo that follow the same naming pattern
    // without needing this map updated.
    expect(worktreeDirFor('/some/path/my-fork-name')).toBe('~/my-fork-name-worktrees');
  });
});

describe('buildWarningMessage', () => {
  it('includes the agent name in the worktree-add command', () => {
    const msg = buildWarningMessage('engineer', `${CANONICAL}/orgs`, CANONICAL);
    expect(msg).toContain('git worktree add ~/cortextos-worktrees/engineer/<branch>');
  });

  it('includes the cwd that triggered the warning', () => {
    const cwd = `${CANONICAL}/src/hooks`;
    const msg = buildWarningMessage('fullstack', cwd, CANONICAL);
    expect(msg).toContain(cwd);
  });

  it('uses the matched canonical as the cd target so cortextos-fork stays cortextos-fork', () => {
    const msg = buildWarningMessage('analyst', CANONICAL, CANONICAL);
    expect(msg).toContain(`cd ${CANONICAL}`);
    expect(msg).toContain('~/cortextos-worktrees/');
    expect(msg).not.toContain('~/jarvis-worktrees/');
  });

  it('routes jarvis cwd to jarvis cd target + jarvis worktree dir (NOT cortextos-fork)', () => {
    const msg = buildWarningMessage('engineer', `${CANONICAL_JARVIS}/docs`, CANONICAL_JARVIS);
    expect(msg).toContain(`cd ${CANONICAL_JARVIS}`);
    expect(msg).toContain('git worktree add ~/jarvis-worktrees/engineer/<branch>');
    expect(msg).not.toContain('~/cortextos-worktrees/');
    expect(msg).not.toContain(CANONICAL);
  });

  it('points at the CLAUDE.md section so the agent can find the full workflow', () => {
    const msg = buildWarningMessage('boss', CANONICAL, CANONICAL);
    expect(msg).toContain('Working tree (shared-repo discipline)');
  });
});

/**
 * End-to-end subprocess tests — drive the compiled CLI via
 * `cortextos bus hook-worktree-warn` exactly as Claude Code would.
 *
 * Per the integration-artifact-tests discipline we read what the consumer
 * reads (stdout JSON for Claude Code; events JSONL for the activity feed).
 *
 * CI portability: the production canonical paths (`/Volumes/...`) don't
 * exist on ubuntu-latest. Each test sets `CTX_HOOK_CANONICAL_PATHS_OVERRIDE`
 * to a tmp-rooted real directory tree so spawnSync's cwd argument always
 * resolves AND the hook still matches its canonical-detection logic. HOME
 * override pattern lifted from
 * tests/integration/hook-context-status-migration.test.ts so resolvePaths
 * routes logEvent's writes into tmpRoot.
 */
describe('hook-worktree-warn end-to-end (CLI subprocess)', () => {
  const REPO_ROOT = resolve(__dirname, '..', '..', '..');
  const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli.js');

  let tmpRoot: string;
  let fakeHome: string;
  let ctxRoot: string;
  let fakeCortextosFork: string;
  let fakeJarvis: string;
  const agentName = 'test-agent';
  const org = 'test-org';
  const instanceId = 'default';

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry missing at ${CLI_ENTRY}; run \`npm run build\` first.`);
    }
  });

  beforeEach(() => {
    // realpath everything: macOS resolves /var/folders/... to /private/var/folders/...
    // which would mis-match the hook's safeRealpath(process.cwd()) call. Pre-realpathing
    // makes the env-override canonical paths bit-equal to what the subprocess sees.
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-warn-')));
    fakeHome = join(tmpRoot, 'home');
    ctxRoot = join(fakeHome, '.cortextos', instanceId);
    mkdirSync(join(ctxRoot, 'state', agentName), { recursive: true });
    mkdirSync(join(ctxRoot, 'orgs', org, 'analytics', 'events', agentName), { recursive: true });
    fakeCortextosFork = join(tmpRoot, 'sb-cortextos-fork');
    fakeJarvis = join(tmpRoot, 'sb-claude-jarvis');
    mkdirSync(join(fakeCortextosFork, 'src', 'hooks'), { recursive: true });
    mkdirSync(fakeJarvis, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function runHook(opts: {
    cwd: string;
    setAgentName?: boolean;
    canonicalOverride?: string;
  }): { stdout: string; stderr: string; status: number | null } {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      CTX_ROOT: ctxRoot,
      CTX_INSTANCE_ID: instanceId,
      CTX_ORG: org,
      CTX_HOOK_CANONICAL_PATHS_OVERRIDE:
        opts.canonicalOverride ?? `${fakeCortextosFork}:${fakeJarvis}`,
    };
    if (opts.setAgentName !== false) env.CTX_AGENT_NAME = agentName;
    else delete env.CTX_AGENT_NAME;
    const r = spawnSync('node', [CLI_ENTRY, 'bus', 'hook-worktree-warn'], {
      cwd: opts.cwd,
      env,
      input: '{}',
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      status: r.status,
    };
  }

  function readEventsLog(): string {
    const today = new Date().toISOString().split('T')[0];
    const p = join(ctxRoot, 'orgs', org, 'analytics', 'events', agentName, `${today}.jsonl`);
    return existsSync(p) ? readFileSync(p, 'utf-8') : '';
  }

  it('emits hookSpecificOutput.additionalContext with cortextos-fork details on cortextos-fork match', () => {
    const result = runHook({ cwd: fakeCortextosFork });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('BL-005 worktree warning');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      `git worktree add ~/cortextos-worktrees/${agentName}/<branch>`,
    );
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(`cd ${fakeCortextosFork}`);
  });

  it('emits jarvis worktree path when cwd is under the jarvis canonical', () => {
    // The Phase 2 evaluator caught buildWarningMessage hardcoding cortextos-fork.
    // This test guards against regression — jarvis cwd MUST yield jarvis paths.
    const result = runHook({ cwd: fakeJarvis });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      `git worktree add ~/jarvis-worktrees/${agentName}/<branch>`,
    );
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(`cd ${fakeJarvis}`);
    expect(parsed.hookSpecificOutput?.additionalContext).not.toContain('~/cortextos-worktrees/');
  });

  it('writes a worktree_canonical_boot_warning event with the matched canonical in metadata', () => {
    runHook({ cwd: fakeJarvis });
    const log = readEventsLog();
    expect(log).toContain('worktree_canonical_boot_warning');
    const lines = log.split('\n').filter(Boolean);
    const event = lines.map((l) => JSON.parse(l)).find((e) => e.event === 'worktree_canonical_boot_warning');
    expect(event).toBeDefined();
    expect(event.severity).toBe('warning');
    expect(event.metadata?.cwd).toBe(fakeJarvis);
    expect(event.metadata?.agent).toBe(agentName);
    expect(event.metadata?.canonical).toBe(fakeJarvis);
    expect(event.metadata?.worktree_dir).toBe('~/jarvis-worktrees');
  });

  it('writes empty {} and no event when cwd is NOT canonical', () => {
    const result = runHook({ cwd: tmpRoot });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(readEventsLog()).toBe('');
  });

  it('exits 0 silently as a no-op when CTX_AGENT_NAME is unset', () => {
    const result = runHook({ cwd: fakeCortextosFork, setAgentName: false });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(readEventsLog()).toBe('');
  });

  it('matches a deep canonical subdirectory', () => {
    const subdir = join(fakeCortextosFork, 'src', 'hooks');
    const result = runHook({ cwd: subdir });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(subdir);
  });
});
