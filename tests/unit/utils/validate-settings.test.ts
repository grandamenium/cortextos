import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateAgentSettings, validateAgentSettingsForDir } from '../../../src/utils/validate-settings.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `validate-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSettings(dir: string, content: unknown): string {
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const path = join(claudeDir, 'settings.json');
  writeFileSync(path, JSON.stringify(content), 'utf-8');
  return path;
}

describe('validateAgentSettings', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('passes when settings.json does not exist', () => {
    const result = validateAgentSettings(join(tmpDir, 'nonexistent', 'settings.json'));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes with valid hook event names', () => {
    const path = writeSettings(tmpDir, {
      hooks: {
        PreToolUse: [{ command: 'echo test' }],
        PostToolUse: [{ command: 'echo test' }],
        SessionEnd: [{ command: 'cortextos bus log-event' }],
      },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors on invalid hook event name (FM21)', () => {
    const path = writeSettings(tmpDir, {
      hooks: {
        PreCommit: [{ command: 'bash verify.sh', blocking: true }],
      },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('PreCommit');
    expect(result.errors[0]).toContain('Invalid hook event type');
  });

  it('errors on multiple invalid hook event names', () => {
    const path = writeSettings(tmpDir, {
      hooks: {
        PreCommit: [{ command: 'echo a' }],
        PostCommit: [{ command: 'echo b' }],
      },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('errors on invalid regex in hook matcher (FM23)', () => {
    const path = writeSettings(tmpDir, {
      hooks: {
        PreToolUse: [{ command: 'echo test', matcher: '(unclosed' }],
      },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid regex'))).toBe(true);
  });

  it('passes with valid regex in hook matcher', () => {
    const path = writeSettings(tmpDir, {
      hooks: {
        PreToolUse: [{ command: 'echo test', matcher: 'Bash|Edit|Write' }],
      },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('warns on empty permission pattern (FM22)', () => {
    const path = writeSettings(tmpDir, {
      permissions: { allow: ['', 'Bash'] },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(true); // warnings don't block
    expect(result.warnings.some(w => w.includes('Empty'))).toBe(true);
  });

  it('passes with all-valid config', () => {
    const path = writeSettings(tmpDir, {
      hooks: {
        PreToolUse: [{ command: 'cortextos bus log-event', matcher: 'Bash' }],
        SessionEnd: [{ command: 'cortextos bus update-heartbeat offline' }],
      },
      permissions: { allow: ['Bash', 'Read', 'Edit'] },
    });
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('errors on invalid JSON', () => {
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const path = join(claudeDir, 'settings.json');
    writeFileSync(path, '{ invalid json }', 'utf-8');
    const result = validateAgentSettings(path);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('not valid JSON');
  });

  it('validateAgentSettingsForDir resolves .claude/settings.json', () => {
    writeSettings(tmpDir, {
      hooks: {
        PreCommit: [{ command: 'bad' }],
      },
    });
    const result = validateAgentSettingsForDir(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('PreCommit');
  });
});
