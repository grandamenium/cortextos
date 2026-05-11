# Claude Remote Agent

Persistent 24/7 Claude Code agent controlled via Telegram. Runs via cortextos daemon with auto-restart and crash recovery.

## First Boot Check

Before anything else, check if this agent has been onboarded:

```bash
[[ -f "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded" ]] && echo "ONBOARDED" || echo "NEEDS_ONBOARDING"
```

If `NEEDS_ONBOARDING`: read `.claude/skills/onboarding/SKILL.md` and follow it end-to-end before normal operations. The user can also trigger ONBOARDING at any time with "/onboarding".

## Session Start

Read these on every boot, in order:

1. IDENTITY.md, SOUL.md, GOALS.md, GUARDRAILS.md, HEARTBEAT.md, MEMORY.md, USER.md, SYSTEM.md
2. Framework code-quality rules: `${CTX_FRAMEWORK_ROOT}/.claude/rules/code-quality.md` (re-read at the start of any non-trivial coding task)
3. Org knowledge: `../../knowledge.md`
4. Today's session memory: `memory/$(date -u +%Y-%m-%d).md`

Then:

```bash
cortextos bus list-skills --format text   # discover available skills
cortextos bus list-agents                  # discover active peers
cortextos bus list-crons $CTX_AGENT_NAME   # confirm crons are loaded (daemon-owned)
cortextos bus check-inbox                   # sweep for un-ACK'd messages
cortextos bus update-heartbeat "online"
cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "online — ready"
```

Crons are daemon-managed — do NOT call `CronCreate` / `/loop` for persistent crons (session-only, won't survive restart). See `.claude/skills/cron-management/SKILL.md`.

## Working tree (shared-repo discipline)

The framework canonical repos are shared working trees — multiple agents may be operating in them simultaneously. **Never edit, commit, or checkout feature branches in the canonical paths.** Use a per-agent worktree at `~/cortextos-worktrees/$CTX_AGENT_NAME/<branch>` (or `~/jarvis-worktrees/...`). Full protocol: `.claude/skills/worktree-discipline/SKILL.md`.

## Task workflow

See `.claude/skills/tasks/SKILL.md`. Every piece of work >10 min gets a task: create → in_progress → complete → log event. Untracked work is invisible on the dashboard.

## Memory protocol

Three layers, all mandatory. Full reference: `.claude/skills/memory-discipline/SKILL.md`.

- **memory/YYYY-MM-DD.md** — write WORKING ON / COMPLETED on every task transition + every heartbeat
- **MEMORY.md** — long-term learnings (cross-session)
- **Knowledge base** — auto-indexed from MEMORY.md every heartbeat

Target: ≥3 memory entries per session.

## Event logging

See `templates/EVENT_LOGGING_PROTOCOL.md` and `.claude/skills/event-logging/SKILL.md`.

```bash
cortextos bus log-event action <event_name> info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

Target: ≥3 events per active session.

## Telegram + agent comms

Messages arrive live via the fast-checker daemon. Reply formats and Markdown rules: `.claude/skills/comms/SKILL.md`.

```
=== TELEGRAM from <name> (chat_id:<id>) ===
<text>
Reply: cortextos bus send-telegram <chat_id> "<reply>"
```

```
=== AGENT MESSAGE from <agent> [msg_id: <id>] ===
[FRESH-START: ...]                  ← optional dispatch hint
<text>
Reply: cortextos bus send-message <agent> normal '<reply>' <msg_id>
```

Always include `msg_id` as reply_to (auto-ACKs). Un-ACK'd messages re-deliver after 5 min. For no-reply: `cortextos bus ack-inbox <msg_id>`.

On any inbox message, run the fresh-restart decision flow **before** acting: `.claude/skills/dispatch-protocol/SKILL.md`.

## Restart

- **Soft** (preserves history): `cortextos bus self-restart --reason "why"`
- **Hard** (fresh session): `cortextos bus hard-restart --reason "why"`

When the user asks to restart, always ask: "Fresh restart or continue with conversation history?" Don't restart until they specify.

## Per-task Opus escalation (engineer / fullstack)

Default model is Sonnet 4.6 @ 200K — covers the median session. For complex multi-phase work (architectural decisions, multi-step refactors, ambiguous-spec resolution), the **operator** starts that task on Opus with a per-task override:

```bash
cortextos start $CTX_AGENT_NAME --model opus
```

The agent does NOT escalate itself. Heuristic auto-escalation (Agent calls >5 → auto-respawn on Opus) is Phase 2 work — requires FastChecker change. Today's path is operator-triggered.

## Token & context efficiency

- **Batch Bash calls.** `git status && git log -5 && git diff --stat` in one call — three sequential turns each pay full cache_read.
- **`/compact` cadence.** At phase boundary with context yellow+, ask operator for `/compact`. Canned prompts: `.claude/rules/code-quality/compact-instructions.md`. Agents cannot invoke `/compact` themselves — at red, fall back to `cortextos bus hard-restart`.
- **Prefer CLI over MCP.** Use `gh`, `aws`, `gcloud`, `bun` directly — fewer per-tool listing tokens.
- **Cache hygiene.** Don't modify tool definitions or system messages mid-session — invalidates the cache prefix.

## Bus CLI reference

Full reference: `docs_sb/guides/bus-cli-reference.md`. Most-used:

| Action | Command |
|--------|---------|
| Send Telegram | `cortextos bus send-telegram <chat_id> "<msg>"` |
| Send to agent | `cortextos bus send-message <agent> <priority> '<msg>' [reply_to]` |
| Check inbox | `cortextos bus check-inbox` / `ack-inbox <id>` |
| Create / update task | `cortextos bus create-task` / `update-task` / `complete-task` |
| Log event | `cortextos bus log-event <category> <event> <severity>` |
| Update heartbeat | `cortextos bus update-heartbeat "<status>"` |
| List skills / agents / crons | `cortextos bus list-skills` / `list-agents` / `list-crons` |
| Cron management | `cortextos bus add-cron` / `update-cron` / `remove-cron` |

## Skills index

Available under `.claude/skills/`. List live with `cortextos bus list-skills`. Always-relevant: `comms`, `tasks`, `memory-discipline`, `dispatch-protocol`, `worktree-discipline`, `event-logging`, `cron-management`, `guardrails-reference`, `onboarding`.
