import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDedup, KEYS, injectMessage } from '../../../src/pty/inject';

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

describe('injectMessage — wakeFirst ESC preamble', () => {
  // Verifies the idle-aware ESC preamble: when wakeFirst=true, a single ESC
  // byte is written first to re-engage the Claude Code readline render loop,
  // followed by the bracketed paste 80ms later, then Enter at enterDelay.

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends ESC as the first write when wakeFirst is true', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hello', 300, { wakeFirst: true });

    // ESC must be the very first write — before paste markers
    expect(writes.length).toBe(1);
    expect(writes[0]).toBe(KEYS.ESCAPE);
  });

  it('sends PASTE_START + content + PASTE_END after 80ms when wakeFirst is true', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hello', 300, { wakeFirst: true });
    expect(writes.length).toBe(1); // only ESC so far

    vi.advanceTimersByTime(80);

    // After 80ms: paste block should have been written (single write for small content)
    expect(writes.length).toBe(2);
    expect(writes[1]).toBe('\x1b[200~hello\x1b[201~');
  });

  it('sends Enter at enterDelay after the paste when wakeFirst is true', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hello', 300, { wakeFirst: true });
    vi.advanceTimersByTime(80);   // triggers paste
    vi.advanceTimersByTime(300);  // triggers Enter (300ms after paste)

    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
    // Total: ESC + paste-block + Enter
    expect(writes.length).toBe(3);
  });

  it('does NOT send ESC when wakeFirst is false (default)', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hello', 300);

    // Synchronous path: paste written immediately, no ESC
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).not.toBe(KEYS.ESCAPE);
    expect(writes[0]).toContain('\x1b[200~'); // starts with PASTE_START
  });

  it('does NOT send ESC when wakeFirst is explicitly false', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hello', 300, { wakeFirst: false });

    expect(writes[0]).not.toBe(KEYS.ESCAPE);
    expect(writes[0]).toContain('\x1b[200~');
  });
});

describe('injectMessage — deferred Enter crash safety', () => {
  // Regression guard for the 2026-04-22 storm. worker-process.ts:93 passed
  // an unsafe `this.pty!.write` callback; when PTY was torn down during the
  // 300ms enterDelay window the setTimeout fired null.write → uncaught
  // TypeError → daemon crash. The fix wraps the deferred write in try/catch.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('swallows throw from the deferred Enter callback without crashing', () => {
    const writes: string[] = [];
    // Caller's write is "safe" during the synchronous paste but starts
    // throwing by the time the deferred Enter fires — simulates PTY teardown.
    let ptyAlive = true;
    const write = (data: string) => {
      if (!ptyAlive) throw new TypeError("Cannot read properties of null (reading 'write')");
      writes.push(data);
    };

    // Synchronous calls (paste markers + content) should succeed.
    expect(() => injectMessage(write, 'hello', 300)).not.toThrow();
    expect(writes.length).toBeGreaterThan(0);

    // PTY dies before the 300ms Enter timeout fires.
    ptyAlive = false;

    // Advancing the clock invokes the deferred callback. Must NOT propagate.
    expect(() => vi.advanceTimersByTime(300)).not.toThrow();

    // The warn path in inject.ts confirms the catch branch ran.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/deferred Enter failed/);
  });

  it('sends Enter normally when the PTY stays alive', () => {
    const writes: string[] = [];
    const write = (data: string) => { writes.push(data); };

    injectMessage(write, 'hi', 300);
    const writesBeforeTimer = writes.length;
    vi.advanceTimersByTime(300);

    // Exactly one new write — the ENTER keystroke — and no warn.
    expect(writes.length).toBe(writesBeforeTimer + 1);
    expect(writes[writes.length - 1]).toBe(KEYS.ENTER);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
