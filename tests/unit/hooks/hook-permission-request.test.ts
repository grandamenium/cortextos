/**
 * Tests for the load-bearing tool-class-aware behavior in
 * hook-permission-request — the PR2 fix that makes no-Telegram agents
 * functional. Pre-PR2's hook-permission-telegram denied ALL tool calls
 * when creds were missing; PR2's hook-permission-request:
 *
 *   - Safe read-only tools (Read/Glob/Grep/LS/NotebookRead) → auto-allow.
 *   - Write/exec/network tools → exit-0 with no JSON output, triggering
 *     Claude Code's built-in terminal permission prompt.
 *   - `require_remote_approval: true` opt-in restores blanket deny.
 *   - `.claude/` directory operations → auto-allow (preserved from
 *     pre-PR2 behavior).
 *
 * Tests spawn the built hook as a child process to exercise the real
 * code path (no mocking of stdin/stdout/process.exit).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const HOOK_PATH = join(__dirname, '..', '..', '..', 'dist', 'hooks', 'hook-permission-request.js');

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(toolName: string, toolInput: object, env: NodeJS.ProcessEnv): HookResult {
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 5000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseDecision(stdout: string): { behavior?: 'allow' | 'deny'; message?: string } | null {
  if (!stdout.trim()) return null;
  try {
    const obj = JSON.parse(stdout);
    return obj.hookSpecificOutput?.decision ?? null;
  } catch {
    return null;
  }
}

describe('hook-permission-request', () => {
  let agentDir: string;

  beforeAll(() => {
    // dist/hooks/hook-permission-request.js must exist for these tests.
    // We build only if missing — parallel test files would race on
    // concurrent npm-run-build invocations otherwise (the build cleans
    // dist/, then writes; a parallel test reading dist mid-write fails).
    const fs = require('fs');
    if (!fs.existsSync(HOOK_PATH)) {
      try {
        execSync('npm run build', { cwd: join(__dirname, '..', '..', '..'), stdio: 'pipe' });
      } catch (err) {
        throw new Error(`Failed to build before running hook tests: ${err}`);
      }
    }
  });

  beforeEach(() => {
    agentDir = join(tmpdir(), `hook-permission-test-${Date.now()}-${Math.random()}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  describe('connector: "none" (no remote channel)', () => {
    beforeEach(() => {
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ connector: 'none' }));
    });

    it('safe read-only tools auto-allow', () => {
      for (const toolName of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']) {
        const result = runHook(
          toolName,
          { file_path: '/tmp/x.txt' },
          { CTX_AGENT_DIR: agentDir, CTX_AGENT_NAME: 'test-agent' },
        );
        expect(result.status, `${toolName} should exit 0`).toBe(0);
        const decision = parseDecision(result.stdout);
        expect(decision?.behavior, `${toolName} should be allow`).toBe('allow');
      }
    });

    it('write/exec/network tools exit-0 with no JSON (pass-through to Claude built-in prompt)', () => {
      for (const toolName of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) {
        const result = runHook(
          toolName,
          { command: 'rm -rf /' },
          { CTX_AGENT_DIR: agentDir, CTX_AGENT_NAME: 'test-agent' },
        );
        expect(result.status, `${toolName} should exit 0`).toBe(0);
        expect(result.stdout.trim(), `${toolName} should have empty stdout (pass-through)`).toBe('');
      }
    });
  });

  describe('require_remote_approval: true (strict mode)', () => {
    beforeEach(() => {
      writeFileSync(
        join(agentDir, 'config.json'),
        JSON.stringify({ connector: 'none', require_remote_approval: true }),
      );
    });

    it('all non-safe tools deny when no creds + strict mode', () => {
      for (const toolName of ['Bash', 'Edit', 'Write']) {
        const result = runHook(
          toolName,
          { command: 'echo hi' },
          { CTX_AGENT_DIR: agentDir, CTX_AGENT_NAME: 'test-agent' },
        );
        const decision = parseDecision(result.stdout);
        expect(decision?.behavior, `${toolName} should be deny in strict mode`).toBe('deny');
      }
    });

    it('.claude/ directory ops STILL auto-allow under strict mode', () => {
      // The .claude/ auto-allow check runs BEFORE the strict-mode gate
      // (preserves pre-PR2 behavior).
      const result = runHook(
        'Write',
        { file_path: join(agentDir, '.claude', 'settings.json') },
        { CTX_AGENT_DIR: agentDir, CTX_AGENT_NAME: 'test-agent' },
      );
      const decision = parseDecision(result.stdout);
      expect(decision?.behavior).toBe('allow');
    });
  });

  describe('special-case tools', () => {
    beforeEach(() => {
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ connector: 'none' }));
    });

    it('AskUserQuestion and ExitPlanMode exit cleanly (handled by other hooks)', () => {
      for (const toolName of ['AskUserQuestion', 'ExitPlanMode']) {
        const result = runHook(
          toolName,
          {},
          { CTX_AGENT_DIR: agentDir, CTX_AGENT_NAME: 'test-agent' },
        );
        expect(result.status, `${toolName} should exit 0`).toBe(0);
        expect(result.stdout.trim()).toBe('');
      }
    });
  });
});
