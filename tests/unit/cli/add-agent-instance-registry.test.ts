/**
 * #373 regression test: `add-agent` must write the enabled-agents.json registry
 * under the ACTIVE instance, never the live `default` instance.
 *
 * Bug context: the `--instance` option defaulted to the literal string
 * `'default'`. So running `add-agent` in a sandbox context
 * (`CTX_INSTANCE_ID=pr-sandbox`) WITHOUT an explicit `--instance` flag scaffolded
 * the agent dir into the sandbox framework root but registered the agent in
 * `~/.cortextos/default/config/enabled-agents.json` — leaking sandbox/phantom
 * agents into the LIVE roster (15 sandbox entries leaked in one night).
 *
 * The fix resolves the instance as: explicit `--instance` flag > `CTX_INSTANCE_ID`
 * env > `'default'`, so a sandbox-scoped add-agent stays fully inside its instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand, resolveAddAgentInstanceId } from '../../../src/cli/add-agent';

describe('#373: resolveAddAgentInstanceId precedence', () => {
  it('prefers the explicit --instance flag over everything', () => {
    expect(resolveAddAgentInstanceId('lifeos', { CTX_INSTANCE_ID: 'pr-sandbox' })).toBe('lifeos');
  });

  it('falls back to CTX_INSTANCE_ID when no flag is given', () => {
    expect(resolveAddAgentInstanceId(undefined, { CTX_INSTANCE_ID: 'pr-sandbox' })).toBe('pr-sandbox');
  });

  it('treats an empty-string flag as unset and falls through to the env', () => {
    expect(resolveAddAgentInstanceId('', { CTX_INSTANCE_ID: 'pr-sandbox' })).toBe('pr-sandbox');
  });

  it('falls back to "default" when neither flag nor env is set', () => {
    expect(resolveAddAgentInstanceId(undefined, {})).toBe('default');
  });
});

describe('#373: add-agent registry lands in the active instance, not default', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;
  let originalInstance: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'pr373-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'pr373-home-'));

    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    originalInstance = process.env.CTX_INSTANCE_ID;

    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;
    // Sandbox context: the registry must follow this, not the literal 'default'.
    process.env.CTX_INSTANCE_ID = 'pr-sandbox';

    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

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
    if (originalInstance === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = originalInstance;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('writes enabled-agents.json under CTX_INSTANCE_ID and NEVER under default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // No --instance flag — resolution must honor CTX_INSTANCE_ID=pr-sandbox.
    await addAgentCommand.parseAsync([
      'node', 'cli', 'sandbox-reg', '--template', 'agent', '--org', 'testorg',
    ]);

    const defaultRegistry = join(tempHome, '.cortextos', 'default', 'config', 'enabled-agents.json');
    const sandboxRegistry = join(tempHome, '.cortextos', 'pr-sandbox', 'config', 'enabled-agents.json');

    // The live default instance must be completely untouched.
    expect(existsSync(defaultRegistry)).toBe(false);

    // The sandbox instance owns the registration.
    expect(existsSync(sandboxRegistry)).toBe(true);
    const registry = JSON.parse(readFileSync(sandboxRegistry, 'utf-8'));
    expect(Object.keys(registry)).toContain('sandbox-reg');
    expect(registry['sandbox-reg']).toMatchObject({ enabled: true, org: 'testorg' });
  });

  it('an explicit --instance flag still overrides CTX_INSTANCE_ID', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'flag-wins', '--template', 'agent', '--org', 'testorg',
      '--instance', 'lifeos',
    ]);

    expect(existsSync(join(tempHome, '.cortextos', 'pr-sandbox', 'config', 'enabled-agents.json'))).toBe(false);
    expect(existsSync(join(tempHome, '.cortextos', 'default', 'config', 'enabled-agents.json'))).toBe(false);
    expect(existsSync(join(tempHome, '.cortextos', 'lifeos', 'config', 'enabled-agents.json'))).toBe(true);
  });
});
