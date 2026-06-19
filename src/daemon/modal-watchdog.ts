/**
 * Modal-trap watchdog classification — DETECTION ONLY.
 *
 * A Claude Code TUI modal (feedback survey, trust prompt, changelog, auth-expiry,
 * usage-cap, …) can seize the headless PTY and swallow the daemon's bracketed-paste
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
  /** Needs a human (auth-expiry / usage-cap): the alert must say so. */
  humanRequired: boolean;
}

/**
 * Confirmed modals (chrome-anchored). auth/usage-cap are human-required; the rest are
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
    // Covers weekly AND 5h-session AND usage caps — all are "wait for reset", human-required.
    // ★ Anchored to the REAL on-screen text captured off 6 live trapped agents (2026-06-12),
    // NOT a guess: "You've hit your <weekly|session> limit · resets <time>". The prior anchor
    // ("reached your weekly/usage limit") matched NONE of them — a silent false-negative on
    // the exact trap it must catch (valor's live-fire finding). The apostrophe class covers a
    // curly U+2019 ("You’ve") as well as a straight one; the 'resets' co-anchor is the modal
    // chrome that keeps a prose mention of "weekly limit" from matching.
    name: 'usage-cap',
    anchors: [/You['’]ve (?:hit|reached) your (?:weekly|session|usage) limit/i, /\bresets?\b/i],
    humanRequired: true,
  },
];

/**
 * Generic "awaiting input" signatures: a genuinely BLOCKING prompt of unknown kind. Each
 * must be a real input-blocking string, never a benign display hint. Even so, a match here
 * is NOT sufficient on its own — the caller corroborates (see confirmTrapped) before any
 * alert, because these are looser than the anchored KNOWN_MODALS.
 *
 * ★ NOTE: '/paste again to expand/' was REMOVED (valor's scar-tissue lesson, 2026-06-12).
 * It is a BENIGN collapsed-bracketed-paste hint that Claude Code renders on a perfectly
 * HEALTHY idle prompt — not a blocking modal. It was the exact trigger of the 79-alert
 * flood to the founder: a frozen idle screen + this artifact read as trapped. A real
 * blocking signal must be required; a benign artifact must never be one.
 */
export const GENERIC_PROMPT_SIGNATURES: RegExp[] = [
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
 * Live corroboration for a trap decision. A screen signature ALONE is never enough — an
 * IDLE agent's screen is frozen and can show a benign artifact (e.g. "paste again to
 * expand", a collapsed bracketed-paste hint on a normal prompt). These signals distinguish
 * a real trap from healthy idle/busy.
 */
export interface TrapSignals {
  /** The current screen has not changed for the freeze window (not streaming/working). */
  frozen: boolean;
  /**
   * A message was injected and has gone UNANSWERED past the reply deadline. This is the
   * decisive corroborator: a healthy IDLE agent has nothing pending (false here), so the
   * benign on-screen artifact cannot trip a trap.
   */
  injectUnanswered: boolean;
  /** The agent wrote a FRESH heartbeat (it is demonstrably alive) — vetoes any trap. */
  heartbeatFresh: boolean;
}

/**
 * Confirm a REAL modal-trap from the screen classification PLUS live corroboration.
 * Requires ALL of: a blocking signature on screen, a frozen screen, AND an injected message
 * sitting unanswered past its deadline — and is VETOED by a fresh heartbeat. A still-
 * heartbeating, cron-firing, or replying agent is by definition NOT trapped, regardless of
 * any benign prompt artifact. (Fixes the false-positive where 'paste again to expand' on a
 * healthy idle prompt + a frozen idle screen alone classified the agent trapped.)
 */
export function confirmTrapped(cls: ModalClassification, s: TrapSignals): boolean {
  if (!cls.trapped) return false;     // no blocking signature on the live screen
  if (s.heartbeatFresh) return false; // demonstrably alive -> not trapped, regardless of screen
  if (!s.frozen) return false;        // streaming/working -> not blocked
  // An anchored KNOWN modal (auth-expiry, usage-cap, survey, trust, changelog) is
  // high-confidence chrome the agent's prose cannot easily forge on the live post-clear
  // screen — a frozen one IS a real trap, even with nothing injected (e.g. a modal already
  // up at startup, or one that swallowed an INBOX/agent message which sets no inject timer).
  if (cls.known) return true;
  // A GENERIC await-input signature is looser, so it needs the extra corroborator: a message
  // sitting UNANSWERED past the deadline. (A healthy idle agent has nothing unanswered.)
  return s.injectUnanswered;
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
