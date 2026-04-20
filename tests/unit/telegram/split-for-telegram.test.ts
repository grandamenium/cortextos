import { describe, it, expect } from 'vitest';
import { splitForTelegram, TELEGRAM_MAX_LEN } from '../../../src/telegram/api';

describe('splitForTelegram', () => {
  it('returns single chunk for text shorter than limit', () => {
    expect(splitForTelegram('hello world')).toEqual(['hello world']);
  });

  it('returns single chunk exactly at limit', () => {
    const exact = 'x'.repeat(TELEGRAM_MAX_LEN);
    expect(splitForTelegram(exact)).toEqual([exact]);
  });

  it('hard-cut fallback for pathological boundary-free input (backwards compat)', () => {
    // The old chunker sliced every maxLen chars. The new one must still
    // produce a valid multi-chunk split for an input with zero natural
    // boundaries — anything else would change call counts for existing
    // tests in send-message.test.ts and leak the refactor.
    const text = 'x'.repeat(9000);
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= TELEGRAM_MAX_LEN)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers paragraph boundary when present in the back half of the window', () => {
    // Two "paragraphs" forced just past the midpoint of the maxLen window.
    const firstPara = 'a'.repeat(3000);
    const secondPara = 'b'.repeat(3000);
    const text = firstPara + '\n\n' + secondPara;
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBe(2);
    // First chunk ends with the double-newline so the second chunk begins
    // clean. The second chunk contains the 'b' paragraph only.
    expect(chunks[0].endsWith('\n\n')).toBe(true);
    expect(chunks[1]).toBe(secondPara);
    expect(chunks.join('')).toBe(text);
  });

  it('falls back to single-newline boundary when no paragraph break exists', () => {
    const firstLine = 'a'.repeat(3000);
    const secondLine = 'b'.repeat(3000);
    const text = firstLine + '\n' + secondLine;
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith('\n')).toBe(true);
    expect(chunks[1]).toBe(secondLine);
  });

  it('falls back to sentence boundary when no newlines exist', () => {
    // First "sentence" filler + a terminator, then second "sentence" in
    // the window. Midpoint is 2048; place the ". " just past 2500.
    const first = 'a'.repeat(2500) + '. ';
    const second = 'b'.repeat(3000);
    const text = first + second;
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBe(2);
    // First chunk includes through ". " and nothing of the 'b' run.
    expect(chunks[0].endsWith('. ')).toBe(true);
    expect(chunks[0]).not.toContain('b');
    expect(chunks[1]).toBe(second);
  });

  it('falls back to word boundary when no sentence terminators exist', () => {
    // 3000 a's, a single space just past the midpoint, then 3000 b's.
    // No sentence terminator, but the space is a valid word boundary.
    const text = 'a'.repeat(3000) + ' ' + 'b'.repeat(3000);
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBe(2);
    // Space is consumed by chunk 1; chunk 2 starts cleanly with 'b'.
    expect(chunks[0].endsWith(' ')).toBe(true);
    expect(chunks[1].startsWith('b')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('never splits inside an unbalanced markdown entity', () => {
    // 3000 a's, open a bold span *bbb...bbb* spanning across the natural
    // word-boundary split point. The chunker must back off to an earlier
    // balanced point (or fall through to the hard cut). Either way, every
    // resulting chunk must itself have balanced entities.
    const text = 'a'.repeat(2500) + ' *' + 'b'.repeat(3500) + '*';
    const chunks = splitForTelegram(text);
    for (const c of chunks) {
      const stars = (c.match(/\*/g) ?? []).length;
      expect(stars % 2).toBe(0);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('never splits inside an unbalanced code span', () => {
    const text = 'aa ' + 'a'.repeat(2500) + '`' + 'b'.repeat(3500) + '`';
    const chunks = splitForTelegram(text);
    for (const c of chunks) {
      const ticks = (c.match(/`/g) ?? []).length;
      expect(ticks % 2).toBe(0);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('never splits inside an unclosed link [text](url)', () => {
    // [ opened before the candidate split, ] not yet closed. The balanced
    // check treats the [ as a dangling entity and rejects splits that fall
    // inside it.
    const text = 'a'.repeat(2500) + ' [' + 'b'.repeat(3500) + '](https://x)';
    const chunks = splitForTelegram(text);
    for (const c of chunks) {
      // The [ count minus the ] count (floored at 0) must be 0 at chunk end.
      let openBrackets = 0;
      for (const ch of c) {
        if (ch === '[') openBrackets++;
        else if (ch === ']' && openBrackets > 0) openBrackets--;
      }
      expect(openBrackets).toBe(0);
    }
  });

  it('every chunk respects maxLen bound', () => {
    const text = ('Lorem ipsum dolor sit amet. ').repeat(1000);
    const chunks = splitForTelegram(text);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('preserves full content across the union of chunks (no loss, no dup)', () => {
    const text = [
      'Paragraph one with several sentences. Another sentence here. And a third.',
      '',
      'Paragraph two: ' + 'lorem '.repeat(800),
      '',
      'Paragraph three: ' + 'ipsum '.repeat(800),
    ].join('\n');
    const chunks = splitForTelegram(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('accepts a custom maxLen', () => {
    // Useful for smaller-window testing. With maxLen=40 and a paragraph
    // break at the midpoint, we expect 2 chunks.
    const text = 'a'.repeat(25) + '\n\n' + 'b'.repeat(25);
    const chunks = splitForTelegram(text, 40);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });
});
