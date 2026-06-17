import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { distillTranscript } from '../../../src/utils/transcript-distill.js';

// Synthetic .jsonl fixture exercising every distiller pathway:
//   - a noise record dropped (file-history-snapshot)
//   - a system meta record dropped
//   - an API-error record dropped (short error-shaped text)
//   - a boilerplate line collapsed (reminder)
//   - a kept message carrying a PR link + a decision line + a tool_use
//   - a bus thread header extracted

let tmpRoot: string;
let fixture: string;

function writeJsonl(records: unknown[]): string {
  const p = join(tmpRoot, 'transcript.jsonl');
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'distill-'));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('distillTranscript', () => {
  it('drops noise, drops API errors, collapses boilerplate, and extracts signal', () => {
    fixture = writeJsonl([
      // noise: dropped entirely
      { type: 'file-history-snapshot', snapshot: { huge: 'x'.repeat(1000) } },
      // system meta: dropped
      { type: 'system', isMeta: true, message: { content: 'meta stuff' } },
      // API error (explicit flag): dropped
      { type: 'assistant', isApiErrorMessage: true, message: { content: 'API Error: overloaded' } },
      // API error (short error-shaped text): dropped
      { type: 'assistant', message: { content: 'rate limit hit' } },
      // boilerplate reminder: collapsed (not kept verbatim)
      { type: 'user', message: { content: 'This is a friendly reminder to check inbox.' } },
      // bus thread header + decision + PR link + tool_use: kept
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '=== AGENT MESSAGE from skipper ===\nWe decided to ship the rotation fix today.\nOpened https://github.com/grandamenium/cortextos/pull/42 for review.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_result' },
          ],
        },
      },
    ]);

    const r = distillTranscript(fixture);

    expect(r.recordsTotal).toBe(6);
    // file-history-snapshot + system meta = 2 noise drops
    expect(r.droppedNoise).toBe(2);
    // explicit flag + short error text = 2 api-error drops
    expect(r.apiErrors).toBe(2);
    // one reminder collapsed
    expect(r.boilerplate).toEqual({ reminder: 1 });
    // only the rich assistant message survives
    expect(r.kept).toBe(1);

    // signal extraction
    expect(r.signal.prs).toEqual(['https://github.com/grandamenium/cortextos/pull/42']);
    expect(r.signal.busThreads).toHaveLength(1);
    expect(r.signal.busThreads[0].sender).toBe('skipper');
    expect(r.signal.decisions.some((d) => /decided to ship/.test(d))).toBe(true);
    expect(r.signal.tools).toEqual({ Bash: 1 });

    // clean text keeps the signal but the tool_use is collapsed to a placeholder
    expect(r.cleanText).toContain('[tool_use:Bash]');
    expect(r.cleanText).toContain('[tool_result]');
    expect(r.cleanText).not.toContain('friendly reminder');

    expect(r.rawBytes).toBeGreaterThan(0);
  });

  it('skips unparseable lines without counting them', () => {
    const p = join(tmpRoot, 'transcript.jsonl');
    writeFileSync(p, 'not json\n{"type":"user","message":{"content":"hello"}}\n', 'utf-8');
    const r = distillTranscript(p);
    expect(r.recordsTotal).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.cleanText).toBe('hello');
  });
});
