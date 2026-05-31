/**
 * F3b: direct tests for the extracted addAgent() — the installer-only paths the
 * CLI wrapper never exercises (enabled:false) and the typed already-exists throw
 * the wrapper translates to exit-1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgent, AgentAlreadyExistsError } from '../../../src/scaffold/agent';

describe('F3b scaffold/addAgent (direct)', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalFrameworkRoot: string | undefined;
  let originalProjectRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'f3b-agent-rt-'));
    tempHome = mkdtempSync(join(tmpdir(), 'f3b-agent-home-'));
    originalHome = process.env.HOME;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    originalProjectRoot = process.env.CTX_PROJECT_ROOT;
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers enabled:false in enabled-agents.json when enabled:false is passed', () => {
    addAgent({ name: 'off-agent', template: 'agent', org: 'testorg', instance: 'f3b-i', projectRoot: tempRoot, enabled: false });
    const enabled = JSON.parse(readFileSync(join(tempHome, '.cortextos', 'f3b-i', 'config', 'enabled-agents.json'), 'utf-8'));
    expect(enabled['off-agent'].enabled).toBe(false);
    expect(enabled['off-agent'].org).toBe('testorg');
  });

  it('defaults to enabled:true when the flag is omitted (preserves add-agent behavior)', () => {
    addAgent({ name: 'on-agent', template: 'agent', org: 'testorg', instance: 'f3b-i', projectRoot: tempRoot });
    const enabled = JSON.parse(readFileSync(join(tempHome, '.cortextos', 'f3b-i', 'config', 'enabled-agents.json'), 'utf-8'));
    expect(enabled['on-agent'].enabled).toBe(true);
  });

  it('throws AgentAlreadyExistsError with the historical message when the agent dir exists', () => {
    addAgent({ name: 'dupe', template: 'agent', org: 'testorg', instance: 'f3b-i', projectRoot: tempRoot });
    let thrown: unknown;
    try {
      addAgent({ name: 'dupe', template: 'agent', org: 'testorg', instance: 'f3b-i', projectRoot: tempRoot });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentAlreadyExistsError);
    expect((thrown as Error).message).toMatch(/Agent "dupe" already exists at .*orgs\/testorg\/agents\/dupe/);
  });
});
