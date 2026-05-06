/**
 * tests/integration/upgrade-cron-teaching-cli.test.ts
 *
 * Drives the compiled `dist/cli.js bus upgrade-cron-teaching` against a
 * tmp-fixture frameworkRoot.  Confirms agent-resolution, scan-only
 * reporting, --json output, and --apply substitutions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI  = join(REPO_ROOT, 'dist', 'cli.js');

let frameworkRoot: string;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'upgrade-cron-teach-'));
});

afterEach(() => {
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }
});

function writeAgentFile(agent: string, rel: string, body: string): string {
  const fp = join(frameworkRoot, 'orgs', 'lifeos', 'agents', agent, rel);
  mkdirSync(join(fp, '..'), { recursive: true });
  writeFileSync(fp, body, 'utf-8');
  return fp;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, 'bus', 'upgrade-cron-teaching', ...args],
      { env: { ...process.env, CTX_FRAMEWORK_ROOT: frameworkRoot, CTX_ROOT: frameworkRoot } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describe.skipIf(!existsSync(DIST_CLI))('bus upgrade-cron-teaching CLI', () => {
  it('reports zero stale references for a clean agent (exit 0)', async () => {
    writeAgentFile('clean', 'CLAUDE.md',
      'Crons are daemon-managed. Do NOT use CronCreate or /loop. Use cortextos bus add-cron.\n');
    const { stdout, code } = await runCli(['clean']);
    expect(code).toBe(0);
    expect(stdout).toContain('no stale cron-teaching references');
  });

  it('reports stale references and exits non-zero in scan-only mode', async () => {
    writeAgentFile('dirty', 'CLAUDE.md',
      'Use CronCreate to register a cron.\n(configured in config.json)\n');
    const { stdout, code } = await runCli(['dirty']);
    expect(code).not.toBe(0);
    expect(stdout).toContain('CronCreate');
    expect(stdout).toContain('(configured in config.json)');
    expect(stdout).toContain('--apply');
    // Ensure file untouched in scan-only mode.
    const after = readFileSync(
      join(frameworkRoot, 'orgs', 'lifeos', 'agents', 'dirty', 'CLAUDE.md'),
      'utf-8',
    );
    expect(after).toContain('(configured in config.json)');
  });

  it('--apply substitutes the safe pattern but leaves CronCreate references alone', async () => {
    const file = writeAgentFile('mixed', 'AGENTS.md',
      'Heartbeat (configured in config.json).\nUse CronCreate to register.\n');
    const { stdout } = await runCli(['mixed', '--apply']);
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('(configured via cortextos bus add-cron)');
    expect(after).not.toContain('(configured in config.json)');
    expect(after).toContain('Use CronCreate to register.');
    expect(stdout).toContain('1 substitution(s) applied');
  });

  it('--json emits machine-readable output', async () => {
    writeAgentFile('jsonagent', 'CLAUDE.md',
      'Use CronCreate to register heartbeat.\n');
    const { stdout, code } = await runCli(['jsonagent', '--json']);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].agent).toBe('jsonagent');
    expect(parsed[0].matches.length).toBeGreaterThan(0);
    expect(parsed[0].matches[0].pattern).toBe('CronCreate');
  });

  it('errors out when the agent does not exist', async () => {
    const { stderr, code } = await runCli(['ghost-agent']);
    expect(code).not.toBe(0);
    expect(stderr).toContain("'ghost-agent' not found");
  });

  it('all-agents form scans every agent under orgs/*/agents/', async () => {
    writeAgentFile('a1', 'CLAUDE.md', 'Use CronCreate.\n');
    writeAgentFile('a2', 'CLAUDE.md', 'Crons are daemon-managed.\n');
    const { stdout, code } = await runCli([]);
    expect(code).not.toBe(0); // a1 has stale refs
    expect(stdout).toMatch(/a1: 1 stale reference/);
    expect(stdout).toMatch(/✓ a2: no stale cron-teaching references/);
  });
});
