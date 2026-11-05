import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ecosystemCommand } from '../../../src/cli/ecosystem';
import { discoverSourceAgentCandidates } from '../../../src/daemon/agent-discovery';

describe('ecosystem roster uses the daemon discovery authority', () => {
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  const roots: string[] = [];

  afterEach(() => {
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeRoot(agentCount: number): string {
    const root = mkdtempSync(join(tmpdir(), 'ecosystem-roster-'));
    roots.push(root);
    const agentsBase = join(root, 'orgs', 'acme', 'agents');
    for (let index = 0; index < agentCount; index++) {
      const dir = join(agentsBase, `agent${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true }), 'utf8');
    }
    mkdirSync(join(agentsBase, '_shared', 'scripts'), { recursive: true });
    mkdirSync(join(agentsBase, '.cache'), { recursive: true });
    return root;
  }

  it('known-positive: daemon discovery excludes shared and hidden directories', () => {
    const discovered = discoverSourceAgentCandidates(makeRoot(3));
    expect(discovered.map(candidate => candidate.name).sort()).toEqual(['agent0', 'agent1', 'agent2']);
  });

  it('production ecosystem command reports the daemon roster, not every directory', async () => {
    const root = makeRoot(3);
    process.env.CTX_FRAMEWORK_ROOT = root;
    const messages: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      messages.push(args.map(String).join(' '));
    });

    await ecosystemCommand.parseAsync([
      'node', 'cortextos', '--org', 'acme', '--output', join(root, 'ecosystem.config.cjs'),
    ]);

    const generated = messages.find(message => message.includes('manages'));
    expect(generated).toContain('manages 3 agents');
    expect(generated).not.toContain('manages 5 agents');
  });

  it('specificity: adding a real agent changes the production count', async () => {
    const counts: string[] = [];
    for (const count of [2, 4]) {
      const root = makeRoot(count);
      process.env.CTX_FRAMEWORK_ROOT = root;
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        const message = args.map(String).join(' ');
        if (message.includes('manages')) counts.push(message);
      });
      await ecosystemCommand.parseAsync([
        'node', 'cortextos', '--org', 'acme', '--output', join(root, 'ecosystem.config.cjs'),
      ]);
      vi.restoreAllMocks();
    }
    expect(counts[0]).toContain('manages 2 agents');
    expect(counts[1]).toContain('manages 4 agents');
  });

  it('the CLI and daemon query one shared discovery function', () => {
    const ecosystemSource = readFileSync('src/cli/ecosystem.ts', 'utf8');
    const managerSource = readFileSync('src/daemon/agent-manager.ts', 'utf8');
    expect(ecosystemSource).toContain('discoverSourceAgentCandidates(projectRoot)');
    expect(managerSource).toContain('discoverSourceAgentCandidates(this.frameworkRoot)');
    expect(ecosystemSource).not.toContain('readdirSync');
  });
});
