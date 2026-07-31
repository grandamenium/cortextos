import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findCodexOptInIssues, resolveDoctorFrameworkRoot } from '../../../src/cli/doctor';

const roots: string[] = [];

function seedAgent(config: Record<string, unknown>): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'cortextos-doctor-codex-'));
  roots.push(root);
  const agentDir = join(root, 'orgs', 'acme', 'agents', 'worker');
  mkdirSync(agentDir, { recursive: true });
  const configPath = join(agentDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { root, configPath };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('doctor codex opt-in migration guidance', () => {
  it('uses the configured framework root even when doctor runs elsewhere', () => {
    expect(resolveDoctorFrameworkRoot('/unrelated/cwd', {
      CTX_FRAMEWORK_ROOT: '/configured/framework',
      CTX_PROJECT_ROOT: '/legacy/framework',
    })).toBe('/configured/framework');

    expect(resolveDoctorFrameworkRoot('/unrelated/cwd', {
      CTX_PROJECT_ROOT: '/legacy/framework',
    })).toBe('/legacy/framework');
  });

  it('reports legacy codex configs that are missing the opt-in', () => {
    const { root, configPath } = seedAgent({ runtime: 'codex-app-server', enabled: true });

    expect(findCodexOptInIssues(root)).toEqual([{ org: 'acme', agent: 'worker', configPath }]);
  });

  it('reports a malformed opt-in instead of treating it as deliberate', () => {
    const { root, configPath } = seedAgent({
      runtime: 'codex-app-server',
      allow_codex_app_server: 'true',
    });

    expect(findCodexOptInIssues(root)).toEqual([{ org: 'acme', agent: 'worker', configPath }]);
  });

  it.each([
    { runtime: 'codex-app-server', allow_codex_app_server: true },
    { runtime: 'codex-app-server', allow_codex_app_server: false },
    { runtime: 'claude-code' },
  ])('does not flag safe or non-codex config %#', config => {
    const { root } = seedAgent(config);

    expect(findCodexOptInIssues(root)).toEqual([]);
  });
});
