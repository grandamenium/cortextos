import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { claudeProjectSlug, findClaudeProjectDir, javaStringHash, CLAUDE_SLUG_MAX } from '../../../src/utils/claude-project-dir.js';

describe('claudeProjectSlug (Claude Code 2.1.268 rule)', () => {
  it('uses the standard Java String.hashCode (independent vectors)', () => {
    expect(javaStringHash('hello')).toBe(99162322);
    expect(javaStringHash('Aa')).toBe(javaStringHash('BB')); // the classic collision, 2112
    expect(javaStringHash('')).toBe(0);
  });

  it('maps every non-alphanumeric UTF-16 unit to "-" without collapsing', () => {
    expect(claudeProjectSlug('/Users/foo/agents/boss')).toBe('-Users-foo-agents-boss');
    expect(claudeProjectSlug('/Users/x/.myapp/staging')).toBe('-Users-x--myapp-staging');
    expect(claudeProjectSlug('/private/tmp/sg_x/a.b_c d')).toBe('-private-tmp-sg-x-a-b-c-d');
    expect(claudeProjectSlug('/a@b+c~d')).toBe('-a-b-c-d');
    expect(claudeProjectSlug('/é')).toBe('--');
    expect(claudeProjectSlug('/😀')).toBe('---'); // astral: two code units
  });

  it('cuts long slugs at 200 and suffixes the base-36 hash of the original path', () => {
    const long = `/Users/tester/.myapp/staging/${'deep_dir.x/'.repeat(20)}end`;
    const slug = claudeProjectSlug(long);
    expect(slug.slice(0, CLAUDE_SLUG_MAX)).toBe(long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, CLAUDE_SLUG_MAX));
    expect(slug).toBe(`${long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(javaStringHash(long)).toString(36)}`);
    expect(slug.length).toBeGreaterThan(CLAUDE_SLUG_MAX);
  });
});

describe('findClaudeProjectDir', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-slug-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('resolves symlinks to the physical path before slugging', () => {
    const real = join(root, 'real.dir_x y');
    mkdirSync(real);
    const link = join(root, 'link');
    symlinkSync(real, link);
    const projects = join(root, 'projects');
    mkdirSync(join(projects, claudeProjectSlug(real)), { recursive: true });
    expect(findClaudeProjectDir(projects, link)).toBe(join(projects, claudeProjectSlug(real)));
  });

  it('long paths also match a <first 200>- prefix, like Claude Code', () => {
    const long = join(root, 'x_'.repeat(120));
    const projects = join(root, 'projects');
    const prefix = long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, CLAUDE_SLUG_MAX);
    mkdirSync(join(projects, `${prefix}-otherhash`), { recursive: true });
    expect(findClaudeProjectDir(projects, long)).toBe(join(projects, `${prefix}-otherhash`));
  });

  it('returns null when there is no conversation dir or no projects root', () => {
    expect(findClaudeProjectDir(join(root, 'missing'), '/a/b')).toBeNull();
    mkdirSync(join(root, 'projects'));
    expect(findClaudeProjectDir(join(root, 'projects'), '/a/b')).toBeNull();
  });
});

vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function AgentPTY() { return {}; } }));
const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

describe('AgentProcess.shouldContinue (Claude runtime) finds conversations under punctuated paths', () => {
  let root: string;
  let home: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-cont-')));
    home = process.env.HOME;
    process.env.HOME = join(root, 'home');
  });
  afterEach(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    rmSync(root, { recursive: true, force: true });
  });

  const envFor = (agentDir: string) => ({
    instanceId: 't', ctxRoot: join(root, 'ctx'), frameworkRoot: join(root, 'fw'), agentName: 'commander',
    agentDir, org: 'acme', projectRoot: join(root, 'fw'),
  });

  it.each([
    ['dots, underscores and a space', () => join(root, '.myapp', 'staging_env', 'project one', 'session')],
    ['a path longer than 200 characters', () => join(root, '.myapp', 'p_'.repeat(110), 'session')],
  ])('continues when a conversation exists for a launch dir with %s', (_label, dirOf) => {
    const launchDir = dirOf();
    mkdirSync(launchDir, { recursive: true });
    const conv = join(process.env.HOME!, '.claude', 'projects', claudeProjectSlug(realpathSync(launchDir)));
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, 'session.jsonl'), '{}\n');
    const ap = new AgentProcess('commander', envFor(join(root, 'agent')), { working_directory: launchDir });
    expect((ap as unknown as { shouldContinue: (f: boolean) => boolean }).shouldContinue(false)).toBe(true);
  });

  it('starts fresh when there is no conversation', () => {
    const launchDir = join(root, '.myapp', 'fresh_one');
    mkdirSync(launchDir, { recursive: true });
    const ap = new AgentProcess('commander', envFor(join(root, 'agent')), { working_directory: launchDir });
    expect((ap as unknown as { shouldContinue: (f: boolean) => boolean }).shouldContinue(false)).toBe(false);
  });
});
