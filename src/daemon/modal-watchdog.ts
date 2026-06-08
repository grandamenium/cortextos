/**
 * Modal-trap watchdog classification — DETECTION ONLY.
 *
 * A Claude Code TUI modal (feedback survey, trust prompt, changelog, auth-expiry,
 * weekly-cap, …) can seize the headless PTY and swallow the daemon's bracketed-paste
 * message injection, leaving the agent alive-but-unreachable with a green heartbeat.
 * This module classifies the recent PTY output so the daemon can DETECT that state
 * (→ mark DEGRADED + alert the operator). It deliberately carries NO keypress/dismiss
 * payloads — recovery is operator-triggered this round, so the module structurally
 * cannot become a key-press recovery path by accident. (Automated recovery is a
 * deferred, more-gated follow-up.)
 *
 * Signatures are anchored to distinctive MODAL CHROME (not bare keywords) so the
 * agent's own text that merely mentions e.g. "weekly limit" does not match.
 */

export interface KnownModal {
  name: string;
  /**
   * ALL anchors must be present on the current screen. Requiring the modal's option
   * chrome (not just its question text) makes a prose mention of the question alone
   * insufficient to classify — the agent would have to render the full option layout.
   */
  anchors: RegExp[];
  /** Needs a human (auth-expiry / weekly-cap): the alert must say so. */
  humanRequired: boolean;
}

/**
 * Confirmed modals (chrome-anchored). auth/weekly-cap are human-required; the rest are
 * routine UI prompts. Used for detection + alert wording only — no key is pressed.
 */
export const KNOWN_MODALS: KnownModal[] = [
  {
    name: 'feedback-survey',
    // Question AND the numbered option chrome (Bad/Fine/Good/Dismiss).
    anchors: [/How is Claude doing this session\?/i, /\b0:\s*Dismiss|1:\s*Bad\b|press\s+0\s+to\s+dismiss/i],
    humanRequired: false,
  },
  {
    name: 'trust-folder',
    // Question AND the Yes/proceed option chrome.
    anchors: [/Do you trust the files in this folder\?/i, /Yes, proceed|❯\s*1\.\s*Yes/i],
    humanRequired: false,
  },
  {
    name: 'whats-new',
    anchors: [/What's new in Claude Code/i],
    humanRequired: false,
  },
  {
    name: 'auth-expired',
    anchors: [/Please run \/login|Authentication (?:expired|required)|session has expired.*\/login/i],
    humanRequired: true,
  },
  {
    name: 'weekly-cap',
    anchors: [/You've reached your (?:weekly|usage) limit|usage limit reached.*resets/i],
    humanRequired: true,
  },
];

/**
 * Generic "awaiting input" signatures: a blocking prompt of unknown kind. Their
 * presence (together with the inject-but-no-reply timer) means trapped, not busy.
 */
export const GENERIC_PROMPT_SIGNATURES: RegExp[] = [
  /paste again to expand/i,          // self-inflicted bracketed-paste pileup
  /Press any key to continue/i,
  /Press Enter to continue/i,
  /\(y\/n\)\s*$/im,
];

export interface ModalClassification {
  /** A blocking modal/prompt appears present in the output. */
  trapped: boolean;
  /** Set when a specific known modal matched. */
  known?: KnownModal;
  /** Set when only a generic await-input signature matched (unknown modal). */
  genericPrompt?: boolean;
}

/**
 * Extract an approximation of the CURRENT terminal screen from raw PTY output, so we
 * classify what's on screen NOW — not the agent's own streamed prose sitting in
 * scrollback (which can contain modal-like text and must never trigger a keypress).
 * A full-screen TUI modal clears + redraws, so everything after the last screen-clear
 * is the live screen; otherwise we fall back to the last ~25 non-empty lines.
 */
export function currentScreen(raw: string): string {
  // Take after the last clear-screen / cursor-home, if present.
  const clear = Math.max(raw.lastIndexOf('\x1b[2J'), raw.lastIndexOf('\x1b[3J'), raw.lastIndexOf('\x1b[H'));
  const tail = clear >= 0 ? raw.slice(clear) : raw;
  const lines = normalizeForDiff(tail).split('\n');
  return lines.slice(-25).join('\n').trim();
}

/**
 * Classify the CURRENT SCREEN (pass currentScreen(getRecent()), NOT the raw buffer).
 * Returns trapped only when a modal/await-input signature is on the live screen.
 */
export function classifyOutput(screen: string): ModalClassification {
  for (const m of KNOWN_MODALS) {
    if (m.anchors.every(a => a.test(screen))) return { trapped: true, known: m };
  }
  for (const sig of GENERIC_PROMPT_SIGNATURES) {
    if (sig.test(screen)) return { trapped: true, genericPrompt: true };
  }
  return { trapped: false };
}

/**
 * Strip ANSI/cursor noise so an output-FROZEN comparison isn't fooled by a blinking
 * cursor or spinner repaint. Used to tell a frozen (trapped) screen from a streaming
 * (busy) one.
 */
export function normalizeForDiff(s: string): string {
  return s
    // CSI sequences (colors, cursor moves, erases)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // simple two-char escapes (charset selection, etc.)
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\r\n]+/g, '\n')
    .trim();
}
