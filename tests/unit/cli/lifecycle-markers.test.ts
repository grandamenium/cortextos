/**
 * Regression tests for BUG-036.
 *
 * The SessionEnd crash-alert hook (src/hooks/hook-crash-alert.ts) decides
 * whether an agent's exit was a crash by checking for marker files in
 * ~/.cortextos/<inst>/state/<agent>/. If no marker is found, it defaults
 * to "crash" and fires a 🚨 CRASH alarm via Telegram.
 *
 * Before this fix, `cortextos disable` and `cortextos stop` did not write
 * any marker, so every intentional shutdown was misclassified as a crash —
 * trust-destroying. The fix is two helpers (writeDisableMarker and
 * writeStopMarker) that drop the right marker before the IPC stop call.
 *
 * These tests verify the helpers write the correct file at the correct
 * path with the correct content. Cycle 2 of the PR methodology verifies
 * the end-to-end behavior with a real Telegram bot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { writeDisableMarker } from '../../../src/cli/enable-agent';
import { writeStopMarker } from '../../../src/cli/stop';

describe('BUG-036: lifecycle marker writes', () => {
  // The helpers write under homedir() — point HOME at a temp dir for the test
  // so we don't pollute the user's real ~/.cortextos.
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-bug036-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('writeDisableMarker', () => {
    it('writes .user-disable at the correct path with the given reason', () => {
      writeDisableMarker('default', 'commander', 'disabled via cortextos disable');

      const expectedPath = join(homedir(), '.cortextos', 'default', 'state', 'commander', '.user-disable');
      expect(existsSync(expectedPath)).toBe(true);
      expect(readFileSync(expectedPath, 'utf-8')).toBe('disabled via cortextos disable');
    });

    it('creates the state directory if it does not exist', () => {
      // The state dir does not exist yet — helper must mkdirSync it
      writeDisableMarker('cortextos1', 'analyst', 'test reason');

      const stateDir = join(homedir(), '.cortextos', 'cortextos1', 'state', 'analyst');
      expect(existsSync(stateDir)).toBe(true);
    });

    it('does not throw when the filesystem write fails', () => {
      // Pass an instance id with a NUL byte to force a filesystem error.
      // The helper must swallow the error so it never blocks the user-facing
      // disable command — worst case the user gets a false crash alarm,
      // best case they get the right notification.
      expect(() =>
        writeDisableMarker('bad\0instance', 'commander', 'reason'),
      ).not.toThrow();
    });
  });

  describe('writeStopMarker', () => {
    it('writes .user-stop at the correct path with the given reason', () => {
      writeStopMarker('default', 'commander', 'stopped via cortextos stop');

      const expectedPath = join(homedir(), '.cortextos', 'default', 'state', 'commander', '.user-stop');
      expect(existsSync(expectedPath)).toBe(true);
      expect(readFileSync(expectedPath, 'utf-8')).toBe('stopped via cortextos stop');
    });

    it('creates the state directory if it does not exist', () => {
      writeStopMarker('cortextos1', 'analyst', 'test reason');

      const stateDir = join(homedir(), '.cortextos', 'cortextos1', 'state', 'analyst');
      expect(existsSync(stateDir)).toBe(true);
    });

    it('does not throw when the filesystem write fails', () => {
      expect(() =>
        writeStopMarker('bad\0instance', 'commander', 'reason'),
      ).not.toThrow();
    });

    it('writes a different marker file from disable (regression: do not collide)', () => {
      // BUG-036 distinguishes disable (semi-permanent) from stop (transient).
      // The hook uses different emojis (⏸️ vs ⏹️) so the user can tell at a glance.
      // Verify the two helpers write to different files even for the same agent.
      writeDisableMarker('default', 'commander', 'disable');
      writeStopMarker('default', 'commander', 'stop');

      const stateDir = join(homedir(), '.cortextos', 'default', 'state', 'commander');
      expect(existsSync(join(stateDir, '.user-disable'))).toBe(true);
      expect(existsSync(join(stateDir, '.user-stop'))).toBe(true);
    });
  });
});
