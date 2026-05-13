import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { selfRestart, hardRestart, autoCommit, checkGoalStaleness, postActivity, getFreshRestartCooldown, DEFAULT_FRESH_RESTART_COOLDOWN_SECONDS } from '../../../src/bus/system';
import type { BusPaths } from '../../../src/types';

function makePaths(testDir: string, agent: string = 'test-agent'): BusPaths {
  return {
    ctxRoot: testDir,
    inbox: join(testDir, 'inbox', agent),
    inflight: join(testDir, 'inflight', agent),
    processed: join(testDir, 'processed', agent),
    logDir: join(testDir, 'logs', agent),
    stateDir: join(testDir, 'state', agent),
    taskDir: join(testDir, 'tasks'),
    approvalDir: join(testDir, 'approvals'),
    analyticsDir: join(testDir, 'analytics'),
    heartbeatDir: join(testDir, 'heartbeats'),
  };
}

describe('Bus System', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-system-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('selfRestart', () => {
    it('creates marker file and appends to restarts.log', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent', 'config reload needed');

      // Check marker file
      const markerPath = join(paths.stateDir, '.restart-planned');
      expect(existsSync(markerPath)).toBe(true);
      const markerContent = readFileSync(markerPath, 'utf-8').trim();
      expect(markerContent).toBe('config reload needed');

      // Check restarts.log
      const logPath = join(paths.logDir, 'restarts.log');
      expect(existsSync(logPath)).toBe(true);
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: config reload needed');
      expect(logContent).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      selfRestart(paths, 'test-agent');

      const logPath = join(paths.logDir, 'restarts.log');
      const logContent = readFileSync(logPath, 'utf-8');
      expect(logContent).toContain('SELF-RESTART: no reason specified');
    });
  });

  describe('hardRestart', () => {
    it('creates .force-fresh and .restart-planned markers', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context handoff');

      expect(existsSync(join(paths.stateDir, '.force-fresh'))).toBe(true);
      expect(existsSync(join(paths.stateDir, '.restart-planned'))).toBe(true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: context handoff');
    });

    it('uses default reason when none provided', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent');
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART: no reason specified');
    });

    // BL-2026-05-08-004 Phase 3 — fresh-restart marker behavior
    it('does NOT write .last-fresh-restart-at when freshStart is omitted (context restart path)', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context-red');
      expect(existsSync(join(paths.stateDir, '.last-fresh-restart-at'))).toBe(false);
    });

    it('does NOT write .last-fresh-restart-at when freshStart=false', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'context-red', false);
      expect(existsSync(join(paths.stateDir, '.last-fresh-restart-at'))).toBe(false);
    });

    it('writes .last-fresh-restart-at with ISO timestamp when freshStart=true', () => {
      const paths = makePaths(testDir);
      const before = Date.now();
      hardRestart(paths, 'test-agent', 'fresh-start for unrelated dispatch', true);
      const after = Date.now();
      const markerPath = join(paths.stateDir, '.last-fresh-restart-at');
      expect(existsSync(markerPath)).toBe(true);
      const ts = readFileSync(markerPath, 'utf-8').trim();
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const tsMs = Date.parse(ts);
      expect(tsMs).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(tsMs).toBeLessThanOrEqual(after + 1000);
    });

    it('tags fresh-start in restarts.log distinctly', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'fresh-start for unrelated', true);
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent).toContain('HARD-RESTART (fresh-start): fresh-start for unrelated');
    });
  });

  // BL-2026-05-08-004 Phase 3 — fresh-restart cooldown reader
  describe('getFreshRestartCooldown', () => {
    it('returns null-shape when no marker exists', () => {
      const paths = makePaths(testDir);
      mkdirSync(paths.stateDir, { recursive: true });
      const status = getFreshRestartCooldown(paths);
      expect(status).toEqual({
        last_at: null,
        age_seconds: null,
        on_cooldown: false,
        cooldown_seconds_remaining: 0,
        cooldown_seconds_total: DEFAULT_FRESH_RESTART_COOLDOWN_SECONDS,
      });
    });

    it('reports on_cooldown=true when marker is recent', () => {
      const paths = makePaths(testDir);
      mkdirSync(paths.stateDir, { recursive: true });
      const fakeNow = Date.parse('2026-05-08T12:00:00Z');
      const fiveMinAgo = new Date(fakeNow - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      writeFileSync(join(paths.stateDir, '.last-fresh-restart-at'), fiveMinAgo + '\n');
      const status = getFreshRestartCooldown(paths, 30 * 60, fakeNow);
      expect(status.on_cooldown).toBe(true);
      expect(status.last_at).toBe(fiveMinAgo);
      expect(status.age_seconds).toBe(300);
      expect(status.cooldown_seconds_remaining).toBe(25 * 60);
    });

    it('reports on_cooldown=false when marker is older than window', () => {
      const paths = makePaths(testDir);
      mkdirSync(paths.stateDir, { recursive: true });
      const fakeNow = Date.parse('2026-05-08T12:00:00Z');
      const oneHourAgo = new Date(fakeNow - 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      writeFileSync(join(paths.stateDir, '.last-fresh-restart-at'), oneHourAgo + '\n');
      const status = getFreshRestartCooldown(paths, 30 * 60, fakeNow);
      expect(status.on_cooldown).toBe(false);
      expect(status.cooldown_seconds_remaining).toBe(0);
      expect(status.age_seconds).toBe(3600);
    });

    it('respects custom cooldownSeconds override', () => {
      const paths = makePaths(testDir);
      mkdirSync(paths.stateDir, { recursive: true });
      const fakeNow = Date.parse('2026-05-08T12:00:00Z');
      const tenMinAgo = new Date(fakeNow - 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      writeFileSync(join(paths.stateDir, '.last-fresh-restart-at'), tenMinAgo + '\n');
      // 5min window: 10min ago is past it
      expect(getFreshRestartCooldown(paths, 5 * 60, fakeNow).on_cooldown).toBe(false);
      // 60min window: 10min ago is inside it
      expect(getFreshRestartCooldown(paths, 60 * 60, fakeNow).on_cooldown).toBe(true);
    });

    it('fail-opens (on_cooldown=false) on unparseable marker content', () => {
      const paths = makePaths(testDir);
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(join(paths.stateDir, '.last-fresh-restart-at'), 'not-a-date\n');
      const status = getFreshRestartCooldown(paths);
      expect(status.on_cooldown).toBe(false);
      expect(status.last_at).toBe(null);
    });

    it('round-trips with hardRestart(freshStart=true): cooldown=ON immediately after', () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'fresh-start for unrelated', true);
      const status = getFreshRestartCooldown(paths);
      expect(status.on_cooldown).toBe(true);
      expect(status.last_at).not.toBeNull();
      expect(status.age_seconds).toBeLessThan(5);
    });

    // Locks in spec § Component 6 "max 1 hard-restart per N min UNLESS EXPLICIT": when an
    // explicit fresh_start=true dispatch arrives during an active cooldown, the agent's
    // CLAUDE.md "On dispatch receipt" rule fires the restart anyway and the marker is
    // overwritten. The implementation supports this by always writing the marker on
    // hardRestart(freshStart=true) — there's no "skip if recent" guard inside the function.
    it('overwrites marker on second hardRestart(freshStart=true) — explicit bypasses cooldown', async () => {
      const paths = makePaths(testDir);
      hardRestart(paths, 'test-agent', 'first fresh-start', true);
      const firstStatus = getFreshRestartCooldown(paths);
      expect(firstStatus.on_cooldown).toBe(true);
      const firstTs = firstStatus.last_at!;
      // Wait briefly so the second timestamp differs (1s ISO resolution)
      await new Promise(r => setTimeout(r, 1100));
      hardRestart(paths, 'test-agent', 'second fresh-start (cooldown bypass)', true);
      const secondStatus = getFreshRestartCooldown(paths);
      expect(secondStatus.last_at).not.toBeNull();
      expect(secondStatus.last_at).not.toBe(firstTs); // overwritten
      // Both restart-log entries are tagged distinctly so post-mortem can see both fired
      const logContent = readFileSync(join(paths.logDir, 'restarts.log'), 'utf-8');
      expect(logContent.match(/HARD-RESTART \(fresh-start\):/g)?.length).toBe(2);
    });
  });

  describe('autoCommit', () => {
    let gitDir: string;
    let savedGitEnv: Record<string, string | undefined> = {};

    // Strip GIT_* env vars at process scope (and pass a scrubbed env to direct execSync
    // calls below). Otherwise an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE /
    // GIT_OBJECT_DIRECTORY (e.g. when these tests run from inside a pre-push hook,
    // where the parent `git push` exports them) makes git subprocesses operate on the
    // OUTER repo instead of `gitDir` — breaking tests *and* corrupting the outer
    // repo's .git/config with the test fixtures. The autoCommit() function under test
    // also spawns git via process.env, so we must clean process.env, not just child env.
    const cleanGitEnv = () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of Object.keys(env)) {
        if (k.startsWith('GIT_')) delete env[k];
      }
      return env;
    };

    beforeEach(() => {
      savedGitEnv = {};
      for (const k of Object.keys(process.env)) {
        if (k.startsWith('GIT_')) {
          savedGitEnv[k] = process.env[k];
          delete process.env[k];
        }
      }
      gitDir = mkdtempSync(join(tmpdir(), 'cortextos-autocommit-test-'));
      const env = cleanGitEnv();
      execSync('git init', { cwd: gitDir, stdio: 'pipe', env });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe', env });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe', env });
      // Create initial commit so git status works properly
      writeFileSync(join(gitDir, '.gitkeep'), '');
      execSync('git add .gitkeep && git commit -m "init"', { cwd: gitDir, stdio: 'pipe', env });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(savedGitEnv)) {
        if (v !== undefined) process.env[k] = v;
      }
      savedGitEnv = {};
    });

    it('filters out .env files', () => {
      writeFileSync(join(gitDir, 'app.env'), 'SECRET=abc');
      writeFileSync(join(gitDir, 'safe.txt'), 'hello');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');
      expect(report.staged).toContain('safe.txt');
      expect(report.blocked.some(b => b.includes('app.env'))).toBe(true);
    });

    it('filters out files with credential patterns', () => {
      writeFileSync(join(gitDir, 'config.json'), '{"token=abc123"}');
      writeFileSync(join(gitDir, 'readme.md'), 'just a readme');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('config.json') && b.includes('credential'))).toBe(true);
      expect(report.staged).toContain('readme.md');
    });

    it('allows script files even with credential-like patterns', () => {
      writeFileSync(join(gitDir, 'deploy.sh'), '#!/bin/bash\ntoken=get_from_env');
      writeFileSync(join(gitDir, 'app.py'), 'password=input("Enter:")');
      writeFileSync(join(gitDir, 'main.js'), 'const secret=process.env.SECRET');

      const report = autoCommit(gitDir, true);
      expect(report.staged).toContain('deploy.sh');
      expect(report.staged).toContain('app.py');
      expect(report.staged).toContain('main.js');
    });

    it('filters out binary/temp files', () => {
      writeFileSync(join(gitDir, 'output.log'), 'log data');
      writeFileSync(join(gitDir, 'cache.tmp'), 'temp');
      writeFileSync(join(gitDir, 'app.pid'), '12345');

      const report = autoCommit(gitDir, true);
      expect(report.blocked.some(b => b.includes('output.log'))).toBe(true);
      expect(report.blocked.some(b => b.includes('cache.tmp'))).toBe(true);
      expect(report.blocked.some(b => b.includes('app.pid'))).toBe(true);
    });

    it('dry-run does not stage files', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, true);
      expect(report.status).toBe('dry_run');

      // Verify nothing is staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8', env: cleanGitEnv() });
      expect(staged.trim()).toBe('');
    });

    it('returns clean when no changes', () => {
      const report = autoCommit(gitDir);
      expect(report.status).toBe('clean');
    });

    it('stages safe files when not dry-run', () => {
      writeFileSync(join(gitDir, 'newfile.txt'), 'content');

      const report = autoCommit(gitDir, false);
      expect(report.status).toBe('staged');
      expect(report.staged).toContain('newfile.txt');

      // Verify file is actually staged
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, encoding: 'utf-8', env: cleanGitEnv() });
      expect(staged.trim()).toContain('newfile.txt');
    });

    it('returns nothing_to_stage when all files blocked', () => {
      writeFileSync(join(gitDir, 'secrets.env'), 'API_KEY=123');

      const report = autoCommit(gitDir);
      expect(report.status).toBe('nothing_to_stage');
      expect(report.blocked.length).toBeGreaterThan(0);
    });
  });

  describe('checkGoalStaleness', () => {
    it('identifies stale goals', () => {
      // Create org/agent structure with old timestamp
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const oldDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${oldDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.total).toBe(1);
      expect(report.summary.stale).toBe(1);
      expect(report.agents[0].status).toBe('stale');
      expect(report.agents[0].agent).toBe('worker');
      expect(report.agents[0].org).toBe('myorg');
      expect(report.agents[0].stale).toBe(true);
    });

    it('identifies fresh goals', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });

      const recentDate = new Date().toISOString();
      writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${recentDate}\n\nSome goal`);

      const report = checkGoalStaleness(testDir, 7);
      expect(report.summary.fresh).toBe(1);
      expect(report.agents[0].status).toBe('fresh');
      expect(report.agents[0].stale).toBe(false);
    });

    it('handles missing GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      // No GOALS.md created

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('missing');
      expect(report.agents[0].stale).toBe(true);
      expect(report.agents[0].reason).toContain('no GOALS.md');
    });

    it('handles missing timestamp in GOALS.md', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\nJust some text without updated section');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('no_timestamp');
      expect(report.agents[0].stale).toBe(true);
    });

    it('handles unparseable timestamp', () => {
      const agentDir = join(testDir, 'orgs', 'myorg', 'agents', 'worker');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'GOALS.md'), '# Goals\n\n## Updated\nnot-a-date\n');

      const report = checkGoalStaleness(testDir);
      expect(report.agents[0].status).toBe('parse_error');
      expect(report.agents[0].stale).toBe(true);
    });

    it('returns empty report when no orgs directory', () => {
      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(0);
      expect(report.agents).toEqual([]);
    });

    it('scans multiple orgs and agents', () => {
      // Create two orgs with agents
      for (const org of ['org1', 'org2']) {
        const agentDir = join(testDir, 'orgs', org, 'agents', 'bot');
        mkdirSync(agentDir, { recursive: true });
        const date = new Date().toISOString();
        writeFileSync(join(agentDir, 'GOALS.md'), `# Goals\n\n## Updated\n${date}\n`);
      }

      const report = checkGoalStaleness(testDir);
      expect(report.summary.total).toBe(2);
    });
  });

  describe('postActivity', () => {
    it('returns false when not configured', async () => {
      const result = await postActivity(
        join(testDir, 'nonexistent'),
        testDir,
        'myorg',
        'hello',
      );
      expect(result).toBe(false);
    });

    it('returns false when env file has no token', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_CHAT_ID=123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });

    it('returns false when env file has no chat ID', async () => {
      const orgDir = join(testDir, 'orgdir');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

      const result = await postActivity(orgDir, testDir, 'myorg', 'hello');
      expect(result).toBe(false);
    });
  });
});
