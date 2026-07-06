import { describe, it, expect } from 'vitest';
import { TelegramAPI } from '../../../src/telegram/api';

// markdownToHtml/splitHtml are private — cast the instance to reach them,
// matching the task's sanctioned pattern (no source-side test exports).
type Internals = {
  markdownToHtml(text: string, plainText?: boolean): string;
  splitHtml(text: string, maxLen: number): string[];
};

function internals(): Internals {
  return new TelegramAPI('111:AAA') as unknown as Internals;
}

/**
 * Assert a chunk is independently valid Telegram HTML:
 *  - never starts or ends mid-<tag>
 *  - never ends mid-&entity;
 *  - every opened tag is closed within the same chunk (properly nested)
 */
function assertChunkValid(chunk: string): void {
  // Ends mid-tag: a '<' with no closing '>' after it.
  expect(chunk).not.toMatch(/<[^>]*$/);
  // Starts mid-tag: a literal '>' before any '<'. Raw '>' in text is always
  // escaped to &gt; by markdownToHtml, so any bare '>' belongs to a tag.
  expect(chunk).not.toMatch(/^[^<]*>/);
  // Ends mid-entity: '&' not terminated by ';' before end of chunk.
  expect(chunk).not.toMatch(/&[a-zA-Z#0-9]{0,8}$/);

  // Balanced, properly nested tags.
  const stack: string[] = [];
  const tagRe = /<(\/?)(pre|code|b|i|a)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(chunk)) !== null) {
    if (m[1] === '/') {
      expect(stack.pop()).toBe(m[2]);
    } else {
      stack.push(m[2]);
    }
  }
  expect(stack).toEqual([]);
}

describe('markdownToHtml — code spans are protected from bold/italic/link passes', () => {
  it('fenced code containing * _ [x](http://y) gets no <b>/<i>/<a> injected', () => {
    const md = [
      'Header text',
      '```',
      'const a = *stars* and _unders_ and [x](http://y)',
      'more *code* here',
      '```',
      'after',
    ].join('\n');

    const html = internals().markdownToHtml(md);

    const match = html.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/);
    expect(match).not.toBeNull();
    const inner = (match as RegExpMatchArray)[1];
    expect(inner).not.toContain('<b>');
    expect(inner).not.toContain('<i>');
    expect(inner).not.toContain('<a ');
    // Original characters survive verbatim inside the code block.
    expect(inner).toContain('*stars*');
    expect(inner).toContain('_unders_');
    expect(inner).toContain('[x](http://y)');
  });

  it('inline code containing * is not bolded', () => {
    const html = internals().markdownToHtml('run `a *b* c` now');
    expect(html).toContain('<code>a *b* c</code>');
    expect(html).not.toContain('<b>');
  });

  it('regression: bold/italic/links OUTSIDE code still convert', () => {
    const html = internals().markdownToHtml(
      '*bold* _ital_ [docs](https://example.com) and `code`',
    );
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<i>ital</i>');
    expect(html).toContain('<a href="https://example.com">docs</a>');
    expect(html).toContain('<code>code</code>');
  });

  it('regression: plainText short-circuit unchanged', () => {
    const html = internals().markdownToHtml('*raw* & <x> `y`', true);
    expect(html).toBe('*raw* & <x> `y`');
  });
});

describe('splitHtml — every chunk is independently valid HTML', () => {
  it('a >4096-char <pre><code> block spanning the boundary yields balanced chunks', () => {
    const api = internals();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`line ${String(i).padStart(4, '0')} — some code with <angle> & stuff`);
    }
    const md = `intro paragraph\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\nfooter`;
    const html = api.markdownToHtml(md);
    expect(html.length).toBeGreaterThan(4096 * 2);

    const chunks = api.splitHtml(html, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      assertChunkValid(chunk);
    }
    // No code content lost: stripping tags from the joined chunks matches
    // stripping tags from the original html.
    const strip = (s: string): string => s.replace(/<[^>]+>/g, '');
    expect(strip(chunks.join(''))).toBe(strip(html));
  });

  it('hard split of a single long line never cuts a <tag> in half', () => {
    const api = internals();
    // One long line (no newlines) full of tags — forces the hard-split path.
    const piece = '<b>bold</b> plus <a href="https://example.com/x">link</a> ';
    const text = piece.repeat(20); // ~1100 chars, single line
    const chunks = api.splitHtml(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/<[^>]*$/);
      expect(chunk).not.toMatch(/^[^<]*>/);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('hard split never cuts an &entity; in half', () => {
    const api = internals();
    const text = 'aa &amp; bb &lt;cc&gt; '.repeat(50); // single line, entity-dense
    const chunks = api.splitHtml(text, 64);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/&[a-zA-Z#0-9]{0,8}$/);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('regression: prefers paragraph then newline boundaries for non-code text', () => {
    const api = internals();
    const para = 'x'.repeat(2000) + '\n\n';
    const text = para + para + 'z'.repeat(500);
    const chunks = api.splitHtml(text, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith('\n\n')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
