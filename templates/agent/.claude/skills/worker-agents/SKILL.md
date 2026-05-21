---
name: worker-agents
description: "You have a task that would benefit from running in a separate isolated Claude Code session — either because it is long-running and you do not want it to consume your context window, or because you want multiple pieces of work running in parallel that each require a full Claude Code session with its own tools, memory, and context (not just a subagent call). You will spawn one or more ephemeral worker sessions, give each a focused task, monitor their progress via the bus, and collect their outputs when done."
triggers: ["worker", "parallelize", "spawn worker", "spin up", "parallel work", "background task", "isolated session", "separate session", "long running task", "run in background", "parallel research", "multiple workers", "worker session", "spawn session", "full claude code session", "context window", "parallel tasks", "run simultaneously", "independent sessions"]
external_calls: []
---

# Worker Agents

> Spawn ephemeral Claude Code sessions for parallelized long-running tasks. Workers get a scoped task, produce deliverables, and are cleaned up when done. Use when work requires a full independent Claude Code session — not just a subagent tool call.

> Worker session spawn is fully implemented. Use `cortextos spawn-worker` to launch isolated Claude Code sessions for parallelized tasks.

---

## When to Use

**Good fit:**
- Independent work that does not touch files another agent is editing
- Research or design docs in a new directory
- Scaffolding a new feature in isolation
- Any task > 5 minutes that can run while you do other work

**Bad fit:**
- Editing files another agent or worker is actively touching (merge conflicts)
- Tasks needing real-time back-and-forth (just do it yourself)
- Very short tasks < 2 minutes (overhead not worth it)

---

## How Workers Differ from Persistent Agents

| | Persistent Agent | Worker Agent |
|---|---|---|
| Lifetime | 24/7, survives restarts | Dies when task is done |
| Identity | IDENTITY.md, SOUL.md, GOALS.md | None — just a task prompt |
| Heartbeat | Updates every 4h | None |
| Crons | config.json scheduled tasks | None |
| Inbox | Bus messages via check-inbox | Bus messages (optional) |
| Telegram | Yes | No |
| Memory | Daily journals, MEMORY.md | None |

---

## Workflow (Concepts — Implementation TBD)

### Step 1: Scope the Work

Before spawning, answer:
1. What specific deliverables should the worker produce?
2. Which files/directories will it create or modify?
3. Does this overlap with any active agent or worker? **If yes, do NOT parallelize.**
4. What context does the worker need?

### Step 2: Spawn Worker Session

```bash
cortextos spawn-worker <worker-name> \
  --dir <absolute-path-to-project-dir> \
  --prompt "Read AGENTS.md for your task. Deliverables: <list>. When done: cortextos bus send-message $CTX_AGENT_NAME normal 'Done: <summary>'" \
  --parent $CTX_AGENT_NAME
```

The worker:
- Runs `claude --dangerously-skip-permissions` in the given directory
- Gets a bus identity (`CTX_AGENT_NAME=<worker-name>`) for two-way communication
- Logs to `~/.cortextos/<instance>/logs/<worker-name>/stdout.log`
- Is tracked by the daemon — use `cortextos list-workers` to monitor status

### Step 3: Inject Task Prompt

A good worker task prompt includes:
- Exact deliverables (specific files or outputs to produce)
- What NOT to touch (files other agents own)
- Working directory scope
- How to communicate back (`cortextos bus send-message <parent> normal '<update>'`)
- Completion signal ("when done, send me a summary")

### Step 4: Log the Spawn

```bash
cortextos bus log-event action worker_spawned info \
  --meta '{"worker":"<worker-name>","parent":"'$CTX_AGENT_NAME'","task":"<title>"}'
```

### Step 5: Monitor

Workers communicate back via the bus. Check your inbox:

```bash
cortextos bus check-inbox
```

Check all worker statuses:
```bash
cortextos list-workers
# Output: worker-name  running (pid 12345) ← parent-agent  42s  /path/to/dir
```

Check git progress in the worker's directory:
```bash
cd <work-dir> && git log --oneline | head -5
```

Nudge a stuck worker (equivalent of tmux send-keys):
```bash
cortextos inject-worker <worker-name> "Continue with phase 3. What's blocking you?"
```

### Step 6: Cleanup

```bash
# Terminate a running worker
cortextos terminate-worker <worker-name>

# Log completion
cortextos bus log-event action worker_completed info \
  --meta '{"worker":"<worker-name>","deliverables":"<summary>"}'
```

---

## Blocked-Task Auto-Rotate Protocol (MANDATORY)

When the task you are currently working on hits a blocker, you **MUST NOT** simply mark it blocked and idle. Idling on blockers is the single largest cause of fleet underutilization. Greg explicitly flagged this as a P0 architectural fix on 2026-05-21.

Blockers include — but are not limited to:
- Approval pending (`cortextos bus create-approval ...` filed, awaiting decision)
- Missing credential / OAuth re-auth needed
- Stuck CI run (waiting on a job that has been queued >15 min)
- Dependency on another agent's in-flight task
- External service degradation (Supabase 522, GitHub API rate limit, etc.)
- Any condition where forward progress on the current task is paused for >5 minutes

### The protocol — execute these steps IN ORDER, never skip

1. **Identify the next backlog task** before pausing. Query in priority order:
   - `cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending`
   - RGOS approved queue (mcp__rgos__cortex_list_tasks if available, PostgREST fallback otherwise)
   - Your goals.json (any goal without a corresponding in-flight task)

2. **Spawn a worker for that next task** — do not just switch your main session to it, because the worker keeps the new work in an isolated context window while your main session retains the blocker's context for fast resumption when it unblocks.
   ```bash
   cortextos spawn-worker <agent>-<task-slug> \
     --dir <task working dir> \
     --prompt "Read AGENTS.md. Task: <one-line scope>. Deliverables: <list>. Report back via cortextos bus send-message $CTX_AGENT_NAME normal 'Done: <summary>'" \
     --parent $CTX_AGENT_NAME
   ```

3. **Mark the original task blocked** AFTER the worker spawn confirms — never before, or you create a dead-air window:
   ```bash
   cortextos bus update-task <original_task_id> blocked
   cortextos bus log-event task task_blocked info --meta '{"task_id":"<id>","blocked_by":"<reason>","auto_rotated_to":"<worker-name>"}'
   ```

4. **Track both** — your main session monitors the blocker's resolution (inbox messages, approval webhooks, etc.); the worker drives forward progress on the backlog task in parallel.

5. **When the blocker clears**, terminate or finish the worker, resume the original task. If the worker is still mid-flight, let it complete first, then resume original.

### Hard rules

- NEVER mark a task blocked without auto-rotating to the next backlog task first. The fleet idling on blockers is not acceptable.
- NEVER idle the main session waiting on a blocker — the daemon counts idle sessions as low utilization.
- If the backlog is genuinely empty (zero pending tasks across all queues + zero open goals), surface to the orchestrator via `cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal 'Backlog empty after blocker on task <id>; standing by for dispatch'` — do not silently idle.
- If the blocker is short (<5 min, e.g. a CI run nearly complete), it is fine to wait rather than rotate. The rotate threshold is "this will block me >5 minutes."

### Enforcement

A post_tool hook will enforce this (codex/dev tracked separately): any `bus update-task <id> blocked` call without a preceding `spawn-worker` or `bus update-task <other_id> in_progress` within the same session-tick will trigger an auto-warning to the agent. This is an architectural backstop; the protocol above is the primary behavioral expectation.

---

## Scaling Rules

| Workers | Risk | Notes |
|---------|------|-------|
| 1-2 | Low | Safe for most tasks |
| 3-4 | Medium | Ensure zero file overlap |
| 5+ | High | Resource contention, monitor closely |

**Hard rules:**
- NEVER spawn workers for overlapping file sets
- NEVER let workers modify files you or other agents are editing
- ALWAYS log spawns and completions
- Workers should NOT spawn their own workers (no worker-ception)
