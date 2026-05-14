/**
 * Tests for the PR2-added `bus send` generic command + `send-telegram`
 * hard-error alias semantics.
 *
 * `bus send <agent> <message>`:
 *   - `config.connector === 'none'` → stderr warn + exit 0 (silent drop)
 *   - `config.connector === 'telegram'` (or inferred) → routes via connector
 *
 * `bus send-telegram <chat-id> <message>`:
 *   - `config.connector === 'none'` (or any non-telegram) → hard-error exit 1
 *   - `config.connector === 'telegram'` (or absent) → existing behavior
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const CLI_PATH = join(__dirname, '..', '..', '..', 'dist', 'cli.js');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
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

describe('bus send (PR2)', () => {
  let agentDir: string;

  beforeAll(() => {
    // Only build if dist/cli.js doesn't already exist — avoids racing
    // other test files' beforeAll(npm run build) under vitest parallelism.
    const fs = require('fs');
    if (!fs.existsSync(CLI_PATH)) {
      try {
        execSync('npm run build', { cwd: join(__dirname, '..', '..', '..'), stdio: 'pipe' });
      } catch (err) {
        throw new Error(`Failed to build before running CLI tests: ${err}`);
      }
    }
  });

  beforeEach(() => {
    agentDir = join(tmpdir(), `bus-send-test-${Date.now()}-${Math.random()}`);
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  describe('bus send <agent> <message>', () => {
    it('connector: "none" → silent drop + stderr warn, exit 0', () => {
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ connector: 'none' }));
      const result = runCli(['bus', 'send', 'test-agent', 'hello world'], {
        CTX_AGENT_DIR: agentDir,
        CTX_AGENT_NAME: 'test-agent',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('connector \'none\'');
      expect(result.stderr).toContain('message dropped');
      expect(result.stdout).not.toContain('Message sent');
    });
  });

  describe('bus send-telegram (PR2 hard-error alias)', () => {
    it('connector: "none" → hard-error exit 1 with helpful message', () => {
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ connector: 'none' }));
      const result = runCli(['bus', 'send-telegram', '12345', 'hello'], {
        CTX_AGENT_DIR: agentDir,
        CTX_AGENT_NAME: 'test-agent',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not \'telegram\'');
      expect(result.stderr).toContain('bus send');
    });

    it('config.connector absent → falls through to legacy resolver behavior (BOT_TOKEN check)', () => {
      // No config.json at all → falls through to the existing BOT_TOKEN
      // hard-exit (no BOT_TOKEN in env either). Pre-PR2 behavior preserved.
      const result = runCli(['bus', 'send-telegram', '12345', 'hello'], {
        CTX_AGENT_DIR: agentDir,
        CTX_AGENT_NAME: 'test-agent',
        BOT_TOKEN: '', // explicitly empty
      });
      expect(result.status).toBe(1);
      // Old hard-error message about BOT_TOKEN — not the new connector-kind message
      expect(result.stderr).toContain('BOT_TOKEN');
    });

    it('config.connector: "telegram" + no BOT_TOKEN → existing BOT_TOKEN hard-error (not the new connector-kind error)', () => {
      writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ connector: 'telegram' }));
      const result = runCli(['bus', 'send-telegram', '12345', 'hello'], {
        CTX_AGENT_DIR: agentDir,
        CTX_AGENT_NAME: 'test-agent',
        BOT_TOKEN: '',
      });
      expect(result.status).toBe(1);
      // Falls through the new gate (telegram is allowed) into the existing
      // BOT_TOKEN check — same message as today.
      expect(result.stderr).toContain('BOT_TOKEN');
      expect(result.stderr).not.toContain('not \'telegram\'');
    });
  });
});
