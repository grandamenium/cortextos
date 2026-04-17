/**
 * Unit tests for mergeAgentSettingsIntoWorkingDir.
 *
 * Background: `cortextos add-agent --working-directory <path>` installs the
 * agent's hooks into `<path>/.claude/settings.local.json` so Claude Code
 * picks them up when it runs with cwd = <path>. The merge must be safe:
 * preserve user-owned customizations, refuse to overwrite conflicting hooks,
 * stay idempotent on re-runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeAgentSettingsIntoWorkingDir, ClaudeSettings } from '../../../src/utils/merge-settings';

const AGENT_SETTINGS: ClaudeSettings = {
  permissions: { allow: ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch'] },
  hooks: {
    PermissionRequest: [
      {
        matcher: 'ExitPlanMode',
        hooks: [{ type: 'command', command: 'cortextos bus hook-planmode-telegram', timeout: 1860 }],
      },
      {
        hooks: [{ type: 'command', command: 'cortextos bus hook-permission-telegram', timeout: 1860 }],
      },
    ],
    PreToolUse: [
      {
        matcher: 'AskUserQuestion',
        hooks: [{ type: 'command', command: 'cortextos bus hook-ask-telegram', timeout: 10 }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'cortextos bus hook-idle-flag', timeout: 5 }] }],
  },
  statusLine: { type: 'command', command: 'bash /framework/bus/hook-statusline.sh' },
};

describe('mergeAgentSettingsIntoWorkingDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'merge-settings-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const readResult = (): ClaudeSettings =>
    JSON.parse(readFileSync(join(tempDir, '.claude', 'settings.local.json'), 'utf-8')) as ClaudeSettings;

  it('creates .claude/settings.local.json from scratch when the working dir is empty', () => {
    const result = mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);

    expect(result.fileExistedBefore).toBe(false);
    expect(result.hooksInstalled).toBe(4); // 2 PermissionRequest + 1 PreToolUse + 1 Stop
    expect(result.hooksSkipped).toBe(0);
    expect(result.statusLineInstalled).toBe(true);
    expect(result.warnings).toEqual([]);

    const written = readResult();
    expect(written.permissions?.allow).toContain('Bash');
    expect(written.hooks?.PermissionRequest).toHaveLength(2);
    expect(written.statusLine?.command).toContain('hook-statusline.sh');
  });

  it('is idempotent — re-running the same merge produces no changes and no warnings', () => {
    mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);
    const snapshot = readResult();

    const second = mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);
    expect(second.fileExistedBefore).toBe(true);
    expect(second.hooksInstalled).toBe(0);
    expect(second.hooksAlreadyPresent).toBeGreaterThanOrEqual(4);
    expect(second.hooksSkipped).toBe(0);
    expect(second.warnings).toEqual([]);

    expect(readResult()).toEqual(snapshot);
  });

  it('preserves user-owned keys not touched by the agent settings', () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tempDir, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          mcpServers: { custom: { command: 'my-mcp' } },
          customKey: { foo: 'bar' },
          permissions: { allow: ['Grep'] },
        },
        null,
        2
      )
    );

    mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);
    const written = readResult() as any;

    expect(written.mcpServers.custom.command).toBe('my-mcp');
    expect(written.customKey.foo).toBe('bar');
    // permissions.allow should be union
    expect(written.permissions.allow).toContain('Grep');
    expect(written.permissions.allow).toContain('Bash');
  });

  it('skips + warns when user has the same matcher with a DIFFERENT command', () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tempDir, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'AskUserQuestion',
                hooks: [{ type: 'command', command: 'my-custom-ask-hook.sh', timeout: 30 }],
              },
            ],
          },
        },
        null,
        2
      )
    );

    const result = mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);

    expect(result.hooksSkipped).toBeGreaterThanOrEqual(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toContain('AskUserQuestion');
    expect(result.warnings[0]).toContain('hook-ask-telegram');

    // User's custom hook is untouched
    const written = readResult();
    const ask = written.hooks?.PreToolUse?.find(e => e.matcher === 'AskUserQuestion');
    expect(ask?.hooks[0].command).toBe('my-custom-ask-hook.sh');

    // But our OTHER hooks still installed
    expect(written.hooks?.PermissionRequest).toBeDefined();
    expect(written.hooks?.Stop).toBeDefined();
  });

  it('keeps the user statusLine and warns when it differs from ours', () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tempDir, '.claude', 'settings.local.json'),
      JSON.stringify(
        { statusLine: { type: 'command', command: 'my-custom-statusline.sh' } },
        null,
        2
      )
    );

    const result = mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);

    expect(result.statusLineInstalled).toBe(false);
    expect(result.statusLineKept).toBe(true);
    expect(result.warnings.some(w => w.includes('statusLine'))).toBe(true);

    const written = readResult();
    expect(written.statusLine?.command).toBe('my-custom-statusline.sh');
  });

  it('creates .claude subdirectory if it does not exist', () => {
    expect(existsSync(join(tempDir, '.claude'))).toBe(false);
    mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);
    expect(existsSync(join(tempDir, '.claude'))).toBe(true);
    expect(existsSync(join(tempDir, '.claude', 'settings.local.json'))).toBe(true);
  });

  it('throws a clear error if the existing settings.local.json is unparseable', () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true });
    writeFileSync(join(tempDir, '.claude', 'settings.local.json'), '{ this is not json');

    expect(() => mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS)).toThrow(
      /Cannot parse existing .*settings\.local\.json/
    );
  });

  it('handles agent settings with no hooks / no statusLine (graceful partial)', () => {
    const minimal: ClaudeSettings = { permissions: { allow: ['Bash'] } };
    const result = mergeAgentSettingsIntoWorkingDir(tempDir, minimal);
    expect(result.hooksInstalled).toBe(0);
    expect(result.statusLineInstalled).toBe(false);
    expect(result.permissionsAdded).toBe(1);
    expect(result.warnings).toEqual([]);

    const written = readResult();
    expect(written.permissions?.allow).toEqual(['Bash']);
  });

  it('treats entries with no matcher as a single bucket (no-matcher matcher key)', () => {
    // Ensure the no-matcher entry from PermissionRequest also installs cleanly.
    const result = mergeAgentSettingsIntoWorkingDir(tempDir, AGENT_SETTINGS);
    expect(result.warnings).toEqual([]);

    const written = readResult();
    const noMatcher = written.hooks?.PermissionRequest?.find(e => e.matcher === undefined);
    expect(noMatcher).toBeDefined();
    expect(noMatcher?.hooks[0].command).toBe('cortextos bus hook-permission-telegram');
  });
});
