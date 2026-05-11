# Claude Remote Agent

Persistent 24/7 Claude Code agent controlled via Telegram. Runs via cortextos daemon with auto-restart and crash recovery.

## First Boot Check

Before anything else, check if this agent has been onboarded:
```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If `NEEDS_ONBOARDING`: read `.claude/skills/onboarding/SKILL.md` and follow its instructions. Do NOT proceed with normal operations until onboarding is complete. The user can also trigger onboarding at any time by saying "run onboarding" or "/onboarding".

If `ONBOARDED`: continue with the session start protocol below.

---

## On Session Start

See AGENTS.md for the full 15-step session start checklist. Key steps:

1. **Send boot message first**: `cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Booting up... one moment"`
2. Read all bootstrap files: IDENTITY.md, SOUL.md, GUARDRAILS.md, GOALS.md, HEARTBEAT.md, MEMORY.md, USER.md, TOOLS.md, SYSTEM.md
3. Read framework code-quality rules: `${CTX_FRAMEWORK_ROOT}/.claude/rules/code-quality.md` — universal P9-eng standards + cortextOS-specific micro-retros (class-of-trap rules surfaced from prior incidents). Re-read when starting a non-trivial coding task.
4. Read org knowledge base: `../../knowledge.md`
5. Discover available skills: `cortextos bus list-skills --format text`
6. Discover active agents: `cortextos bus list-agents`
7. **Crons are daemon-managed.** External crons auto-load from `${CTX_ROOT}/state/${CTX_AGENT_NAME}/crons.json` on daemon start; you do not need to restore them. Use `cortextos bus list-crons $CTX_AGENT_NAME` to confirm. Do NOT use `CronCreate` or `/loop` — those are session-only and won't survive restarts.
8. Check today's memory file for in-progress work
9. If resuming a task, query KB: `cortextos bus kb-query "<task topic>" --org $CTX_ORG`
10. Check inbox: `cortextos bus check-inbox`
11. Update heartbeat: `cortextos bus update-heartbeat "online"`
12. Log session start: `cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'`
13. Write session start entry to daily memory
14. Send full online status — **only AFTER crons are confirmed set**

## Working tree (shared-repo discipline)

The framework repos at `/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork` and `/Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis` are **shared working trees** — multiple agents and the user may be operating in them at any moment. Branch operations there silently corrupt other agents' uncommitted state (see `.claude/rules/code-quality/same-repo-multi-agent-checkout-contamination.md`). **Never edit, commit, or checkout feature branches in those canonical paths.** Use a per-agent worktree.

Convention: `~/cortextos-worktrees/<your-agent-name>/<branch>` (or `~/jarvis-worktrees/<your-agent-name>/<branch>`).

Workflow when starting any non-trivial code task:

```bash
# 1. Fetch from canonical (read-only ops there are fine)
cd /Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork
git fetch origin main

# 2. Create your worktree on a fresh branch off origin/main
git worktree add ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch-name> -b <branch-name> origin/main

# 3. cd in and work there for the entire feature lifecycle
cd ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch-name>
# ... edit, build, test, commit, push, PR, evaluator cycle ...

# 4. After PR is merged, clean up
cd /Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork
git worktree remove ~/cortextos-worktrees/$CTX_AGENT_NAME/<branch-name>
```

The canonical working tree is read-only for you — `git fetch`, `git pull origin main`, `git log`, `git status` against main are fine; everything else (checkout, edit, commit, push) goes through your worktree.

If your worktree dir already exists from a prior PR: `git worktree list` to inspect, `git worktree remove --force <path>` if stale. If the same branch name is taken (another agent claimed it first): pick a different name.

**Active enforcement.** A `SessionStart` hook (`cortextos bus hook-worktree-warn`) detects when you've booted with cwd inside a canonical shared tree and injects a warning into your session context immediately. It also emits a `worktree_canonical_boot_warning` event so the activity feed surfaces the boot. The standard cortextOS agent / analyst / orchestrator templates ship this entry pre-wired in `.claude/settings.json`; mirrors or forks without the wiring can add it manually. The hook is advisory — it does not block — so the discipline above is still your responsibility.

---

## Task Workflow

Every significant piece of work gets a task. See `.claude/skills/tasks/SKILL.md` for full reference.

1. **Create**: `cortextos bus create-task "<title>" --desc "<desc>"`
2. **Start**: `cortextos bus update-task <id> in_progress`
3. **Complete**: `cortextos bus complete-task <id> --result "[summary]"`
4. **Log KPI**: `cortextos bus log-event task task_completed info --meta '{"task_id":"ID"}'`

CONSEQUENCE: Tasks without creation = invisible on dashboard. Your effectiveness score will be 0%.
TARGET: Every significant piece of work (>10 minutes) = at least 1 task created.

---

## Mandatory Memory Protocol

You have THREE memory layers. All are mandatory.

### Layer 1: Daily Memory (memory/YYYY-MM-DD.md)
Write to this file:
- On every session start
- Before starting any task (WORKING ON: entry)
- After completing any task (COMPLETED: entry)
- On every heartbeat cycle
- On session end

### Layer 2: Long-Term Memory (MEMORY.md)
Update when you learn something that should persist across sessions.

CONSEQUENCE: Without daily memory, session crashes lose all context. You start from zero.
TARGET: >= 3 memory entries per session.

---

## Mandatory Event Logging

Log significant events so the Activity feed shows what's happening.

```bash
cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
cortextos bus log-event action task_completed info --meta '{"task_id":"<id>","agent":"'$CTX_AGENT_NAME'"}'
```

CONSEQUENCE: Events without logging are invisible in the Activity feed.
TARGET: >= 3 events per active session.

---

## Telegram Messages

Messages arrive in real time via the fast-checker daemon:

```
=== TELEGRAM from <name> (chat_id:<id>) ===
<text>
Reply using: cortextos bus send-telegram <chat_id> "<reply>"
```

Photos include a `local_file:` path. Callbacks include `callback_data:` and `message_id:`. Process all immediately and reply using the command shown.

**Telegram formatting:** Uses Telegram's regular Markdown (not MarkdownV2). Do NOT escape characters like `!`, `.`, `(`, `)`, `-` with backslashes. Just write plain natural text. Only `_`, `*`, `` ` ``, and `[` have special meaning.

---

## Agent-to-Agent Messages

```
=== AGENT MESSAGE from <agent> [msg_id: <id>] ===
[FRESH-START: ...]                  ← optional dispatch hint, present only when sender set --fresh-start
<text>
Reply using: cortextos bus send-message <agent> normal '<reply>' <msg_id>
```

Always include `msg_id` as reply_to (auto-ACKs the original). Un-ACK'd messages redeliver after 5 min. For no-reply messages: `cortextos bus ack-inbox <msg_id>`

### On dispatch receipt (BL-2026-05-08-004 Phase 3)

When you receive an inbox message, decide whether to hard-restart **before** acting on it. The decision flow is the same for every inbox message; treat it as a precondition check, not an optional step.

**Step 1 — read the `[FRESH-START: ...]` annotation if present.**

The sender annotates by passing `--fresh-start` or `--no-fresh-start` to `cortextos bus send-message`. Three observable forms:

- `[FRESH-START: sender requests hard-restart before processing ...]` → `fresh_start=true` (sender wants restart)
- `[FRESH-START: explicit override — sender says do NOT hard-restart ...]` → `fresh_start=false` (sender says skip restart)
- No annotation line → no hint; you run the heuristic in Step 3.

**Step 2 — check the cooldown (only if the decision might be a restart).**

If the annotation is `false` (explicit no), skip cooldown check entirely — there will be no restart. Otherwise (annotation `true` or absent), query the per-agent cooldown so the heuristic path doesn't thrash on rapid task transitions:

```bash
cortextos bus check-fresh-restart-cooldown
# JSON: {last_at, age_seconds, on_cooldown, cooldown_seconds_remaining, cooldown_seconds_total}
```

Default window 30 minutes (`DEFAULT_FRESH_RESTART_COOLDOWN_SECONDS = 1800`). On cooldown means a recent fresh-restart already covered the transition; a second one within the window is wasted churn.

**Step 3 — apply the decision matrix.**

| Hint from annotation | Heuristic verdict | On cooldown? | Action |
|---|---|---|---|
| `true` (explicit yes) | (skip — explicit wins) | no | hard-restart with `--fresh-start`, then process |
| `true` (explicit yes) | (skip — explicit wins) | yes | hard-restart with `--fresh-start` anyway (explicit user intent overrides cooldown per spec § Component 6 "unless explicit"); the marker is overwritten with the new timestamp |
| `false` (explicit no) | (skip — explicit wins) | (skip) | process in current session |
| absent | UNRELATED | no | hard-restart with `--fresh-start`, then process |
| absent | UNRELATED | yes | log skip event, process in current session |
| absent | RELATED | (skip) | process in current session |

> **Why row 2 bypasses cooldown:** the cooldown is a guard against the AGENT'S heuristic looping on ambiguous transitions. When the SENDER passes `--fresh-start` explicitly, that intent overrides the heuristic guard — log it and proceed. The cooldown still protects rows 4–5 (heuristic-driven restarts) where the agent's own judgment could mis-fire repeatedly.

**Self-detection heuristic (Step 3 row "absent"):**

You read the dispatch text and compare to your current state. UNRELATED if any:

- Different target repo (last work was repo A, dispatch references repo B)
- Different working surface (last was backend code, dispatch is dashboard UI)
- Different code area, low file-path overlap with your last commits / spec / current branch

NOT-UNRELATED protections (false-positive guards — when in doubt, treat as RELATED):

- Same-branch continuation (between phases of the same feature; spec § Component 6 "Hard-restart between Protocol A phase 1 → 2")
- Quick clarification round-trip with the user (not a new task)
- Subagent dispatch (already isolated — no need to reset main session)
- Mid-subagent: if a subagent is currently in-flight, wait for it to return before deciding (spec § Component 6 "Engineer mid-subagent at threshold>90%")

When the call is genuinely ambiguous, default to RELATED. The user can dispatch with `--fresh-start` if they want explicit reset.

**Step 4 — execute.**

If the decision is "hard-restart with `--fresh-start`":

```bash
# Safety: commit any in-flight work first (durable memory carries forward; live conversation does not)
git add -A && git commit -m "wip: pre-fresh-restart safety commit" || true

# Restart — writes .force-fresh + .last-fresh-restart-at marker; daemon respawns the session
cortextos bus hard-restart --fresh-start --reason "fresh-start for <new-task-summary>"
```

If the decision is "log skip and process in current session":

```bash
cortextos bus log-event action fresh_restart_skipped info \
  --meta '{"reason":"<on_cooldown|explicit_override|heuristic_related>","dispatch_msg_id":"<id>","cooldown_seconds_remaining":<N>}'
# then proceed with normal dispatch processing — read the message text, do the work, reply
```

**Anti-patterns:**

- Don't hard-restart between phases of the same feature (false positive — same branch, same spec).
- Don't hard-restart in response to a clarification message in an existing thread.
- Don't hard-restart while a subagent is mid-flight; wait for it to return first (its result is context that the new session would lose).
- Don't pass `--fresh-start` to `cortextos bus hard-restart` for context-overflow restarts (FastChecker Tier-2/3 path) — those are not dispatch-driven and should not consume the cooldown window.
- Don't reload recently-discarded conversation context after a fresh-restart by re-reading old transcripts. The point of the restart is a clean session; the durable memory (MEMORY.md, daily memory, git log) IS the recovery layer.

---

## Crons

External crons are daemon-managed and live in `${CTX_ROOT}/state/${CTX_AGENT_NAME}/crons.json`. The daemon scheduler owns dispatch — you do not register or restore crons in-session.

**View:** `cortextos bus list-crons $CTX_AGENT_NAME`
**Add:** `cortextos bus add-cron $CTX_AGENT_NAME <name> <interval-or-cron-expr> <prompt>`
**Remove:** `cortextos bus remove-cron $CTX_AGENT_NAME <name>`

Do NOT use `CronCreate` or `/loop` — those are session-only and evaporate on restart.

---

## Restart

**Soft** (preserves history): `cortextos bus self-restart --reason "why"`
**Hard** (fresh session): `cortextos bus hard-restart --reason "why"`

When the user asks to restart, ALWAYS ask them first: "Fresh restart or continue with conversation history?" Do NOT restart until they specify which type.

Sessions auto-restart with `--continue` every ~71 hours. On context exhaustion, notify user via Telegram then hard-restart.

---

## Spawning a New Agent

1. Ask user to create a bot with @BotFather on Telegram, send you the token
2. Ask user to message the new bot, then get chat_id:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[-1].message.chat.id'
   ```
3. Create the agent: `cortextos add-agent <name> --template agent`
4. Edit `.env` with BOT_TOKEN and CHAT_ID
5. Enable it: `cortextos start <name>`
6. **Hand off to the new agent for onboarding.** Tell the user via Telegram:
   > "Your new agent is booting up! Switch to your Telegram chat with [bot name] and send `/onboarding` to start the setup process."

---

## System Management

### Agent Lifecycle
| Action | Command |
|--------|---------|
| Add agent | `cortextos add-agent <name> --template <type>` |
| Start agent | `cortextos start <name>` |
| Stop agent | `cortextos stop <name>` |
| Check status | `cortextos status` |

### Communication
| Action | Command |
|--------|---------|
| Send Telegram | `cortextos bus send-telegram <chat_id> "<msg>"` |
| Send to agent | `cortextos bus send-message <agent> <priority> '<msg>' [reply_to]` |
| Check inbox | `cortextos bus check-inbox` |
| ACK message | `cortextos bus ack-inbox <msg_id>` |

### Logs
| Log | Path |
|-----|------|
| Activity | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/activity.log` |
| Fast-checker | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/fast-checker.log` |
| Stdout | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stdout.log` |
| Stderr | `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/stderr.log` |

### State
| File | Purpose |
|------|---------|
| `config.json` | Crons, max_session_seconds, agent config |
| `.env` | BOT_TOKEN, CHAT_ID, ALLOWED_USER |

---

## Skills

- **.claude/skills/comms/** - Message handling reference (Telegram + agent inbox formats)
- **.claude/skills/cron-management/** - Cron setup, persistence, and troubleshooting
- **.claude/skills/tasks/** - Task creation, lifecycle, and KPI logging

---

## Knowledge Base (RAG)

Query and ingest org documents using natural language. See `.claude/skills/knowledge-base/SKILL.md` for full reference.
