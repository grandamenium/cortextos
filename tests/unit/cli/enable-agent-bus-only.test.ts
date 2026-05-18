import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const validateCredentialsSpy = vi.fn().mockResolvedValue({
  ok: true,
  botUsername: 'test-bot',
  chatType: 'private',
  chatTitle: null,
});

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    validateCredentials(...args: unknown[]) {
      return validateCredentialsSpy(...args);
    }
  },
  formatValidateError: () => 'validation error',
}));

const daemonSendSpy = vi.fn().mockResolvedValue({ success: true, data: 'started' });
const daemonRunningSpy = vi.fn().mockResolvedValue(false);

vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    constructor(_instance: string) {}
    isDaemonRunning() {
      return daemonRunningSpy();
    }
    send(...args: unknown[]) {
      return daemonSendSpy(...args);
    }
  },
}));

import { enableAgentCommand } from '../../../src/cli/enable-agent';

describe('enable-agent telegram_enabled=false support', () => {
  let tempHome: string;
  let tempProjectRoot: string;
  let originalHome: string | undefined;
  let originalFrameworkRoot: string | undefined;
  let originalProjectRoot: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'enable-agent-home-'));
    tempProjectRoot = mkdtempSync(join(tmpdir(), 'enable-agent-project-'));
    originalHome = process.env.HOME;
    originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
    originalProjectRoot = process.env.CTX_PROJECT_ROOT;
    originalCwd = process.cwd();

    process.env.HOME = tempHome;
    process.env.CTX_FRAMEWORK_ROOT = tempProjectRoot;
    delete process.env.CTX_PROJECT_ROOT;
    process.chdir(tempProjectRoot);

    validateCredentialsSpy.mockClear();
    daemonSendSpy.mockClear();
    daemonRunningSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
    if (originalProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
    else process.env.CTX_PROJECT_ROOT = originalProjectRoot;
    process.chdir(originalCwd);
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  function setupAgent(agent: string, configBody: string, envBody: string): string {
    const agentDir = join(tempProjectRoot, 'orgs', 'testorg', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), configBody);
    writeFileSync(join(agentDir, '.env'), envBody);
    return agentDir;
  }

  it('enables a bus-only agent without BOT_TOKEN or CHAT_ID when telegram_enabled is false', async () => {
    setupAgent(
      'ba',
      JSON.stringify({ agent_name: 'ba', enabled: false, telegram_enabled: false }, null, 2),
      '# intentionally no telegram credentials\n',
    );

    await enableAgentCommand.parseAsync(
      ['ba', '--org', 'testorg'],
      { from: 'user' },
    );

    expect(validateCredentialsSpy).not.toHaveBeenCalled();
    expect(daemonRunningSpy).toHaveBeenCalledTimes(1);

    const enabledPath = join(tempHome, '.cortextos', 'default', 'config', 'enabled-agents.json');
    expect(existsSync(enabledPath)).toBe(true);
    const enabledAgents = JSON.parse(readFileSync(enabledPath, 'utf-8')) as Record<string, { enabled?: boolean; org?: string }>;
    expect(enabledAgents.ba).toMatchObject({ enabled: true, org: 'testorg' });
  });

  it('still requires BOT_TOKEN and CHAT_ID for Telegram-enabled agents', async () => {
    setupAgent(
      'larry',
      JSON.stringify({ agent_name: 'larry', enabled: false }, null, 2),
      '# missing telegram credentials\n',
    );

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__TEST_PROCESS_EXIT_${code}__`);
    }) as never);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      enableAgentCommand.parseAsync(
        ['larry', '--org', 'testorg'],
        { from: 'user' },
      )
    ).rejects.toThrow(/__TEST_PROCESS_EXIT_1__/);

    expect(validateCredentialsSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('missing required values: BOT_TOKEN, CHAT_ID');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
