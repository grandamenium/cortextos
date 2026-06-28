# Master Plan — Worker-Leak Fix (cortextOS framework)

## Problem (Josh via main session, 2026-06-23; incident_frank2_worker_leak_2026-06-22.md)
frank2 worker sessions (comms-check / meeting-commitments / transcript-scanner, spawned by `cortextos spawn-worker` on crons) are interactive PTYs that never exit. They accumulate (~4/hr), and twice crashed the box (104 workers, load 465, RAM exhausted). Adding a self-terminate step to the SKILLs backfired: worker sessions inherit frank2's `.claude/settings.json` SessionEnd hook = `cortextos crash-alert`, which classifies any unmarked worker exit as `type=crash` and Telegrams Josh. There is no silent-exit path for workers, so self-terminate → crash-alert spam every 15 min.

## Adversarial review verdict
Fix is sound. One correction to the original spec: `CTX_WORKER` cannot simply be added to the object at `agent-manager.ts:1054` — that is a **typed `CtxEnv`**. It must be threaded through the `CtxEnv` type and the `agent-pty.ts` ptyEnv mapping. Confirmed `CTX_AGENT_NAME` is already emitted (`agent-pty.ts:71`), so the SKILL `terminate-worker "$CTX_AGENT_NAME"` step works once the hook is silenced.

## Fix (ordered — 1+2 MUST land before re-adding terminate-worker to SKILLs)
1. **Mark workers** (3 touches): add `worker?: boolean` to `CtxEnv` (src/types/index.ts); set `worker: true` in `spawnWorker`'s env (src/daemon/agent-manager.ts:1054); emit `CTX_WORKER: '1'` in `agent-pty.ts` ptyEnv (~line 74) only when `this.env.worker`. The regular agent spawn env (agent-manager.ts:330) must NOT set `worker` — genuine agent crashes must still page Josh.
2. **Silence the hook for workers**: src/hooks/hook-crash-alert.ts `main()` — early `if (process.env.CTX_WORKER) return;` right after the `if (!agentName) return;` guard.
3. **Reaper**: src/daemon/worker-process.ts — add a max-lifetime timer in `spawn()` (~10 min, unref'd) that calls `this.terminate()` if not finished; clear it in the existing `onExit` handler. Prevents a worker that HANGS before completing from accumulating.

Then (only after code lands + merges): re-add `cortextos terminate-worker "$CTX_AGENT_NAME"` as the final step in the 3 frank2 worker SKILLs (Larry edits those `.md` files; `m2c1-worker/SKILL.md` is the working reference).

## Verify
- Build: `npm run build` clean. Run env-clean (scrub CTX_* before fork tests — phantom-failure gotcha).
- Spawn a test worker → it is reaped, NO crash Telegram fires.
- A hung worker → reaped by the max-lifetime cap.

## Interim state (DO NOT undo until fix merged+verified)
3 frank2 crons disabled in `.cortextOS/state/agents/frank2/crons.json` (enabled:false); leaked workers killed; backup at `/tmp/frank2-crons-backup-*.json`. Re-enable (enabled:true + reload) as the FINAL step.

## Sequencing
Single cohesive framework fix → one PR → Josh merges (no direct main push). Dispatch codexer only after the in-flight group-interviews build returns (do not fork codexer mid-build).
