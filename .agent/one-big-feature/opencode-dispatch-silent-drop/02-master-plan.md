# OBF Master Plan — Fix opencode dispatch silent-drop

**Slug:** opencode-dispatch-silent-drop · **Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature · **Author:** larry · 2026-07-05

## Problem (verified in source)
A bus message routed to the `opencode` agent can be consumed (removed from inbox) while its PTY injection
silently fails — no reply, no retry, no error to the sender. This lost the pipeline Leg-B dispatch.

**Verified failure points:**
- `src/pty/opencode-pty.ts:151` — `injectMessage(content): void` is fire-and-forget: the real write
  (`typeAndSubmit`) runs inside `setTimeout` (INJECTION_SHELL_RESET_DELAY_MS later) and its failure is only
  `console.warn`ed (lines 200, 212) — never propagated, retried, or surfaced.
- `src/daemon/fast-checker.ts:314-320` — ACKs the inbox message (removes it) based on the synchronous return of
  `injectMessage`, BEFORE the deferred async write is known to have succeeded. Note: the OpenCode override returns
  `void` while base `AgentPTY.injectMessage` returns `boolean` — a type/behavior mismatch the fix must reconcile.

## Invariant to guarantee (the acceptance contract)
**Every inbound dispatch to opencode either (a) is confirmed injected and then ACK'd, or (b) is NOT ACK'd (stays
in inbox for retry) AND, after bounded repeated failure, produces an explicit error reply to the sender.**
No message may be removed from the inbox on an unconfirmed/failed injection. No silent drops.

## Approach (codexer to implement; may refine mechanism with tests)
1. Make injection delivery observable: `injectMessage` returns a `Promise<boolean>` (or invokes a completion
   callback) that resolves TRUE only after the deferred `typeAndSubmit` write actually completes without throwing,
   FALSE on any caught write failure. Reconcile the base vs OpenCode override return types.
2. `fast-checker.ts` awaits that result and ACKs ONLY on TRUE. On FALSE: leave the message in inbox (retry next cycle).
3. Bounded-failure surfacing: track per-message injection attempts; after N (e.g. 3) consecutive failures, emit an
   explicit `bus send-message <sender> normal '[opencode] dispatch injection failed after N attempts: <id>'` so the
   sender is never left in silence, then dead-letter/ACK to avoid an infinite loop.

## Scope boundary
- Files: `src/pty/opencode-pty.ts`, `src/daemon/fast-checker.ts` (+ base `AgentPTY.injectMessage` signature if needed
  in `src/pty/agent-pty.ts` or wherever it's declared). No behavior change for Claude/Codex PTYs — opencode path only.
- No new deps. No config/schema changes. TypeScript strict; no `any`, no `console.log` (existing `console.warn` diagnostics may stay).

## Definition of done
- New regression test (tests/unit/daemon/ or tests/unit/pty/) proving: injection failure → message NOT ACK'd + error
  reply after bounded retries; injection success → message ACK'd exactly once.
- `npm run build` clean, `npm test` green.
- Diff back to larry for adversarial review (scope + invariant) → PR → Josh approves merge.
