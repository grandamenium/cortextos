import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { extractMessageCandidates, findViolations } from '../../../src/hooks/hook-qualifier-scan';

/** Convenience: does this command yield any violation across all candidates? */
function scan(command: string): string[] {
  return [...new Set(extractMessageCandidates(command).flatMap(findViolations))];
}

describe('extractMessageCandidates', () => {
  it('covers a direct quoted string argument from send-telegram', () => {
    const cmd = 'cortextos bus send-telegram 8545268492 "To be fair, hello there"';
    expect(scan(cmd)).toContain('to be fair');
  });

  it('covers the message argument of send-message', () => {
    const cmd = "cortextos bus send-message cleo normal 'Genuinely a good point' msg123";
    expect(scan(cmd)).toContain('genuinely');
  });

  it('returns no candidates for an unrelated Bash command even if it contains banned words', () => {
    const cmd = 'grep -n "to be fair" GUARDRAILS.md';
    expect(extractMessageCandidates(cmd)).toEqual([]);
    expect(scan(cmd)).toEqual([]);
  });

  it('returns no candidates for a Bash command that writes to GUARDRAILS.md via heredoc (not a send call)', () => {
    const cmd = "cat >> GUARDRAILS.md << 'EOF'\nAbout to say to be fair / honestly, STOP\nEOF";
    expect(extractMessageCandidates(cmd)).toEqual([]);
    expect(scan(cmd)).toEqual([]);
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

    it('reads a pre-existing referenced draft file', () => {
      writeFileSync(file, 'That is the honest limit of what infrastructure can catch here.', 'utf-8');
      const cmd = `cortextos bus send-telegram 8545268492 "$(cat ${file})"`;
      expect(scan(cmd)).toContain('honest truth/limit/answer/read');
    });

    // REGRESSION (found live 2026-07-20, hours after this hook shipped): the
    // write-then-send-in-one-Bash-call pattern meant the draft file did not
    // exist yet when PreToolUse fired, extraction returned null, and the
    // message went out entirely unscanned. This is the dominant pattern for
    // long/careful messages, so the hook was silently ineffective for exactly
    // the highest-risk cases. Scanning the raw command string closes it.
    it('still catches a violation when the draft is written by a heredoc in the SAME call (file does not exist yet)', () => {
      const missing = join(tmp, 'not-written-yet.txt');
      const cmd =
        `cat > ${missing} << 'MSGEOF'\n` +
        `Honestly, this is the part that would have slipped through.\n` +
        `MSGEOF\n` +
        `cortextos bus send-telegram 8545268492 "$(cat ${missing})"`;
      expect(scan(cmd)).toContain('honestly');
    });

    it('does not throw when the referenced file does not exist and the command is otherwise clean', () => {
      const cmd = `cortextos bus send-telegram 8545268492 "$(cat ${join(tmp, 'missing.txt')})"`;
      expect(scan(cmd)).toEqual([]);
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
