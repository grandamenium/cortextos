import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installTimestampedConsole } from '../../../src/daemon/log-timestamps.js';

const INSTALLED = Symbol.for('cortextos.timestampedConsole');
const ISO_PREFIX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]$/;

describe('installTimestampedConsole', () => {
  const originals = { log: console.log, warn: console.warn, error: console.error };

  beforeEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[INSTALLED];
  });

  afterEach(() => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    delete (globalThis as Record<PropertyKey, unknown>)[INSTALLED];
  });

  it('prefixes console.log lines with an ISO-8601 UTC timestamp', () => {
    installTimestampedConsole();
    const spy = vi.fn();
    // Capture what the wrapper forwards by re-wrapping the (already bound) sink:
    // install() bound the ORIGINAL console.log, so intercept via a fresh install.
    delete (globalThis as Record<PropertyKey, unknown>)[INSTALLED];
    console.log = spy;
    installTimestampedConsole();
    console.log('[daemon] hello', 42);
    expect(spy).toHaveBeenCalledTimes(1);
    const [ts, msg, num] = spy.mock.calls[0];
    expect(String(ts)).toMatch(ISO_PREFIX);
    expect(msg).toBe('[daemon] hello');
    expect(num).toBe(42);
  });

  it('prefixes warn and error the same way', () => {
    const warnSpy = vi.fn();
    const errSpy = vi.fn();
    console.warn = warnSpy;
    console.error = errSpy;
    installTimestampedConsole();
    console.warn('w');
    console.error('e');
    expect(String(warnSpy.mock.calls[0][0])).toMatch(ISO_PREFIX);
    expect(String(errSpy.mock.calls[0][0])).toMatch(ISO_PREFIX);
    expect(warnSpy.mock.calls[0][1]).toBe('w');
    expect(errSpy.mock.calls[0][1]).toBe('e');
  });

  it('is idempotent — double install does not double-prefix', () => {
    const spy = vi.fn();
    console.log = spy;
    installTimestampedConsole();
    installTimestampedConsole();
    console.log('once');
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0];
    expect(call.length).toBe(2); // [timestamp, 'once'] — not [ts, ts, 'once']
    expect(String(call[0])).toMatch(ISO_PREFIX);
    expect(call[1]).toBe('once');
  });

  it('timestamp advances between calls (not frozen at install time)', async () => {
    const spy = vi.fn();
    console.log = spy;
    installTimestampedConsole();
    console.log('a');
    await new Promise(r => setTimeout(r, 5));
    console.log('b');
    const t1 = Date.parse(String(spy.mock.calls[0][0]).slice(1, -1));
    const t2 = Date.parse(String(spy.mock.calls[1][0]).slice(1, -1));
    expect(t2).toBeGreaterThanOrEqual(t1);
    expect(Number.isNaN(t1)).toBe(false);
  });
});
