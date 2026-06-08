import { describe, it, expect } from 'vitest';
import { classifyOutput, currentScreen, normalizeForDiff } from '../../../src/daemon/modal-watchdog';

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

  it('auth-expiry and weekly-cap are HUMAN-REQUIRED (alert, can\'t be keyed away)', () => {
    expect(classifyOutput('Authentication expired. Please run /login to continue.').known?.humanRequired)
      .toBe(true);
    expect(classifyOutput("You've reached your weekly limit").known?.humanRequired)
      .toBe(true);
  });

  it('the module exposes NO keypress payload (detection-only invariant)', () => {
    const c = classifyOutput('How is Claude doing this session?\n0: Dismiss');
    expect(c.known).toBeDefined();
    expect((c.known as Record<string, unknown>).action).toBeUndefined();
    expect((c.known as Record<string, unknown>).key).toBeUndefined();
  });

  it('detects a generic await-input prompt (unknown modal)', () => {
    const c = classifyOutput('[Pasted text #1 +500 lines] paste again to expand');
    expect(c.trapped).toBe(true);
    expect(c.genericPrompt).toBe(true);
    expect(c.known).toBeUndefined();
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
