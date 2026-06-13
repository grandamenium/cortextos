import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('add-agent community persona template lookup', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalProjectRoot: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'persona-template-'));
    tempHome = mkdtempSync(join(tmpdir(), 'persona-home-'));

    originalHome = process.env.HOME;
    originalProjectRoot = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

    process.env.HOME = tempHome;
    process.env.CTX_PROJECT_ROOT = tempRoot;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;

    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({ name: 'testorg', timezone: 'UTC' }),
    );

    const personaDir = join(tempRoot, 'templates', 'personas', 'community-special');
    mkdirSync(join(personaDir, '.claude', 'skills', 'setup'), { recursive: true });
    writeFileSync(join(personaDir, 'AGENTS.md'), '# Persona sentinel for {{agent_name}} in {{org}}\n');
    writeFileSync(join(personaDir, 'IDENTITY.md'), '# Persona identity for {{agent_name}} in {{org}}\n');
    writeFileSync(join(personaDir, '.claude', 'skills', 'setup', 'SKILL.md'), '# Setup sentinel\n');
    writeFileSync(
      join(personaDir, 'config.json'),
      JSON.stringify({
        agent_name: '{{agent_name}}',
        template: 'community-special',
        crons: [{ name: 'heartbeat', type: 'recurring', interval: '4h', prompt: 'Run heartbeat.' }],
      }),
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('resolves --template <name> from templates/personas/<name>', async () => {
    await addAgentCommand.parseAsync([
      'node', 'cli', 'spawned-persona',
      '--template', 'community-special',
      '--org', 'testorg',
      '--instance', 'persona-test',
    ]);

    const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', 'spawned-persona');
    expect(existsSync(agentDir)).toBe(true);
    expect(existsSync(join(agentDir, '.claude', 'skills', 'setup', 'SKILL.md'))).toBe(true);

    const agentsMd = readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8');
    const identityMd = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
    const config = JSON.parse(readFileSync(join(agentDir, 'config.json'), 'utf-8'));

    expect(agentsMd).toContain('Persona sentinel for spawned-persona in testorg');
    expect(identityMd).toContain('Persona identity for spawned-persona in testorg');
    expect(identityMd).not.toContain('a Agent for testorg');
    expect(config.template).toBe('community-special');
    expect(config.agent_name).toBe('spawned-persona');
  });
});
