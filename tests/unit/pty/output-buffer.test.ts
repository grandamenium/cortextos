import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs.appendFileSync so tests don't actually write to disk. We still
// need the real existsSync etc. for other imports in the module graph.
const appendFileSyncMock = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
  };
});

const { OutputBuffer } = await import('../../../src/pty/output-buffer');

// Synthetic JWT used across tests. Has the canonical 3-segment shape and
// the `eyJ` header prefix so the redactor matches it. Length exceeds the
// {10,} per-segment minimum.
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXNlc3Npb24taWQifQ.abcdefghij_-abcdefghij';

beforeEach(() => {
  appendFileSyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OutputBuffer redaction', () => {
  it('single JWT in a single chunk: redacted in both disk log and in-memory buffer', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    buf.push(`session cookie: authjs.session-token=${FAKE_JWT}\n`);

    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const writtenData = String(appendFileSyncMock.mock.calls[0][1]);
    expect(writtenData).toContain('[REDACTED_JWT]');
    expect(writtenData).not.toContain(FAKE_JWT);

    // In-memory ring buffer should also see the redacted form.
    const recent = buf.getRecent();
    expect(recent).toContain('[REDACTED_JWT]');
    expect(recent).not.toContain(FAKE_JWT);
  });

  it('multiple JWTs in one chunk: all redacted', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const another =
      'eyJxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy.zzzzzzzzzzzzzzzz__';
    buf.push(`a=${FAKE_JWT} b=${another} c=${FAKE_JWT}`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    // Every JWT-shaped token replaced with the literal redaction marker.
    expect(written).not.toContain(FAKE_JWT);
    expect(written).not.toContain(another);
    const matches = (written.match(/\[REDACTED_JWT\]/g) || []).length;
    expect(matches).toBe(3);
  });

  it('non-JWT PTY data passes through unchanged (regression guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // TUI ANSI escapes, regular stdout, plausible-but-too-short alphanum.
    const tuiOutput =
      '\x1b[38;5;114m●\x1b[39m Running tests... version v1.2.3 hash=abc.def.ghi\n';
    buf.push(tuiOutput);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toBe(tuiOutput); // byte-for-byte identical
    expect(written).not.toContain('[REDACTED_JWT]');
  });

  it('bootstrap detection still works after redaction', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // Claude Code's permissions status bar line — contains "permissions"
    // which isBootstrapped() searches for. No JWT in this chunk — the
    // test guards that redaction does not accidentally break the ring
    // buffer's search path.
    buf.push('\x1b[2m ? \x1b[0mfor shortcuts                  permissions: bypass\n');
    expect(buf.isBootstrapped()).toBe(true);
  });

  it('chunk-boundary edge case is NOT redacted (documents the known limitation)', () => {
    // Split a JWT across two push() calls. Neither chunk matches the
    // regex on its own — the redactor is stateless and chunk-local. This
    // test INTENTIONALLY asserts the un-redacted behavior so that any
    // future refactor adding buffer-aware redaction has to be an
    // explicit decision (the test fails and forces a re-review).
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    const half1 = FAKE_JWT.slice(0, 40);
    const half2 = FAKE_JWT.slice(40);
    buf.push(`prefix ${half1}`);
    buf.push(`${half2} suffix`);

    const firstWrite = String(appendFileSyncMock.mock.calls[0][1]);
    const secondWrite = String(appendFileSyncMock.mock.calls[1][1]);
    // Each half survives because neither chunk is a complete JWT shape.
    expect(firstWrite).toContain(half1);
    expect(secondWrite).toContain(half2);
    // Neither chunk contains the redaction marker.
    expect(firstWrite).not.toContain('[REDACTED_JWT]');
    expect(secondWrite).not.toContain('[REDACTED_JWT]');
  });

  it('short alphanumeric that resembles a truncated JWT is NOT redacted (length guard)', () => {
    const buf = new OutputBuffer(1000, '/tmp/fake-stdout.log');
    // "eyJab.x.y" has the right header prefix and the right shape but
    // segments are all too short — the {10,} length qualifier must
    // prevent this from matching.
    const shortTokenLike = 'eyJab.x.y';
    buf.push(`debug_token=${shortTokenLike} ok=true\n`);

    const written = String(appendFileSyncMock.mock.calls[0][1]);
    expect(written).toContain(shortTokenLike);
    expect(written).not.toContain('[REDACTED_JWT]');
  });
});
