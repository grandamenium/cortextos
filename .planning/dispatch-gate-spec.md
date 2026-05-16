# cortextos dispatch gate — spec

Stops long-running peer-agent dispatches from going out without an explicit
SCOPE_VALIDATION checkpoint from Josh.

## What fires the gate

Hook: `~/.claude/hooks/cortextos-dispatch-gate.js`
Wires as: `PreToolUse:Bash` in `~/.claude/settings.json` (NOT yet registered —
Josh wires when ready).

The hook inspects every Bash command. It only takes action when the command
matches:

```
cortextos bus send-message <agent> ...
```

Pass-through (exit 0, no check):
- Any non-Bash tool call.
- Any Bash command that is not `cortextos bus send-message`.
- `send-message` to a housekeeping recipient: `heartbeat`, `heartbeat-watcher`,
  `log-relay`, `log-event`, `cron`, `cron-fire`, `inbox`, `ack`, `metrics`,
  `telemetry` (mirrors the suppression list in
  `src/hooks/hook-tool-result-router.ts`).
- `send-message` to a real agent whose message body has no task-id shape
  (assumed to be conversational / status / non-dispatch).

Gated (must have a fresh marker):
- `send-message` to a non-housekeeping agent whose body contains either a
  `task_<id>` token or a `scope:<id>` prefix. These are the dispatch shapes
  used for >10min work.

## What the marker file means

Path: `/tmp/scope-validated-<task-id>`
TTL: 15 minutes (mtime check, same convention as `auditos-verify-gate.js`).

Presence + freshness means: Josh has reviewed the scope of `<task-id>`,
confirmed it matches what he wants the agent to actually do, and explicitly
authorized dispatch. The marker is the only acceptable proof.

## How Josh creates the marker

After scope-validation (verbal "SCOPE_VALIDATION" / nod / "go" on the
specific task):

```bash
touch /tmp/scope-validated-task_abc123
# or, for scope:foo shape:
touch /tmp/scope-validated-scope-foo
```

The dispatch must happen within 15 minutes of the touch. If the dispatch
agent stalls past TTL, Josh re-touches the marker.

## How to bypass for emergencies

Two options, both require re-establishing scope:

1. Re-validate: `touch /tmp/scope-validated-<task-id>` and dispatch again.
2. Force-clear then re-validate: `rm /tmp/scope-validated-<task-id> &&
   touch /tmp/scope-validated-<task-id>`.

There is no "skip the gate" flag by design. If the gate is wrong, fix the
hook — don't paper over it.

## Debug log

Every fire writes to `/tmp/cortextos-dispatch-gate.log`. Lines show
ALLOW/BLOCK + reason. Tail it when the gate behaves unexpectedly.

## Failure mode

Fail-open. Any parse error, missing payload, unrecognized shape, or marker
stat failure exits 0 (allow). The only path to exit 2 (block) is: matched
`send-message` + non-housekeeping agent + extractable task-id + marker
missing or stale.
