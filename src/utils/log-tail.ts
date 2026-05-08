/**
 * Bounded log-tail reader.
 *
 * Reads at most `maxBytes` from the END of `logPath` using
 * `openSync`/`readSync` with explicit position — does NOT load the
 * whole file into memory before slicing. Important for hook code
 * that runs unsupervised against potentially-large stdout/stderr
 * logs (a 500MB log + naive `readFileSync(path).slice(-N)` puts
 * the whole file into RAM).
 *
 * Returns `''` on missing file, read error, or zero-byte file.
 * Never throws — callers are SessionEnd / heartbeat / probe
 * detectors and a crash silently loses the alert window.
 */

import { statSync, openSync, readSync, closeSync } from 'fs';

export function readLogTail(logPath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(logPath).size;
    if (size === 0) return '';
    const readBytes = Math.min(size, maxBytes);
    const start = Math.max(0, size - readBytes);
    fd = openSync(logPath, 'r');
    const buf = Buffer.allocUnsafe(readBytes);
    const got = readSync(fd, buf, 0, readBytes, start);
    // `Buffer.allocUnsafe` returns un-zeroed memory; `subarray(0,
    // got)` discards any trailing un-initialised bytes from a
    // short read, so toString() never observes prior heap data.
    return buf.subarray(0, got).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
