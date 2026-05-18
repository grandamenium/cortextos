/**
 * Regression test: `cortextos add-agent` must write `ALLOWED_USER=` into the
 * generated .env template.
 *
 * Bug context (2026-05-12): the template at src/cli/add-agent.ts only seeded
 * BOT_TOKEN= + CHAT_ID=. Operators filled in token + chat ID, but ALLOWED_USER
 * was never present, so the daemon gate at agent-manager.ts:233 set botToken
 * to undefined and silently skipped the Telegram poller registration. Outbound
 * still worked (bus.ts has no gate), so the agent looked healthy until someone
 * tried to message it from Telegram. Manual restart with hand-edited
 * ALLOWED_USER cured it — confirming the template was the gap.
 *
 * Affected fresh codex-app-server agents reliably; affected fresh claude-code
 * agents identically (same template path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { addAgentCommand } from '../../../src/cli/add-agent';

describe('add-agent .env template: ALLOWED_USER seeded', () => {
  let tempRoot: string;
  let tempHome: string;
  let originalHome: string | undefined;
  let originalCwd: string | undefined;
  let originalFrameworkRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'allowed-user-'));
    tempHome = mkdtempSync(join(tmpdir(), 'allowed-user-home-'));

    originalHome = process.env.HOME;
    originalCwd = process.env.CTX_PROJECT_ROOT;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempRoot;
    process.env.CTX_PROJECT_ROOT = tempRoot;

    const realTemplates = join(__dirname, '..', '..', '..', 'templates');
    symlinkSync(realTemplates, join(tempRoot, 'templates'), 'dir');

    mkdirSync(join(tempRoot, 'orgs', 'testorg', 'agents'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'orgs', 'testorg', 'context.json'),
      JSON.stringify({
        name: 'testorg',
        timezone: 'America/New_York',
        orchestrator: 'orch',
        dashboard_url: 'http://localhost:3000',
        communication_style: 'casual',
        day_mode_start: '08:00',
        day_mode_end: '00:00',
      }),
    );
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.CTX_PROJECT_ROOT = originalCwd;
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('claude-code agents get ALLOWED_USER= in their .env template', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'claude-env-test',
      '--org', 'testorg', '--instance', 'env-test',
    ]);

    const envPath = join(
      tempRoot, 'orgs', 'testorg', 'agents', 'claude-env-test', '.env',
    );
    expect(existsSync(envPath)).toBe(true);
    const env = readFileSync(envPath, 'utf-8');

    expect(env).toMatch(/^ALLOWED_USER=$/m);
    expect(env).toMatch(/^BOT_TOKEN=$/m);
    expect(env).toMatch(/^CHAT_ID=$/m);
    expect(env).toContain('numeric Telegram user ID');
  });

  it('codex-app-server agents get ALLOWED_USER= in their .env template', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await addAgentCommand.parseAsync([
      'node', 'cli', 'codex-env-test', '--runtime', 'codex-app-server',
      '--org', 'testorg', '--instance', 'env-test',
    ]);

    const envPath = join(
      tempRoot, 'orgs', 'testorg', 'agents', 'codex-env-test', '.env',
    );
    expect(existsSync(envPath)).toBe(true);
    const env = readFileSync(envPath, 'utf-8');

    expect(env).toMatch(/^ALLOWED_USER=$/m);
    expect(env).toMatch(/^BOT_TOKEN=$/m);
    expect(env).toMatch(/^CHAT_ID=$/m);
  });
});
