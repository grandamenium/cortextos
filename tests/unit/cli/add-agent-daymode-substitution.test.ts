/**
 * F4 regression test: add-agent must substitute the {{day_mode_start}} /
 * {{day_mode_end}} placeholders that ship in template markdown.
 *
 * Bug context: copyTemplateFiles only replaced {{agent_name}}, {{org}}, and
 * {{current_timestamp}} at copy time. The day-mode tokens come from org
 * context.json (read AFTER the copy), so they were never substituted — they
 * leaked verbatim into every scaffolded agent's SOUL.md / ONBOARDING.md and
 * the orchestrator's agent-migration skill. Confirmed live while setting up
 * agents. The fix runs a deferred-substitution pass once the resolved values
 * are known, defaulting to 08:00/00:00 when context is absent or invalid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('F4: add-agent substitutes day_mode placeholders', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;

  // Stand up a temp framework + org. Pass `context` to write context.json, or
  // null to omit it entirely (exercises the default-fallback path).
  function setupOrg(context: Record<string, unknown> | null) {
    tempRoot = mkdtempSync(join(tmpdir(), 'f4-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'f4-home-'));
    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;

    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    if (context) {
      writeFileSync(join(tempRoot, 'orgs', 'testorg', 'context.json'), JSON.stringify(context));
    }
  }

  function agentFile(agent: string, file: string): string {
    return join(tempRoot, 'orgs', 'testorg', 'agents', agent, file);
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalCwd;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('leaves no {{day_mode_*}} tokens in SOUL.md and uses the org values', async () => {
    setupOrg({ name: 'testorg', timezone: 'America/New_York', day_mode_start: '09:30', day_mode_end: '22:00' });

    await addAgentCommand.parseAsync(['node', 'cli', 'daymode-agent', '--org', 'testorg', '--instance', 'f4-test']);

    const soul = readFileSync(agentFile('daymode-agent', 'SOUL.md'), 'utf-8');
    expect(soul).not.toContain('{{day_mode_start}}');
    expect(soul).not.toContain('{{day_mode_end}}');
    expect(soul).toContain('09:30');
    expect(soul).toContain('22:00');
  });

  it('substitutes across every copied text file, not just SOUL.md (ONBOARDING.md)', async () => {
    setupOrg({ name: 'testorg', timezone: 'UTC', day_mode_start: '07:00', day_mode_end: '23:00' });

    await addAgentCommand.parseAsync(['node', 'cli', 'daymode-onboard', '--org', 'testorg', '--instance', 'f4-test']);

    // templates/agent ships ONBOARDING.md with the tokens — it must exist and be clean.
    const onboardingPath = agentFile('daymode-onboard', 'ONBOARDING.md');
    expect(existsSync(onboardingPath)).toBe(true);
    const onboarding = readFileSync(onboardingPath, 'utf-8');
    expect(onboarding).not.toContain('{{day_mode_start}}');
    expect(onboarding).not.toContain('{{day_mode_end}}');
    // The onboarding identity line must use {{agent_name}} (substituted at copy),
    // not {{CTX_AGENT_NAME}} (which nothing substitutes and would leak verbatim).
    expect(onboarding).not.toContain('{{CTX_AGENT_NAME}}');
    expect(onboarding).not.toContain('{{agent_name}}');
    expect(onboarding).toContain('daymode-onboard'); // the resolved agent name
  });

  it('falls back to 08:00/00:00 defaults when context.json is absent', async () => {
    setupOrg(null);

    await addAgentCommand.parseAsync(['node', 'cli', 'no-ctx-agent', '--org', 'testorg', '--instance', 'f4-test']);

    const soul = readFileSync(agentFile('no-ctx-agent', 'SOUL.md'), 'utf-8');
    expect(soul).not.toContain('{{day_mode_start}}');
    expect(soul).not.toContain('{{day_mode_end}}');
    expect(soul).toContain('08:00');
    expect(soul).toContain('00:00');
  });

  it('falls back to defaults when context.json day_mode values fail the HH:MM format check', async () => {
    // Both values fail /^\d{2}:\d{2}$/ so config seeding uses the 08:00/00:00
    // defaults. (Note: the existing seeding only validates FORMAT, not range —
    // e.g. '99:99' would pass — and F4 reuses those exact resolved values
    // unchanged, so this test deliberately uses format-invalid inputs.)
    setupOrg({ name: 'testorg', timezone: 'UTC', day_mode_start: 'not-a-time', day_mode_end: 'nope' });

    await addAgentCommand.parseAsync(['node', 'cli', 'bad-ctx-agent', '--org', 'testorg', '--instance', 'f4-test']);

    const soul = readFileSync(agentFile('bad-ctx-agent', 'SOUL.md'), 'utf-8');
    expect(soul).not.toContain('{{day_mode_start}}');
    expect(soul).not.toContain('{{day_mode_end}}');
    expect(soul).not.toContain('not-a-time');
    expect(soul).toContain('08:00');
    expect(soul).toContain('00:00');
  });
});
