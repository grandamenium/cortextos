# Spec 01 — Worker-Leak Fix

Framework code (TypeScript strict). No `any`, no `console.log` beyond existing logging idiom. All changes additive/surgical — do not refactor neighbors.

## Part 1 — Mark worker PTYs with CTX_WORKER (3 touches)
1. **src/types/index.ts** — add an optional field to the `CtxEnv` type/interface: `worker?: boolean;` (document: "true only for ephemeral worker PTYs spawned by spawnWorker").
2. **src/daemon/agent-manager.ts** — in `spawnWorker` (line ~1043), the `env: CtxEnv` object at ~1054: add `worker: true,`. DO NOT touch the regular agent-spawn env object at ~line 330 (genuine agent crashes must still alert).
3. **src/pty/agent-pty.ts** — in the `ptyEnv` mapping (the block at ~line 68-77 that sets `CTX_AGENT_NAME` etc.): after the existing CTX_* assignments, conditionally emit the worker marker, e.g.:
   ```ts
   if (this.env.worker) {
     ptyEnv['CTX_WORKER'] = '1';
   }
   ```
   Only when `this.env.worker` is truthy — regular agents must never get `CTX_WORKER`.

## Part 2 — Workers never page on exit
**src/hooks/hook-crash-alert.ts** — in `main()` (line 263), immediately after:
```ts
const agentName = process.env.CTX_AGENT_NAME;
const instanceId = process.env.CTX_INSTANCE_ID || 'default';
if (!agentName) return;
```
add:
```ts
// Worker PTYs are ephemeral; their exit is normal completion, never a crash.
// They inherit CTX_WORKER from spawnWorker's env. Never page Josh on a worker exit.
if (process.env.CTX_WORKER) return;
```

## Part 3 — Max-lifetime reaper for hung workers
**src/daemon/worker-process.ts** — currently has no timer.
- Add a private field: `private maxLifetimeTimer: ReturnType<typeof setTimeout> | null = null;`
- In `spawn()` (after the PTY is created / status set to running), arm it:
  ```ts
  const MAX_WORKER_LIFETIME_MS = 10 * 60_000; // 10 min hard cap for a hung worker
  this.maxLifetimeTimer = setTimeout(() => {
    if (!this.isFinished()) {
      this.log(`Max lifetime (${MAX_WORKER_LIFETIME_MS}ms) exceeded — reaping`);
      void this.terminate();
    }
  }, MAX_WORKER_LIFETIME_MS);
  this.maxLifetimeTimer.unref?.();
  ```
- In the existing `this.pty.onExit(...)` handler (line 57-65), clear it: `if (this.maxLifetimeTimer) { clearTimeout(this.maxLifetimeTimer); this.maxLifetimeTimer = null; }`
- Also clear it in `terminate()` to be safe (idempotent).

A reaped worker → `terminate()` → PTY exit → crash-alert fires but `CTX_WORKER` is set → silent (Part 2). Correct.

## Out of scope for codexer (Larry handles after merge)
- Re-adding `cortextos terminate-worker "$CTX_AGENT_NAME"` to the 3 frank2 worker SKILL.md files.
- Re-enabling the 3 disabled frank2 crons.
Both are the final post-merge steps.

## Verify (codexer)
- `npm run build` clean (TypeScript).
- If running fork tests, scrub all CTX_* env vars first (phantom-failure gotcha) — but note tests run in env that may already set CTX_WORKER; ensure no test regression.
- Leave changes UNCOMMITTED (or committed on a branch `fix/worker-leak`, NOT pushed). Send Larry the diff + scope report. Larry reviews, builds, verifies (spawn test worker → reaped, no telegram; hung worker → reaped), pushes, opens PR.
