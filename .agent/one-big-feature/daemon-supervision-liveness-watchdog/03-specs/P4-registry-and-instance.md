# P4 — Registry-lock hygiene + CLI instance resolution

Independent of P1-P3; can land in parallel.

## Part A — Registry lock (B4)
**Targets:** `src/daemon/agent-manager.ts` (`inspectAgentOp` ~231-242, and the `startAgent` in-flight path ~260-271).

- Wrap the in-flight start in `try/finally` so a failed/aborted start ALWAYS removes the agent from `this.agents` (release the lock). **This is the real B4 fix.** No path may leave a dead agent registered.
- `inspectAgentOp('start', name)` / restart: before returning `DEDUPED` on `this.agents.has(name)`, reconcile against **PID liveness ONLY** — if the registered agent's PTY pid is dead (`this.pty?.getPid()` not alive; available at `agent-process.ts:194,380`), treat it as NOT running and allow start/restart (deregister-then-start).
- **Architect correction (SF-2 — applied): do NOT use P1 marker staleness to authorize deregister.** A healthy agent on a long turn has a stale marker; reconciling on staleness would deregister a LIVE agent and double-spawn a second PTY — exactly the BUG-011 failure. PID liveness is authoritative and safe; marker staleness may be LOGGED as a warning only.
- Preserve the BUG-011/BUG-031 race protection: keep the `daemonJustCrashed` and `pendingRestarts` semantics in the in-flight branch (`agent-manager.ts:247-275`) intact. Two genuinely-overlapping in-flight starts of a LIVE agent (alive pid) still dedupe.

### Acceptance (A)
- Simulated start failure → try/finally leaves agent NOT in registry; next `start` succeeds.
- Registered-but-DEAD-pid agent → plain `restart`/`start` succeeds WITHOUT `disable`/`enable`.
- Registered LIVE agent with a stale marker (long turn) → NOT deregistered, NOT double-spawned.
- Two concurrent starts of a live agent → still deduped (BUG-011 intact).

## Part B — CLI instance resolution (B5)
**Targets:** `src/cli/restart.ts:7`, `src/cli/stop.ts:24`, `src/cli/start.ts:31`. **Model:** `src/cli/status.ts:9,12`.

- Remove the hardcoded `'default'` from `.option('--instance <id>', 'Instance ID', 'default')` in restart/stop/start (make it `.option('--instance <id>', 'Instance ID')`, no default).
- Resolve in each action: `const instanceId = options.instance || process.env.CTX_INSTANCE_ID || 'default';` then `new IPCClient(instanceId)`. (restart.ts also passes instance to `writeStopMarker` — use the resolved `instanceId` there too.)
- **Audit** these for the same hardcoded-default pattern and fix any that ignore `CTX_INSTANCE_ID`: `stop --all`, `enable`, `disable`, `notify-agent`, `doctor`. Report which were touched in the diff.

### Acceptance (B)
- With `CTX_INSTANCE_ID=cortextos1` and no `--instance`: `restart`/`stop`/`start` target `cortextos1`.
- Explicit `--instance foo` still wins over the env var.
- Neither set → `default` (back-compat).
