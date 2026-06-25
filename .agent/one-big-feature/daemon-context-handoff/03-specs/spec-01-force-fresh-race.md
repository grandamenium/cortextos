# SPEC — Daemon-native context handoff (make force-restart cleanly clear context)

**Status:** proposed (Josh asked to spec; do NOT implement while fleet is being stabilized via gstack restore).
**Owner repo:** cortextos framework (`~/code/cortextos/src/daemon/`).
**Why:** The fleet's clean "long session → save → clean restart → cleared context" depended on gstack's `/context-save`-before-compact. When gstack was removed (June 22), the only remaining reset path was the daemon's context-watchdog force-restart — which does NOT reliably clear context. This spec makes the daemon's own force-restart a reliable clean reset, so context management does not depend on a removable plugin.

## Root-cause findings (from reading the code 2026-06-25)
1. **Clean restart mechanism** (`agent-process.ts:582-593, 753-793`): a `.force-fresh` marker forces a fresh Claude session. `shouldContinue()` checks the marker, **deletes it**, and returns false (fresh). Otherwise resumes with `--continue` (keeps context).
2. **The race** (`agent-manager.ts:283-308, 918-933`): when a restart is queued in `pendingRestarts` (BUG-011 "regression check" warning fires — "race condition leaked through"), `stopAgent()` fires a SECOND `startAgent(name,'')` as a safety net. Two starts race: the first consumes/deletes `.force-fresh` → fresh; the second finds no marker, sees a session file exists → falls back to `--continue` at full context → the watchdog re-fires → loop.
3. **Force-restart logged as** `CONTEXT-FORCE-RESTART: ctx 100% — handoff not completed within 5min` then `CRASH exit_code=1`, climbing to `HALTED crash_count=10`. Fleet-wide because all agents share this daemon path. Went live on the June-24 dist (~11:14 daemon restart).

## Required behavior
- A context-watchdog force-restart (or any handoff restart) MUST result in a FRESH session, regardless of restart races. The `.force-fresh` intent must not be lost when a queued/duplicate restart consumes the marker first.

## Proposed fixes (pick during implementation; 1+2 recommended together)
1. **Make `.force-fresh` survive the race.** When `stopAgent()` honors a queued restart (`agent-manager.ts:930`), if the agent had a handoff/force-restart pending (`.handoff-doc-path` or `.force-fresh` present at trigger time), RE-ARM `.force-fresh` before the queued `startAgent()`. Track the "fresh intent" on the pendingRestarts entry rather than relying solely on the on-disk marker that a racing start can consume.
2. **Eliminate the double-start.** Investigate why `pendingRestarts` fires at all (PR #11 was supposed to close BUG-011 by making `AgentProcess.stop()` block until the process truly exits). If `stop()` regressed to returning before exit on the June-24 dist, fix `stop()` to await real exit so `startAgent` never overlaps a live process → no queued duplicate restart.
3. **Idempotent fresh-start guard.** `shouldContinue()` should treat "a handoff doc path marker exists" as authoritative for fresh (return false) even if `.force-fresh` was already consumed, so a racing second start still goes fresh.

## Verification
- Repro: drive an agent to the ctx threshold and force two overlapping restarts; assert the resulting session is fresh (small context, not `--continue`).
- Regression: confirm `pendingRestarts fired ... race condition leaked through` no longer logs under normal watchdog restarts.
- Fleet check: each agent's restarts.log shows clean HARD-RESTART without the CRASH/HALTED cascade.

## Sequencing
- Build via codexer (framework change), adversarial review, then ONE clean daemon rebuild + restart (kill-switch gated — Josh approval).
- AFTER this lands + is proven, revert larry `config.json` `ctx_handoff_threshold` 101 → 70 (band-aid removal) so the watchdog behaves normally again.

## Related
- gstack context-management restore (the immediate fix, done 2026-06-25): `~/.claude/skills/context-save` + shared CLAUDE.md Context Management section.
- BUG-011 / PR #11 history in `agent-manager.ts` comments.
