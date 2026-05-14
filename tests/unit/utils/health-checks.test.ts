/**
 * Fleet-resilience plan #4 — health-check registry.
 *
 * Verifies the extraction from src/cli/doctor.ts preserves the contract:
 *   - runAllChecks returns a non-empty Check[] array
 *   - every check has a name, status (pass|warn|fail), and message
 *   - canonical check names from the pre-extraction inline list still appear
 *
 * We deliberately do NOT snapshot the full array because system-state-dependent
 * checks (PM2 installed? Claude auth? cloudflared cert present?) vary
 * across CI hosts. Instead we assert the *names* of the checks that should
 * always be present and validate the schema of every returned entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runAllChecks } from '../../../src/utils/health-checks';

let frameworkRoot: string;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cortextos-health-checks-'));
});

afterEach(() => {
  rmSync(frameworkRoot, { recursive: true, force: true });
});

describe('runAllChecks (fleet-resilience #4 extraction)', () => {
  it('returns a non-empty array of Check entries', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    expect(checks.length).toBeGreaterThan(0);
  });

  it('every returned Check satisfies the schema', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    for (const c of checks) {
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
      expect(['pass', 'warn', 'fail']).toContain(c.status);
      expect(typeof c.message).toBe('string');
      if (c.fix !== undefined) expect(typeof c.fix).toBe('string');
    }
  });

  it('includes the canonical foundation checks (Node, node-pty, state dir)', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const names = checks.map((c) => c.name);
    expect(names).toContain('Node.js version');
    expect(names).toContain('node-pty');
    expect(names).toContain('State directory');
    // Claude Code CLI is always probed (pass or fail).
    expect(names).toContain('Claude Code CLI');
  });

  it('Node.js version check reports pass on a supported runtime', async () => {
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const nodeCheck = checks.find((c) => c.name === 'Node.js version');
    expect(nodeCheck).toBeDefined();
    // This test runs on the project's own Node which is ≥20 (enforced in CI).
    expect(nodeCheck!.status).toBe('pass');
  });

  it('detects a malformed orgs/<org>/profiles.json and emits a warn', async () => {
    const orgDir = join(frameworkRoot, 'orgs', 'acme');
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(orgDir, 'profiles.json'), '{not valid json');
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const profCheck = checks.find((c) => c.name === 'Profiles registry (acme)');
    expect(profCheck).toBeDefined();
    expect(profCheck!.status).toBe('warn');
    expect(profCheck!.message.toLowerCase()).toContain('malformed');
  });

  it('flags analyst doc drift when templates/<file>.md is newer than active', async () => {
    const tpl = join(frameworkRoot, 'templates', 'analyst');
    const active = join(frameworkRoot, 'orgs', 'acme', 'agents', 'analyst');
    mkdirSync(tpl, { recursive: true });
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, 'HEARTBEAT.md'), 'old');
    writeFileSync(join(active, 'GUARDRAILS.md'), 'old');
    // Sleep-equivalent: write template files after the active ones so mtimes differ.
    // statSync resolution is millisecond, so this is reliable.
    const future = Date.now() + 5000;
    writeFileSync(join(tpl, 'HEARTBEAT.md'), 'new');
    writeFileSync(join(tpl, 'GUARDRAILS.md'), 'new');
    // Set mtime explicitly to guarantee ordering across fast filesystems.
    const { utimesSync } = await import('fs');
    utimesSync(join(tpl, 'HEARTBEAT.md'), new Date(future), new Date(future));
    utimesSync(join(tpl, 'GUARDRAILS.md'), new Date(future), new Date(future));
    const checks = await runAllChecks({ instanceId: 'default', frameworkRoot });
    const drift = checks.find((c) => c.name === 'Analyst doc drift (acme)');
    expect(drift).toBeDefined();
    expect(drift!.status).toBe('warn');
    expect(drift!.message).toContain('HEARTBEAT.md');
    expect(drift!.message).toContain('GUARDRAILS.md');
  });
});
