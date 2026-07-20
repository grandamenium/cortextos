import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { extractMessageText, findViolations } from '../../../src/hooks/hook-qualifier-scan';

describe('extractMessageText', () => {
  it('extracts a direct quoted string argument from send-telegram', () => {
    const cmd = 'cortextos bus send-telegram 8545268492 "Hello there"';
    expect(extractMessageText(cmd)).toBe('Hello there');
  });

  it('extracts the last quoted argument from send-message (skips agent name/priority/msg-id)', () => {
    const cmd = "cortextos bus send-message cleo normal 'Confirmed, sounds good' msg123";
    expect(extractMessageText(cmd)).toBe('Confirmed, sounds good');
  });

  it('returns null for an unrelated Bash command even if it contains banned words', () => {
    const cmd = 'grep -n "fair" GUARDRAILS.md';
    expect(extractMessageText(cmd)).toBeNull();
  });

  it('returns null for a Bash command that writes to GUARDRAILS.md via heredoc (not a send call)', () => {
    const cmd = "cat >> GUARDRAILS.md << 'EOF'\nAbout to say fair/honest, STOP\nEOF";
    expect(extractMessageText(cmd)).toBeNull();
  });

  describe('$(cat <path>) substitution', () => {
    let tmp: string;
    let file: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'qualifier-scan-'));
      file = join(tmp, 'draft.txt');
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('reads the referenced file content, not the literal command string', () => {
      writeFileSync(file, 'That is the honest limit of what infrastructure can catch here.', 'utf-8');
      const cmd = `cortextos bus send-telegram 8545268492 "$(cat ${file})"`;
      expect(extractMessageText(cmd)).toContain('honest limit');
    });

    it('returns null if the referenced file does not exist', () => {
      const cmd = `cortextos bus send-telegram 8545268492 "$(cat ${join(tmp, 'missing.txt')})"`;
      expect(extractMessageText(cmd)).toBeNull();
    });
  });
});

describe('findViolations', () => {
  it('flags "to be fair"', () => {
    expect(findViolations('To be fair, that is a real issue')).toContain('to be fair');
  });

  it('flags bare "honestly"', () => {
    expect(findViolations('Honestly this is fine')).toContain('honestly');
  });

  it('flags bare "genuinely"', () => {
    expect(findViolations('Genuinely a good point')).toContain('genuinely');
  });

  it('flags "honest limit"', () => {
    expect(findViolations('That is the honest limit of what infra can catch')).toContain(
      'honest truth/limit/answer/read',
    );
  });

  it('flags "that\'s a fair" characterization', () => {
    expect(findViolations("That's a fair read of the situation")).toContain("that's a fair ...");
  });

  it('does NOT flag "real" used as an ordinary factual adjective', () => {
    expect(findViolations('This is a real bug, found in the real inbox data')).toEqual([]);
  });

  it('does NOT flag "fair" used as an ordinary adjective (not a self-narrating phrase)', () => {
    expect(findViolations('The vendor charged a fair price for the repair')).toEqual([]);
  });

  it('returns an empty array for a clean message', () => {
    expect(findViolations('Confirmed, fleet is healthy, no stale tasks.')).toEqual([]);
  });
});
