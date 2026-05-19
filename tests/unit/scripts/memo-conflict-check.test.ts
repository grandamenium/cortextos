/* eslint-disable @typescript-eslint/no-require-imports */
import { describe, test, expect, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { checkDiff, formatComment, _test } = require('../../../scripts/memo-conflict-check') as any;

beforeEach(() => {
  _test.clearCache();
  _test._memoryPatternCache = []; // bypass memory file scanning in unit tests
});

describe('checkDiff — critical patterns', () => {
  test('flags invalid codex model slug gpt-5-codex', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+const model = 'gpt-5-codex';\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].critical).toBe(true);
    expect(result.conflicts[0].pattern).toMatch(/gpt-5-codex/);
  });

  test('flags OPEN_BRAIN_KEY reference', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+const key = process.env.OPEN_BRAIN_KEY;\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].critical).toBe(true);
  });

  test('flags ChromaDB import', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+import { ChromaDB } from 'chromadb';\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].critical).toBe(true);
  });

  test('flags deprecated realtime sessions endpoint', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+const url = 'https://api.openai.com/v1/realtime/sessions';\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].critical).toBe(true);
  });

  test('passes clean diff with no blocked patterns', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n+const model = 'gpt-5.5';\n+const url = 'wss://api.openai.com/v1/realtime';\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });

  test('ignores removed lines (starting with -)', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-const model = 'gpt-5-codex'; // old\n+const model = 'gpt-5.5';\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(false);
  });

  test('ignores context lines (no + prefix)', () => {
    const diff = `--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n const before = true;\n+const model = 'gpt-5.4-mini';\n const after = true;\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(false);
  });

  test('handles null diff gracefully', () => {
    const result = checkDiff(null);
    expect(result.hasConflict).toBe(false);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('checkDiff — memory-extracted patterns', () => {
  test('flags token from memory patterns', () => {
    _test._memoryPatternCache = [
      { token: 'popup-listener', description: 'Retired: popup-listener LaunchAgent' },
    ];
    const diff = `--- a/file.sh\n+++ b/file.sh\n@@ -1 +1 @@\n+launchctl load popup-listener.plist\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(true);
    expect(result.conflicts[0].critical).toBe(false);
    expect(result.conflicts[0].pattern).toBe('popup-listener');
  });

  test('empty memory patterns does not error', () => {
    _test._memoryPatternCache = [];
    const diff = `+const x = 1;\n`;
    const result = checkDiff(diff);
    expect(result.hasConflict).toBe(false);
  });
});

describe('formatComment', () => {
  test('formats critical and warning conflicts', () => {
    const conflicts = [
      { pattern: 'gpt-5-codex', description: 'Invalid slug', line: "+const m = 'gpt-5-codex'", lineNum: 5, critical: true },
      { pattern: 'popup-listener', description: 'Retired LaunchAgent', line: '+load popup-listener', lineNum: 10, critical: false },
    ];
    const comment = formatComment('RevOps-Global-GIT/cortextos', 99, conflicts);
    expect(comment).toContain('Memo-Conflict Check');
    expect(comment).toContain('Critical');
    expect(comment).toContain('gpt-5-codex');
    expect(comment).toContain('Warnings');
    expect(comment).toContain('popup-listener');
    expect(comment).toContain('memo-conflict-ok');
  });
});
