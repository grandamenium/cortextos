import { describe, it, expect } from 'vitest';
import { classifyOutput, currentScreen, normalizeForDiff, confirmTrapped } from '../../../src/daemon/modal-watchdog';

describe('modal-watchdog classifyOutput', () => {
  it('detects the feedback survey (routine, not human-required)', () => {
    const c = classifyOutput('...\nHow is Claude doing this session?\n1: Bad  2: Fine  3: Good  0: Dismiss');
    expect(c.trapped).toBe(true);
    expect(c.known?.name).toBe('feedback-survey');
    expect(c.known?.humanRequired).toBe(false);
  });

  it('detects the trust-folder prompt (routine)', () => {
    const c = classifyOutput('Do you trust the files in this folder?\n  Yes, proceed');
    expect(c.known?.name).toBe('trust-folder');
    expect(c.known?.humanRequired).toBe(false);
  });

  it('detects the changelog', () => {
    expect(classifyOutput("What's new in Claude Code\n- stuff").known?.name).toBe('whats-new');
  });

  it('auth-expiry and usage-cap are HUMAN-REQUIRED (alert, can\'t be keyed away)', () => {
    expect(classifyOutput('Authentication expired. Please run /login to continue.').known?.humanRequired)
      .toBe(true);
  });

  it('★ LIVE-FIRE: detects the REAL cap-modal text captured off trapped agents (weekly + session + curly apostrophe)', () => {
    // The actual on-screen text — "hit your <weekly|session> limit · resets <time>". The
    // old anchor ("reached your weekly/usage limit") matched NONE of these (silent FN).
    for (const s of [
      'You’ve HIT your SESSION limit · resets 12:20am',   // curly U+2019 apostrophe
      "You've hit your WEEKLY limit · resets 1pm",
      'You’ve hit your session limit · resets 6pm',
    ]) {
      const c = classifyOutput(s);
      expect(c.known?.name).toBe('usage-cap');
      expect(c.known?.humanRequired).toBe(true);
    }
    // Chrome co-anchor ('resets') keeps a prose mention from matching:
    expect(classifyOutput("we hit our weekly limit earlier but have headroom now").trapped).toBe(false);
  });

  it('the module exposes NO keypress payload (detection-only invariant)', () => {
    const c = classifyOutput('How is Claude doing this session?\n0: Dismiss');
    expect(c.known).toBeDefined();
    expect((c.known as Record<string, unknown>).action).toBeUndefined();
    expect((c.known as Record<string, unknown>).key).toBeUndefined();
  });

  it('detects a genuinely BLOCKING generic prompt (unknown modal)', () => {
    const c = classifyOutput('Some output\nPress any key to continue');
    expect(c.trapped).toBe(true);
    expect(c.genericPrompt).toBe(true);
    expect(c.known).toBeUndefined();
  });

  it('★ does NOT trap on the benign "paste again to expand" artifact (the 79-flood trigger)', () => {
    // This collapsed-bracketed-paste hint is rendered on a perfectly HEALTHY prompt; it is
    // NOT a blocking modal and was removed from the signatures. classifyOutput must read it
    // as clean so a frozen idle screen can never be classified trapped on its account.
    expect(classifyOutput('[Pasted text #1 +500 lines] paste again to expand').trapped).toBe(false);
    expect(classifyOutput('> tell me about the box\n[Pasted text #2 +1200 lines] paste again to expand')
      .trapped).toBe(false);
  });

  it('does NOT trap on ordinary agent output', () => {
    expect(classifyOutput('Running the test suite... 1944 passed. Pushing the branch now.').trapped).toBe(false);
  });

  it('★ does NOT false-match agent prose that merely MENTIONS a modal topic', () => {
    // The signatures are anchored to modal chrome, not bare keywords.
    expect(classifyOutput('I checked the weekly limit on the shared account; we have headroom.').trapped).toBe(false);
    expect(classifyOutput('The trust boundary between portia and dialsvc must hold.').trapped).toBe(false);
    expect(classifyOutput('We should survey the customer about how Claude is doing on their box.').trapped).toBe(false);
  });
});

describe('modal-watchdog currentScreen', () => {
  it('returns only what is after the last screen-clear (the live modal, not scrollback)', () => {
    const raw =
      'earlier conversation... How is Claude doing this session? (the agent wrote this in prose)\n' +
      '\x1b[2J\x1b[H' + // screen clear → only what follows is the live screen
      'Do you trust the files in this folder?\n  Yes';
    const screen = currentScreen(raw);
    expect(screen).toContain('Do you trust the files');
    expect(screen).not.toContain('How is Claude doing'); // scrollback dropped
  });

  it('★ a modal phrase sitting in SCROLLBACK does not classify as trapped', () => {
    // The agent printed survey-like text earlier, then cleared + is at a normal prompt.
    const raw =
      'I dismissed the "How is Claude doing this session?" survey earlier.\n'.repeat(40) +
      '\x1b[2J\x1b[H' +
      'Running tests... 1953 passed. All green.';
    expect(classifyOutput(currentScreen(raw)).trapped).toBe(false);
  });

  it('classifies a modal that IS the current live screen', () => {
    const raw = 'old output\n\x1b[2J\x1b[HHow is Claude doing this session?\n0: Dismiss';
    expect(classifyOutput(currentScreen(raw)).known?.name).toBe('feedback-survey');
  });
});

describe('modal-watchdog normalizeForDiff', () => {
  it('strips ANSI/cursor noise so a frozen screen reads identical across repaints', () => {
    const a = '\x1b[2J\x1b[H\x1b[32mHow is Claude doing\x1b[0m\x1b[5;1H';
    const b = '\x1b[2J\x1b[HHow is Claude doing\x1b[1;1H'; // same text, different cursor moves
    expect(normalizeForDiff(a)).toBe(normalizeForDiff(b));
  });

  it('a changing screen yields a different digest (not frozen)', () => {
    expect(normalizeForDiff('working: step 1 of 5')).not.toBe(normalizeForDiff('working: step 2 of 5'));
  });
});

describe('modal-watchdog confirmTrapped (corroboration gate)', () => {
  const knownModal = classifyOutput('How is Claude doing this session?\n0: Dismiss'); // trapped + known
  const genericPrompt = classifyOutput('Some output\nPress any key to continue');     // trapped + generic
  const clean = classifyOutput('Running tests... 1953 passed. All green.');            // not trapped

  it('★ EXACT FAILING CASE: a healthy, heartbeating, cron-firing agent showing "paste again to expand" → NOT trapped, ZERO alert', () => {
    // The real PTY screen of the agent that caused the 79-flood: a normal idle prompt with
    // the benign collapsed-paste hint.
    const screen = currentScreen(
      'old output\n\x1b[2J\x1b[H' +
      '╭─────────────────────────────────────────╮\n' +
      '│ > [Pasted text #1 +500 lines] paste again to expand │\n' +
      '╰─────────────────────────────────────────╯',
    );
    const cls = classifyOutput(screen);
    expect(cls.trapped).toBe(false); // no real signal on screen — classifies CLEAN
    // No path can flag it: healthy (fresh heartbeat) OR even with every corroborator set,
    // a non-trapped cls short-circuits to false → ZERO alert.
    expect(confirmTrapped(cls, { frozen: true, injectUnanswered: false, heartbeatFresh: true })).toBe(false);
    expect(confirmTrapped(cls, { frozen: true, injectUnanswered: true, heartbeatFresh: false })).toBe(false);
  });

  it('a KNOWN anchored modal on a FROZEN screen IS a trap — no pending message needed', () => {
    // High-confidence chrome (auth/cap/survey/trust). Covers a modal up at startup or one
    // that swallowed an INBOX/agent message (which sets no inject timer).
    expect(confirmTrapped(knownModal, { frozen: true, injectUnanswered: false, heartbeatFresh: false })).toBe(true);
  });

  it('a fresh AGENT heartbeat VETOES even a known modal (demonstrably alive)', () => {
    expect(confirmTrapped(knownModal, { frozen: true, injectUnanswered: false, heartbeatFresh: true })).toBe(false);
  });

  it('a known modal on a NON-frozen (streaming) screen is not a trap', () => {
    expect(confirmTrapped(knownModal, { frozen: false, injectUnanswered: false, heartbeatFresh: false })).toBe(false);
  });

  it('a GENERIC prompt is looser → requires an UNANSWERED inject to corroborate', () => {
    // Frozen generic prompt but nothing unanswered (healthy idle) → NOT trapped.
    expect(confirmTrapped(genericPrompt, { frozen: true, injectUnanswered: false, heartbeatFresh: false })).toBe(false);
    // Frozen generic prompt + a message left unanswered past the deadline → trapped.
    expect(confirmTrapped(genericPrompt, { frozen: true, injectUnanswered: true, heartbeatFresh: false })).toBe(true);
  });

  it('no on-screen signature → never trapped regardless of corroboration', () => {
    expect(confirmTrapped(clean, { frozen: true, injectUnanswered: true, heartbeatFresh: false })).toBe(false);
  });
});
