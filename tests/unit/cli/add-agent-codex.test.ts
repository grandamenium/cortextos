/**
 * PR-02 regression test: `cortextos add-agent <name> --runtime codex-app-server`
 * must produce a fully-bootstrapped codex agent.
 *
 * Bug context: codex-app-server agents were being scaffolded from the claude
 * template (templates/agent/), which references `.claude/skills/` paths and
 * Claude-Code-only constructs (`/loop`, ANTHROPIC_API_KEY, etc.). Fresh codex
 * agents had no idea how to reply via the bus, so a Telegram-shape inject
 * landed and went unanswered.
 *
 * The fix routes `--runtime codex-app-server` (with the default --template
 * agent) at templates/agent-codex/, which: (a) documents the bus reply rule
 * prominently in AGENTS.md and TOOLS.md, (b) ships the 23 codex-compatible
 * skills under plugins/cortextos-agent-skills/skills/, and (c) sets runtime
 * + model defaults in config.json.
 *
 * The scaffolder also walks the skills tree post-copy and creates one
 * <agent>__<skill> symlink per skill in ~/.codex/skills/ so codex's
 * host-wide skill discovery sees the per-agent set without collisions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('PR-02: add-agent --runtime codex-app-server', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr02-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'pr02-home-'));

    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    // Point template lookup + agent creation at the temp root.
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;

    // Symlink the real templates dir into the temp root so findTemplateDir resolves.
    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

    // Set up an org so the scaffolder doesn't bail on "no org found".
    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({
        name: 'testorg',
        timezone: 'America/New_York',
        orchestrator: 'orch',
        dashboard_url: 'http://localhost:3000',
        communication_style: 'casual',
        day_mode_start: '08:00',
        day_mode_end: '00:00',
      })
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalCwd;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('scaffolds a fully-bootstrapped codex agent dir with the right files', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'codex-test', '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'pr02-test',
    ]);

    const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', 'codex-test');
    expect(existsSync(agentDir)).toBe(true);

    // Bootstrap docs (AGENTS.md is the codex-runtime guidebook).
    for (const f of ['AGENTS.md', 'TOOLS.md', 'ONBOARDING.md', 'SYSTEM.md',
                     'IDENTITY.md', 'USER.md', 'GOALS.md', 'HEARTBEAT.md',
                     'GUARDRAILS.md', 'MEMORY.md', 'SOUL.md',
                     'config.json', 'goals.json']) {
      expect(existsSync(join(agentDir, f))).toBe(true);
    }

    // CLAUDE.md is dropped on the codex path — codex doesn't read it.
    expect(existsSync(join(agentDir, 'CLAUDE.md'))).toBe(false);
  });

  it('writes runtime=codex-app-server and model=gpt-5-codex into config.json', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'codex-cfg', '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'pr02-test',
    ]);

    const cfgPath = join(tempRoot, 'orgs', 'testorg', 'agents', 'codex-cfg', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.runtime).toBe('codex-app-server');
    expect(cfg.model).toBe('gpt-5-codex');
    expect(cfg.agent_name).toBe('codex-cfg');
  });

  it('copies the 23 codex skills into plugins/cortextos-agent-skills/skills', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'codex-skills', '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'pr02-test',
    ]);

    const skillsDir = join(
      tempRoot, 'orgs', 'testorg', 'agents', 'codex-skills',
      'plugins', 'cortextos-agent-skills', 'skills',
    );
    expect(existsSync(skillsDir)).toBe(true);
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    expect(skills.length).toBe(23);
    // Spot check: comms is the skill that teaches the Telegram reply pattern.
    expect(skills).toContain('comms');
    expect(skills).toContain('onboarding');
  });

  it('creates ~/.codex/skills/<agent>__<skill> symlinks for every skill', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'codex-links', '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'pr02-test',
    ]);

    const codexSkillsDir = join(tempHome, '.codex', 'skills');
    expect(existsSync(codexSkillsDir)).toBe(true);
    const links = readdirSync(codexSkillsDir).filter(n => n.startsWith('codex-links__'));
    expect(links.length).toBe(23);

    // Each entry must be a symlink (not a copy), pointing at the agent's local skill dir.
    for (const link of links) {
      const linkPath = join(codexSkillsDir, link);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    }
  });

  it('AGENTS.md and TOOLS.md prominently teach the cortextos bus send-telegram reply rule', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'codex-rules', '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'pr02-test',
    ]);

    const agentsMd = readFileSync(
      join(tempRoot, 'orgs', 'testorg', 'agents', 'codex-rules', 'AGENTS.md'),
      'utf-8',
    );
    const toolsMd = readFileSync(
      join(tempRoot, 'orgs', 'testorg', 'agents', 'codex-rules', 'TOOLS.md'),
      'utf-8',
    );

    // Both must reference the bus command — without it the bootstrap is broken.
    expect(agentsMd).toMatch(/cortextos bus send-telegram/);
    expect(toolsMd).toMatch(/cortextos bus send-telegram/);

    // AGENTS.md must call out the rule prominently — appearing in the first
    // 1500 chars (i.e. above the fold, not buried at the bottom).
    expect(agentsMd.slice(0, 1500)).toMatch(/cortextos bus send-telegram/);

    // No leftover Claude-Code-only paths in the codex template.
    expect(agentsMd).not.toMatch(/\.claude\/skills\//);
    expect(toolsMd).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(toolsMd).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('keeps claude-code scaffolding intact when --runtime is unset', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'claude-baseline',
      '--org', 'testorg', '--instance', 'pr02-test',
    ]);

    const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', 'claude-baseline');
    // Claude scaffolding still creates .claude/skills/ — codex path must not regress this.
    expect(existsSync(join(agentDir, '.claude', 'skills'))).toBe(true);
    // No codex symlinks for a claude agent.
    const codexSkillsDir = join(tempHome, '.codex', 'skills');
    if (existsSync(codexSkillsDir)) {
      const stray = readdirSync(codexSkillsDir).filter(n => n.startsWith('claude-baseline__'));
      expect(stray.length).toBe(0);
    }
    // PR 10: claude-code is now an EXPLICIT field in templates/agent/config.json
    // so the default scaffold makes the runtime visible to readers without
    // requiring knowledge of the implicit default.
    const cfg = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8'));
    expect(cfg.runtime).toBe('claude-code');
  });
});

/**
 * PR 10 regression: scaffolder must reject codex-app-server runtime paired
 * with templates that have no codex variant yet (orchestrator, analyst,
 * m2c1-worker, hermes). Without this gate, the user gets a half-scaffolded
 * agent: codex runtime in config but claude-only bootstrap files
 * (`.claude/skills/`, `CLAUDE_CODE_OAUTH_TOKEN`, `/loop`) — silently broken
 * on first boot. Surface a clean error instead.
 */
describe('PR-10: add-agent rejects codex+claude-only-template combos', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr10-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'pr10-home-'));

    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;

    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({ name: 'testorg', timezone: 'UTC' })
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // process.exit needs to throw so the action handler short-circuits before
    // trying to scaffold; otherwise the rejection error won't surface as
    // synchronously as the test asserts.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalCwd;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  for (const template of ['orchestrator', 'analyst', 'm2c1-worker', 'hermes']) {
    it(`rejects --template ${template} --runtime codex-app-server with a clean error`, async () => {
      await expect(addAgentCommand.parseAsync([
        'node', 'cli', `codex-${template}`,
        '--template', template,
        '--runtime', 'codex-app-server',
        '--org', 'testorg', '--instance', 'pr10-test',
      ])).rejects.toThrow(/process\.exit\(1\)/);

      expect(errorSpy).toHaveBeenCalled();
      const errorMsg = errorSpy.mock.calls.flat().join('\n');
      expect(errorMsg).toMatch(new RegExp(`no codex variant of "${template}"`));
      expect(errorMsg).toMatch(/Use --template agent/);

      // No agent dir should have been created.
      const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', `codex-${template}`);
      expect(existsSync(agentDir)).toBe(false);
    });
  }
});
