import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, utimesSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectContextCap, archiveCappedSession } from '../../../src/daemon/context-cap-detect';

// Fabricates a JSONL session file under convDir with given content and
// optional mtime. Returns the full path.
function writeSession(convDir: string, name: string, body: string, mtimeSec?: number): string {
  const p = join(convDir, name);
  writeFileSync(p, body, 'utf-8');
  if (mtimeSec !== undefined) {
    utimesSync(p, mtimeSec, mtimeSec);
  }
  return p;
}

describe('detectContextCap', () => {
  let convDir: string;

  beforeEach(() => {
    convDir = mkdtempSync(join(tmpdir(), 'context-cap-'));
  });

  afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  it('returns capped:false when convDir does not exist', () => {
    const missing = join(convDir, 'does-not-exist');
    expect(detectContextCap(missing)).toEqual({ capped: false });
  });

  it('returns capped:false when convDir is empty', () => {
    expect(detectContextCap(convDir)).toEqual({ capped: false });
  });

  it('returns capped:false when no .jsonl files exist (other files present)', () => {
    writeFileSync(join(convDir, 'README.md'), 'not a session', 'utf-8');
    writeFileSync(join(convDir, 'notes.txt'), 'nope', 'utf-8');
    expect(detectContextCap(convDir)).toEqual({ capped: false });
  });

  it('returns capped:false for a jsonl with no cap marker', () => {
    writeSession(convDir, 'a.jsonl', JSON.stringify({ type: 'user', text: 'hello' }) + '\n');
    expect(detectContextCap(convDir)).toEqual({ capped: false });
  });

  it('returns capped:true when the tail contains "Context limit reached"', () => {
    const path = writeSession(
      convDir,
      'stuck.jsonl',
      JSON.stringify({ type: 'assistant', text: 'Context limit reached · /compact or /clear to continue' }) + '\n',
    );
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(true);
    expect(r.sessionFile).toBe(path);
  });

  it('returns capped:true when the tail contains "prompt is too long"', () => {
    const path = writeSession(
      convDir,
      'toolong.jsonl',
      JSON.stringify({ type: 'error', message: 'prompt is too long' }) + '\n',
    );
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(true);
    expect(r.sessionFile).toBe(path);
  });

  it('is case-insensitive on the pattern match', () => {
    const path = writeSession(
      convDir,
      'shouty.jsonl',
      'some stuff\nCONTEXT LIMIT REACHED\n',
    );
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(true);
    expect(r.sessionFile).toBe(path);
  });

  it('picks the most recent jsonl and ignores older ones', () => {
    // Older, non-capped session
    writeSession(
      convDir,
      'old.jsonl',
      JSON.stringify({ type: 'user', text: 'nothing bad here' }) + '\n',
      1600000000, // 2020-09-13
    );
    // More recent, capped session
    const recent = writeSession(
      convDir,
      'recent.jsonl',
      JSON.stringify({ type: 'assistant', text: 'Context limit reached' }) + '\n',
      1700000000, // 2023-11-14
    );
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(true);
    expect(r.sessionFile).toBe(recent);
  });

  it('does NOT flag the old session when it has the marker but a newer clean one exists', () => {
    // Older, CAPPED session
    writeSession(
      convDir,
      'old-capped.jsonl',
      JSON.stringify({ type: 'assistant', text: 'Context limit reached earlier' }) + '\n',
      1600000000,
    );
    // More recent, CLEAN session
    writeSession(
      convDir,
      'recent-clean.jsonl',
      JSON.stringify({ type: 'user', text: 'all good now' }) + '\n',
      1700000000,
    );
    // Only the most recent matters — it is clean, so capped=false.
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(false);
  });

  it('scans tail of a large jsonl for the marker (marker present at the end)', () => {
    // Build a ~40KB jsonl with the marker only in the final line. Detection
    // reads just the tail 16KB, so the marker must be within that window.
    const filler = Array.from({ length: 400 }, (_, i) =>
      JSON.stringify({ type: 'user', text: 'x'.repeat(80), idx: i }),
    ).join('\n');
    const lastLine = JSON.stringify({ type: 'assistant', text: 'Context limit reached' });
    const path = writeSession(convDir, 'big.jsonl', filler + '\n' + lastLine + '\n');

    expect(statSync(path).size).toBeGreaterThan(30 * 1024);
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(true);
    expect(r.sessionFile).toBe(path);
  });

  it('does NOT match when the marker is only in the early part of a file bigger than the tail window', () => {
    // 80KB filler so the 16KB tail does not see the header; marker is
    // only at byte 0. The guard should NOT fire — we intentionally only
    // look at the tail to detect CURRENT stuck state, not historical.
    const header = JSON.stringify({ type: 'info', text: 'Context limit reached way back' });
    const filler = Array.from({ length: 800 }, () => JSON.stringify({ type: 'user', text: 'x'.repeat(90) })).join('\n');
    writeSession(convDir, 'hx.jsonl', header + '\n' + filler + '\n');
    const r = detectContextCap(convDir);
    expect(r.capped).toBe(false);
  });

  it('ignores zero-byte jsonl files (empty session placeholder)', () => {
    writeFileSync(join(convDir, 'empty.jsonl'), '', 'utf-8');
    expect(detectContextCap(convDir)).toEqual({ capped: false });
  });
});

describe('archiveCappedSession', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'context-cap-archive-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renames the session file aside with a .capped-<timestamp> suffix', () => {
    const orig = join(dir, 'session.jsonl');
    writeFileSync(orig, 'capped session', 'utf-8');

    const archived = archiveCappedSession(orig);
    expect(archived).toBeTruthy();
    expect(archived).toMatch(/\.capped-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    expect(existsSync(orig)).toBe(false);
    expect(existsSync(archived!)).toBe(true);

    // claude --continue would read *.jsonl; the archive has a different suffix.
    const remainingJsonls = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(remainingJsonls).toEqual([]);
  });

  it('returns null when the source file does not exist', () => {
    const missing = join(dir, 'gone.jsonl');
    expect(archiveCappedSession(missing)).toBeNull();
  });
});
