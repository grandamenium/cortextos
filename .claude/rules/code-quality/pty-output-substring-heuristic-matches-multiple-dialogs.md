# PTY output-substring "auto-Enter" heuristics false-positive when sibling dialogs share a substring

**An auto-accept heuristic that watches PTY output for keyword X and presses Enter when X appears is fragile across vendor TUI updates.** Today's heuristic targets a benign dialog where the default option is the user's intent. Tomorrow's vendor release ships a *new* dialog whose text contains the same keyword but whose default option is destructive. The heuristic helpfully presses Enter on a dialog whose default is "No, exit" or "Cancel" or "Delete" — the agent now exits / aborts / loses data with no error log.

## Class of trap

Any "wait for substring → write \r" pattern over a foreign TUI's data stream. The trap composes from three factors that are all individually reasonable:

1. **The keyword is generic.** `'Yes'` is in any dialog with a "Yes" option. `'continue'`, `'accept'`, `'OK'` are similarly broad. Generic keywords match more dialogs than the author intended.
2. **The TUI vendor adds a sibling dialog over time.** Claude Code 2.1+ added a "Bypass Permissions" warning. Both the original "trust this folder?" dialog AND the new bypass warning contain `'Yes'`-shaped buttons.
3. **Default options diverge.** Original dialog defaulted to the safe-ack option (`Yes, trust`). New dialog defaults to the destructive option (`No, exit`) — a deliberate vendor safety choice. Same Enter keystroke, opposite outcome.

The heuristic was written against (1) and (2-as-of-then). When (2) changes and (3) inverts the default, the heuristic silently does the wrong thing.

## Pattern fix

**Do not rely on output-substring heuristics for keyboard input.** Use structured pre-acceptance via the consumer's own config files when the vendor offers one (`hasTrustDialogAccepted: true` written into `~/.claude.json:.projects[<cwd>]` BEFORE spawn). When the vendor explicitly does not offer config suppression (see `bypass-dialog-no-config-suppression.md`), use a heuristic with these guards:

- **Single-word, dialog-unique substring.** Don't match `'Yes'` (in many dialogs). Match `'Bypass'` or `'trust'` — words that appear only in the specific dialog you're handling.
- **Set the dedup flag SYNCHRONOUSLY before any setTimeout** so a sibling handler matching the same data chunk cannot fire after you. Race-free dispatch is non-negotiable.
- **Press the dialog-specific keystroke**, not just Enter. If the destructive option is the default, send navigation (`\x1b[B` for down-arrow, etc.) THEN Enter. Don't assume Enter is safe.
- **Log every match + action** so a future regression is auditable. If the heuristic fires on an unexpected dialog, the operator should be able to grep for it.

## Rule of thumb

Treat any third-party TUI as "the vendor will add new dialogs without notice, and they will overlap with the substrings my heuristic watches for." Build the heuristic to a *specific* dialog identity, not a substring intersection. When the vendor adds something new, the heuristic should fail to match (and surface a fallback path) — not match-and-do-the-wrong-thing.

A sanity-test for the trap: spawn the agent with the heuristic disabled. Does it wedge on a known dialog? Re-enable, confirm it accepts. Now spawn with a NEW dialog the heuristic wasn't designed for (mock by injecting the dialog text into the PTY) — does the heuristic ignore it? If it Enter-presses, the heuristic is too broad.

## Source incident

`src/pty/agent-pty.ts:201-219` (pre-fix) used `data.includes('trust') || data.includes('Yes')` with a setTimeout-driven Enter at 5s and 8s. Designed for the workspace-trust dialog (default "Yes, trust"). Claude Code 2.1+ added the Bypass Permissions warning whose text contains "Yes, I accept" — heuristic matched on `'Yes'`, sent Enter at 5s, "No, exit" was still highlighted, claude exited cleanly. Fleet crash-looped through repeated daemon respawns for ~90 minutes on 2026-05-08 with `crashes.log` showing exit-code-0 / `reason=none` — the cleanest possible kill, no error trace, hardest possible to diagnose from logs alone. The fix replaces the heuristic with a dialog-specific handler matching `'Bypass'` (single word, never split by ANSI codes) and `'trust'` (no overlap with sibling dialog), plus a synchronous dedup flag and a structured pre-spawn `seedTrustDialog` write to `~/.claude.json` so the trust dialog usually doesn't render at all. Pattern adapted from upstream PR #236 (closed unmerged).
