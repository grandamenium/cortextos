# Claude Code 2.1.126's Bypass Permissions warning has NO config suppression — must be auto-accepted via PTY input

**Neither `permissions.defaultMode: "bypassPermissions"` in `settings.json` nor `--permission-mode bypassPermissions` on the CLI suppresses the interactive WARNING dialog Claude Code 2.1+ added.** The dialog ALWAYS renders when `--dangerously-skip-permissions` (or its equivalent permission-mode flag) is in effect. Headless agents wedge on it with no way out unless something programmatically navigates to "Yes, I accept" and presses Enter.

## Symptom

```
WARNING: Claude Code running in Bypass Permissions mode
…
By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.
❯ 1. No, exit
  2. Yes, I accept
Enter to confirm · Esc to cancel
```

Default selection is "1. No, exit". Enter on the default cleanly exits claude with code 0 (or 1 in newer versions) — the agent crash log shows `reason=none` and the daemon respawn loops.

## Why config suppression doesn't work

`settings.json:permissions.defaultMode: "bypassPermissions"` was the upstream fix proposed in PR #347 / commit 402464b for an OLDER class of permission-blocking issue (per-tool-call permission stalls). It pre-sets the mode so first tool calls don't prompt. **It does not silence the session-startup safety dialog.** Verified empirically on Claude Code 2.1.126 — with the field set, with `--permission-mode bypassPermissions` AND/OR `--dangerously-skip-permissions` on the CLI, the warning still renders.

The dialog is by design un-suppressable via config — it's the user's chance to say "I understand the risk." There's no `bypassPermissionsModeAccepted: true` flag in `~/.claude.json` that bypasses it. The only way past is keyboard input.

## Pattern fix

Use the upstream-tested PTY auto-accept from PR #236 (closed unmerged but the fix works on 2.1.126):

```ts
let bypassAccepted = false;
let trustAccepted = false;

this.pty.onData((data: string) => {
  this.outputBuffer.push(data);
  if (!this.pty) return;

  // Single-word "Bypass" — multi-word matches break on ANSI codes
  if (!bypassAccepted && data.includes('Bypass')) {
    bypassAccepted = true; // SYNCHRONOUS — blocks trust handler from firing on same chunk
    this.pty.write('\x1b[B'); // down-arrow → "Yes, I accept"
    setTimeout(() => { if (this.pty) this.pty.write('\r'); }, 300);
    return;
  }

  // Trust handler matches "trust" only (NOT "Yes") — sibling dialog has "Yes, I accept" in it
  if (!trustAccepted && data.includes('trust')) {
    trustAccepted = true;
    this.pty.write('\r');
  }
});
```

Key elements:

- **Single-word substring matching.** Raw PTY data interleaves ANSI cursor-forward codes between characters; multi-word matches like `'Bypass Permissions'` or `'No, exit'` fail silently because the bytes don't appear contiguously.
- **Synchronous `bypassAccepted = true`** before any `setTimeout` — the trust handler must NOT fire on the same data chunk and Enter-press while "No, exit" is still highlighted.
- **`'trust'` for the trust handler, never `'Yes'`** — `'Yes, I accept'` appears in the bypass menu; matching `'Yes'` fires the trust handler on the wrong dialog.
- **300ms delay between down-arrow and Enter** — gives the TUI time to update its highlight.
- **Fallback probes at 2s and 5s** that re-scan `outputBuffer.getRecent()` in case the prompt arrived before `onData` registered, with the same dedup guards.

Keep BOTH `--dangerously-skip-permissions` AND `--permission-mode bypassPermissions` on the CLI: on Claude Code 2.1.126, the `--permission-mode` flag alone exits with code 1 ("permission mode not enabled"). The legacy flag enables the option; the modern flag selects the specific mode.

## Rule of thumb

Safety dialogs are designed to require human acknowledgment. If your headless deployment uses `--dangerously-skip-permissions` or any equivalent "I know what I'm doing" flag, expect the vendor to add a confirmation dialog over time — and budget for programmatic acceptance via PTY navigation, not config flags. The dialog is a feature, not a bug; suppressing it server-side defeats its purpose, so vendors don't ship a config switch.

## Source incident

2026-05-08 fleet wedge cascading from BL-003 (multi-Claude-account profiles). Upstream commit `402464b` ("set permissions.defaultMode=bypassPermissions") was ported into our templates and live agent settings.json files; agents still wedged on the bypass dialog. Adding `--permission-mode bypassPermissions` to the CLI did not help. Adding `--permission-mode bypassPermissions` ALONE without `--dangerously-skip-permissions` produced exit code 1. Only the upstream PR #236 PTY auto-accept pattern (closed unmerged on `upstream/fix/cc-2.1-bypass-permissions`) actually navigated past the dialog in 2.1.126. The fix has been ported into `src/pty/agent-pty.ts` with the single-word + synchronous-flag guards intact.
