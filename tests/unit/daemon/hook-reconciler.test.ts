import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureRequiredHooks, REQUIRED_HOOKS } from '../../../src/daemon/hook-reconciler.js';

const STOP_CMD = 'cortextos bus hook-idle-flag';

function agentDirWith(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-reconciler-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2)
  );
  return dir;
}
function readSettings(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8'));
}

describe('ensureRequiredHooks', () => {
  let dirs: string[] = [];
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs = []; });
  const track = (d: string) => { dirs.push(d); return d; };

  it('adds the Stop hook when the event is entirely missing (kirk/spock case)', () => {
    const dir = track(agentDirWith({ hooks: { PreToolUse: [] } }));
    const added = ensureRequiredHooks(dir);
    expect(added).toEqual([`Stop → ${STOP_CMD}`]);
    const s = readSettings(dir);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0].hooks[0].command).toBe(STOP_CMD);
    expect(s.hooks.Stop[0].hooks[0].timeout).toBe(5);
    expect(s.hooks.PreToolUse).toEqual([]); // untouched
  });

  it('adds hooks key when settings has none at all', () => {
    const dir = track(agentDirWith({ model: 'opus' }));
    const added = ensureRequiredHooks(dir);
    expect(added.length).toBe(REQUIRED_HOOKS.length);
    const s = readSettings(dir);
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop[0].hooks[0].command).toBe(STOP_CMD);
  });

  it('is idempotent — hook already present means no change', () => {
    const dir = track(agentDirWith({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: STOP_CMD, timeout: 5 }] }] },
    }));
    const before = readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8');
    expect(ensureRequiredHooks(dir)).toEqual([]);
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8')).toBe(before);
  });

  it('detects presence by command substring within existing Stop groups', () => {
    const dir = track(agentDirWith({
      hooks: { Stop: [{ hooks: [
        { type: 'command', command: 'some-other-hook' },
        { type: 'command', command: `${STOP_CMD} --extra-arg` },
      ] }] },
    }));
    expect(ensureRequiredHooks(dir)).toEqual([]);
  });

  it('preserves existing user hooks when appending', () => {
    const dir = track(agentDirWith({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-custom-stop' }] }] },
    }));
    const added = ensureRequiredHooks(dir);
    expect(added).toHaveLength(1);
    const s = readSettings(dir);
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop[0].hooks[0].command).toBe('user-custom-stop');
    expect(s.hooks.Stop[1].hooks[0].command).toBe(STOP_CMD);
  });

  it('leaves malformed JSON untouched and reports nothing added', () => {
    const dir = track(agentDirWith('{ not json ]]'));
    const logs: string[] = [];
    expect(ensureRequiredHooks(dir, m => logs.push(m))).toEqual([]);
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf-8')).toBe('{ not json ]]');
    expect(logs.join(' ')).toMatch(/malformed|unreadable/);
  });

  it('skips when settings.json does not exist (no invention)', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'hook-reconciler-')));
    expect(ensureRequiredHooks(dir)).toEqual([]);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
  });

  it('leaves non-object hooks value untouched', () => {
    const dir = track(agentDirWith({ hooks: 'weird' }));
    expect(ensureRequiredHooks(dir)).toEqual([]);
    expect(readSettings(dir).hooks).toBe('weird');
  });
});
