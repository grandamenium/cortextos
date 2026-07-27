import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findClaudeOAuthOverrideChecks } from '../../../src/cli/doctor';

describe('doctor Claude OAuth override audit', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function makeRoot(): string {
    root = mkdtempSync(join(tmpdir(), 'doctor-token-overrides-'));
    mkdirSync(join(root, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    return root;
  }

  it('flags Anthropic override credentials in an agent .env', () => {
    const frameworkRoot = makeRoot();
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', '.env'), [
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-good',
      'ANTHROPIC_AUTH_TOKEN = legacy-bearer',
      'ANTHROPIC_API_KEY=legacy-api',
      '# ANTHROPIC_AUTH_TOKEN=commented-out-is-ignored',
      'ANTHROPIC_API_KEY=',
      '',
    ].join('\n'), 'utf-8');

    const checks = findClaudeOAuthOverrideChecks(frameworkRoot, {});

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'Claude OAuth override: acme/alice',
      status: 'fail',
    });
    expect(checks[0].message).toContain('ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY');
    expect(checks[0].fix).toContain('orgs/acme/agents/alice/.env');
  });

  it('flags Anthropic override credentials in the current process env', () => {
    const frameworkRoot = makeRoot();

    const checks = findClaudeOAuthOverrideChecks(frameworkRoot, {
      ANTHROPIC_AUTH_TOKEN: 'legacy-bearer',
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'Claude OAuth override: process env ANTHROPIC_AUTH_TOKEN',
      status: 'fail',
    });
    expect(checks[0].fix).toContain('Unset ANTHROPIC_AUTH_TOKEN');
  });

  it('passes when only CLAUDE_CODE_OAUTH_TOKEN is present', () => {
    const frameworkRoot = makeRoot();
    writeFileSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', '.env'), [
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-good',
      '',
    ].join('\n'), 'utf-8');

    expect(findClaudeOAuthOverrideChecks(frameworkRoot, {})).toEqual([]);
  });
});
