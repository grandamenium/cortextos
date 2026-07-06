# Spec 01 — Guaranteed opencode injection (no silent drops)

## Verified call path (READ FIRST — the middle layer is where the bug actually lives)
`FastChecker.pollCycle` (fast-checker.ts:314) does NOT call the PTY directly. It calls
`this.agent.injectMessage(...)` where `this.agent` is an **`AgentProcess`**:
1. `AgentProcess.injectMessage` (agent-process.ts:466) → `injectMessageDetailed` (agent-process.ts:441).
2. `injectMessageDetailed:451-452` calls `this.pty.injectMessage(content)` (the OpenCodePTY fire-and-forget void)
   **and ignores its return**, then line 458 **unconditionally returns `{ok:true}`**.
3. That `true` flows to fast-checker → `if (injected)` → `ackInbox` **deletes the inflight file** (checkInbox
   moved it to `inflight/` on read). opencode's real `typeAndSubmit` runs later in a `setTimeout` and, if it
   fails (shell mode / pty torn down / TUI didn't surface), only `console.warn`s → **message permanently gone.**

So the swallow point is **`injectMessageDetailed` (agent-process.ts:441-458)**, not just the PTY. A fix that only
makes `opencode-pty.injectMessage` return a boolean is **INERT** unless that boolean is threaded through
`injectMessageDetailed` → `AgentProcess.injectMessage` → the awaited call in fast-checker.

**Target files (all four signatures must change together):**
- `src/pty/opencode-pty.ts` — override `injectMessage`, ~line 151 (make the deferred write awaitable).
- `src/pty/agent-pty.ts` — base `injectMessage`, line 319 (align signature; Claude/Codex resolve TRUE, semantics unchanged).
- `src/daemon/agent-process.ts` — `injectMessageDetailed` (441-458) + `injectMessage` (466): capture and propagate the
  PTY result instead of hardcoding `{ok:true}`. Keep the `codex-app-server` else-branch (453-457) behaviorally identical
  (resolve TRUE). Preserve `NOT_RUNNING` / `DEDUPED` early returns.
- `src/daemon/fast-checker.ts` — inject+ACK block, ~lines 314-333 (`await`, ACK only on TRUE, dead-letter counter).

## Change
Convert opencode message injection from fire-and-forget to confirmed-delivery, and never ACK an unconfirmed message.

1. **opencode-pty.ts** — `injectMessage` must report completion of the DEFERRED write. Return `Promise<boolean>`
   (resolve TRUE after `typeAndSubmit` completes without throwing; FALSE in every `catch`). Preserve the existing
   Escape / shell-exit-recovery / chat-vs-shell mode logic and the setTimeout timings — only make the outcome awaitable.
2. **base AgentPTY** — align the base `injectMessage` signature so callers can `await` uniformly. Claude/Codex behavior
   unchanged (they can resolve TRUE synchronously-equivalent). Do NOT alter Claude/Codex injection semantics.
3. **fast-checker.ts** — `await this.agent.injectMessage(messageBlock)`. ACK (`ackInbox`) the ids ONLY when it resolves
   TRUE. On FALSE: do NOT ACK (message stays in inbox for the next cycle). Keep the post-injection cooldown only on TRUE.
4. **Bounded-failure surfacing** — maintain a per-message-id attempt counter (in-memory map keyed by inbox id). After
   3 consecutive FALSE injections for the same id, emit `cortextos bus send-message <senderAgent> normal
   '[opencode] dispatch injection failed after 3 attempts (id <id>) — not delivered'` and then ACK that id to
   dead-letter it (prevents an infinite re-inject loop). Sender/agent name comes from the inbox message metadata.

5. **Dedup must not defeat retry** — `injectMessageDetailed:446` dedups on content hash. A FALSE injection that will be
   retried next poll cycle carries identical content; without care the retry returns `DEDUPED` and the message is never
   re-injected (a second silent drop). Ensure a FAILED injection does NOT record/retain the content in the MessageDedup
   window (e.g. only mark dedup after a confirmed TRUE injection, or roll it back on FALSE), so the next-cycle retry
   actually re-injects. Claude/Codex dedup behavior on SUCCESS stays unchanged.

## Rules
- opencode path only — Claude/Codex PTY injection behavior must be byte-identical to today (assert in a test if practical).
- TypeScript strict. No `any`. No new `console.log` (existing `console.warn` diagnostics may remain). No new deps.
- No config/schema changes.

## Acceptance
- Regression test (tests/unit/daemon/ or tests/unit/pty/):
  (a) injection SUCCESS → id ACK'd exactly once, no error reply.
  (b) injection FAILURE once → id NOT ACK'd (stays in inbox), no error reply yet.
  (c) injection FAILURE 3× for same id → one explicit error reply to sender, then id ACK'd (dead-lettered).
  (d) injection FAILURE then next-cycle RETRY of the same content is NOT swallowed by dedup — the retry re-injects
      (i.e. a failed inject does not poison the MessageDedup window).
- `npm run build` clean; `npm test` green.
- Return full diff to larry for adversarial review (scope = these files + the invariant; no scope creep) before any PR.
