import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

  it('rejects path traversal template names before creating an agent directory', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(addAgentCommand.parseAsync([
      'node', 'cli', 'stolen',
      '--template', '../orgs/testorg/agents/private-agent',
      '--org', 'testorg',
      '--instance', 'persona-test',
    ])).rejects.toThrow(/process\.exit\(1\)/);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('invalid template name'));
    expect(existsSync(join(tempRoot, 'orgs', 'testorg', 'agents', 'stolen'))).toBe(false);
    exitSpy.mockRestore();
  });

  it('does not copy credential files or symlinks from a valid template', async () => {
    const personaDir = join(tempRoot, 'templates', 'personas', 'community-special');
    writeFileSync(join(personaDir, '.env'), 'BOT_TOKEN=secret\n');
    writeFileSync(join(personaDir, '.env.local'), 'CHAT_ID=secret\n');
    symlinkSync(join(personaDir, 'IDENTITY.md'), join(personaDir, 'IDENTITY_LINK.md'));

    await addAgentCommand.parseAsync([
      'node', 'cli', 'safe-persona',
      '--template', 'community-special',
      '--org', 'testorg',
      '--instance', 'persona-test',
    ]);

    const agentDir = join(tempRoot, 'orgs', 'testorg', 'agents', 'safe-persona');
    expect(existsSync(join(agentDir, '.env.local'))).toBe(false);
    expect(readFileSync(join(agentDir, '.env'), 'utf-8')).toContain('BOT_TOKEN=');
    expect(readFileSync(join(agentDir, '.env'), 'utf-8')).not.toContain('secret');
    expect(existsSync(join(agentDir, 'IDENTITY_LINK.md'))).toBe(false);
  });

  it('rejects claude-only persona templates for codex-app-server runtime', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(addAgentCommand.parseAsync([
      'node', 'cli', 'bad-codex-persona',
      '--template', 'community-special',
      '--runtime', 'codex-app-server',
      '--org', 'testorg',
      '--instance', 'persona-test',
    ])).rejects.toThrow(/process\.exit\(1\)/);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not codex-app-server'));
    expect(existsSync(join(tempRoot, 'orgs', 'testorg', 'agents', 'bad-codex-persona'))).toBe(false);
    exitSpy.mockRestore();
  });
});
