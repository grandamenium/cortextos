# Daemon-native context handoff — make force-restart cleanly clear context (fleet-critical)

## Goal
The daemon's context-watchdog force-restart MUST reliably start a FRESH Claude session (cleared context), independent of any plugin (gstack) and immune to restart races. This removes the fleet-wide crash loop where agents drift to 100% context, the force-restart falls back to `--continue`, and they re-loop.

## Root cause (verified in source, 2026-06-25)
- Clean restart = `.force-fresh` marker → `agent-process.ts shouldContinue()` returns false (fresh) and deletes the marker.
- `agent-manager.ts:918-933` `stopAgent()` honors a queued `pendingRestarts` entry by firing a SECOND `startAgent(name,'')`. Two starts race: first consumes `.force-fresh` → fresh; second finds no marker + an existing session file → `--continue` at full context → watchdog re-fires → loop.
- Log signature: `BUG-011 REGRESSION CHECK: pendingRestarts fired ... race condition leaked through`, then `CONTEXT-FORCE-RESTART ... handoff not completed within 5min`, `CRASH exit_code=1`, `HALTED crash_count=10`. Fleet-wide (shared daemon). Live since June-24 dist (~11:14).

## Scope
Single repo (cortextos framework), focused daemon fix. Spec: 03-specs/spec-01-force-fresh-race.md.

## Done = 
A watchdog/handoff force-restart always yields a fresh session even under overlapping/queued restarts; the BUG-011 regression warning no longer fires in normal operation; verified by test + a real agent restart showing cleared context.
