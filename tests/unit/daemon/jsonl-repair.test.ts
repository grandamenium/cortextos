import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  repairTrailingPartialJsonl,
  repairJsonlFile,
  repairConversationDir,
} from '../../../src/daemon/jsonl-repair.js';

// SYS-DAEMON-RESILIENCE-01 Part A — Fix 2 mitigation (ii): pre---continue JSONL repair.

const line = (seq: number) => JSON.stringify({ type: 'message', seq });

describe('repairTrailingPartialJsonl (pure)', () => {
  it('no-op on empty content', () => {
    expect(repairTrailingPartialJsonl('')).toEqual({ repaired: '', dropped: false });
  });

  it('no-op when newline-terminated (all complete records)', () => {
    const c = `${line(1)}\n${line(2)}\n`;
    expect(repairTrailingPartialJsonl(c)).toEqual({ repaired: c, dropped: false });
  });

  it('leaves a complete-but-unflushed trailing record (parses, no trailing newline)', () => {
    const c = `${line(1)}\n${line(2)}`; // last line valid JSON, no newline
    expect(repairTrailingPartialJsonl(c)).toEqual({ repaired: c, dropped: false });
  });

  it('drops a truncated/unparseable trailing line (genuine mid-write SIGTERM)', () => {
    const c = `${line(1)}\n${line(2)}\n{"type":"message","seq":`; // truncated last
    const { repaired, dropped } = repairTrailingPartialJsonl(c);
    expect(dropped).toBe(true);
    expect(repaired).toBe(`${line(1)}\n${line(2)}\n`);
    // every surviving line parses
    for (const l of repaired.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe('repairJsonlFile / repairConversationDir (fs)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cortextos-jsonl-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('repairJsonlFile rewrites a truncated file and reports change; clean file untouched', () => {
    const bad = join(dir, 'a.jsonl');
    writeFileSync(bad, `${line(1)}\n{"truncated":`);
    expect(repairJsonlFile(bad)).toBe(true);
    expect(readFileSync(bad, 'utf-8')).toBe(`${line(1)}\n`);

    const good = join(dir, 'b.jsonl');
    const gc = `${line(1)}\n${line(2)}\n`;
    writeFileSync(good, gc);
    expect(repairJsonlFile(good)).toBe(false);
    expect(readFileSync(good, 'utf-8')).toBe(gc);
  });

  it('repairConversationDir repairs only truncated .jsonl files and counts them', () => {
    const conv = join(dir, 'conv');
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, 'x.jsonl'), `${line(1)}\n{"bad":`);
    writeFileSync(join(conv, 'y.jsonl'), `${line(1)}\n`);
    writeFileSync(join(conv, 'notes.txt'), 'ignored {"bad":');
    expect(repairConversationDir(conv)).toBe(1);
  });

  it('repairConversationDir is a no-op on a missing dir', () => {
    expect(repairConversationDir(join(dir, 'nope'))).toBe(0);
  });
});
