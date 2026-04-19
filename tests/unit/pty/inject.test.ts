import { describe, it, expect, vi } from 'vitest';
import { MessageDedup, KEYS, isValidInboxMsgId, injectMessage } from '../../../src/pty/inject';

describe('MessageDedup', () => {
  it('detects duplicate content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('hello world')).toBe(false);
    expect(dedup.isDuplicate('hello world')).toBe(true);
  });

  it('allows different content', () => {
    const dedup = new MessageDedup();
    expect(dedup.isDuplicate('message 1')).toBe(false);
    expect(dedup.isDuplicate('message 2')).toBe(false);
  });

  it('evicts old entries', () => {
    const dedup = new MessageDedup(3);
    dedup.isDuplicate('msg1');
    dedup.isDuplicate('msg2');
    dedup.isDuplicate('msg3');
    dedup.isDuplicate('msg4'); // evicts msg1
    expect(dedup.isDuplicate('msg1')).toBe(false); // no longer in cache
    expect(dedup.isDuplicate('msg4')).toBe(true); // still in cache
  });
});

describe('KEYS', () => {
  it('has correct escape sequences', () => {
    expect(KEYS.ENTER).toBe('\r');
    expect(KEYS.CTRL_C).toBe('\x03');
    expect(KEYS.DOWN).toBe('\x1b[B');
    expect(KEYS.UP).toBe('\x1b[A');
    expect(KEYS.SPACE).toBe(' ');
  });
});

// BUG-079 tests
describe('isValidInboxMsgId', () => {
  it('accepts a valid ID: epochMs-agentName-rand5', () => {
    expect(isValidInboxMsgId('1713400000000-sage-ab12c')).toBe(true);
  });

  it('accepts IDs with hyphenated agent names', () => {
    expect(isValidInboxMsgId('1713400000000-my-agent-xy9z1')).toBe(true);
  });

  it('accepts IDs with underscored agent names', () => {
    expect(isValidInboxMsgId('1713400000000-my_agent-ab12c')).toBe(true);
  });

  it('rejects ID with missing rand suffix', () => {
    expect(isValidInboxMsgId('1713400000000-sage')).toBe(false);
  });

  it('rejects ID with non-numeric epoch', () => {
    expect(isValidInboxMsgId('abc-sage-ab12c')).toBe(false);
  });

  it('rejects ID with path traversal attempt', () => {
    expect(isValidInboxMsgId('../../../etc/passwd')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidInboxMsgId('')).toBe(false);
  });

  it('rejects ID with uppercase characters in rand', () => {
    // rand5 must be lowercase alphanumeric — uppercase is rejected
    expect(isValidInboxMsgId('1713400000000-sage-AB12C')).toBe(false);
  });
});

describe('injectMessage (BUG-079: control char stripping)', () => {
  it('strips null bytes from message content before PTY injection', () => {
    const writes: string[] = [];
    injectMessage((d) => writes.push(d), 'hello\x00world', 0);
    const joined = writes.join('');
    expect(joined).toContain('helloworld');
    expect(joined).not.toContain('\x00');
  });

  it('strips ANSI escape sequences from message content', () => {
    const writes: string[] = [];
    injectMessage((d) => writes.push(d), 'clean\x1b[31mred\x1b[0m', 0);
    const joined = writes.join('');
    expect(joined).toContain('cleanred');
    // The bracketed paste wrappers (\x1b[200~ / \x1b[201~) are expected.
    // The user-injected ANSI color codes (\x1b[31m, \x1b[0m) must be gone.
    // Extract just the content between the paste markers.
    const contentMatch = joined.match(/\x1b\[200~([\s\S]*)\x1b\[201~/);
    expect(contentMatch).toBeTruthy();
    expect(contentMatch![1]).toBe('cleanred');
  });

  it('preserves newlines and tabs in message content', () => {
    const writes: string[] = [];
    injectMessage((d) => writes.push(d), 'line1\nline2\ttabbed', 0);
    const joined = writes.join('');
    expect(joined).toContain('line1\nline2\ttabbed');
  });

  it('strips carriage returns to prevent early PTY submission', () => {
    const writes: string[] = [];
    injectMessage((d) => writes.push(d), 'part1\rpart2', 0);
    const joined = writes.join('');
    // \r should be stripped — it would prematurely submit inside bracketed paste
    expect(joined).not.toContain('\r');
    expect(joined).toContain('part1part2');
  });

  it('wraps clean content in bracketed paste mode sequences', () => {
    const writes: string[] = [];
    injectMessage((d) => writes.push(d), 'hello', 0);
    const joined = writes.join('');
    expect(joined).toContain('\x1b[200~');
    expect(joined).toContain('\x1b[201~');
    expect(joined).toContain('hello');
  });
});
