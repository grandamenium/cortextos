# CHANGELOG

## [0.2.0] — 2026-05-04 — External Persistent Crons

Crons move from session-local (`/loop`, `CronCreate`) to daemon-managed `crons.json` files under `${CTX_ROOT}/state/{agent}/`. Auto-migrates from existing `config.json` on first daemon boot. Fully backward-compatible additive feature.

### Phase 5.4 — Race Hardening & Workspace Teaching

- **iter 9 fix**: `lastGoodSchedule` fallback now distinguishes a legitimately-empty `crons.json` from a corrupt parse failure, so emptying a file no longer keeps stale crons firing.
- **iter 10 fix**: persist `last_fire_attempted_at` to prevent crash-mid-fire double-fire on next daemon restart.
- **iter 11 fix**: defer scheduler reload while a fire is in flight, and lazy-create the scheduler when a reload hits a start-window gap (no missed first fire after re-enable).
- **iter 12 fix**: serialize bus `add-cron` / `update-cron` / `remove-cron` operations to fix lost-update race when concurrent edits land on the same agent.
- **Race test pins**: dedicated regression tests for iter 9 / 10 / 12 race conditions plus remove-cron mid-fire (no double-fire).
- **`bus upgrade-cron-teaching` CLI scanner**: scans CLAUDE/AGENTS/ONBOARDING/SKILL files for stale `CronCreate` / `/loop` references and reports advisories. Pure advisory by default; `--apply` for safe substitutions.
- **`migrate-crons` cron-teaching upgrade banner**: daemon emits one advisory line per agent on first migration, drops `.cron-teaching-checked` marker (idempotent).

### Phase 5.3 — Failure Mode & Recovery

- **`lastGoodSchedule` snapshot in `CronScheduler`**: if a `reload()` produces an empty schedule (transient corruption), the scheduler retains the last successfully loaded schedule in memory and keeps firing until the file is repaired. In-memory only — does not survive daemon restarts.
- **`.bak` rotation in `writeCrons`**: `atomicWriteSync` now accepts a `keepBak` flag; `writeCrons` passes `keepBak: true` so every atomic write preserves the previous `crons.json` as `crons.json.bak`.
- **`.bak` fallback in `readCrons`**: on primary-file parse failure, `readCrons` automatically retries with `crons.json.bak`. Single-step automatic recovery without operator intervention.
- **ENOSPC/EACCES catch in `tick()`**: disk-full and read-only-filesystem errors when persisting `last_fired_at` are caught and logged; the in-memory schedule is preserved and crons continue firing.

### Phase 4 — Cron Dashboard

- **`/workflows` fleet overview page**: health summary panel + paginated read-only cron table across all agents, with agent and name search filters.
- **`/workflows/health` dedicated health page**: gap detection, health-status breakdown, and per-cron health rows for the entire fleet.
- **`/workflows/[agent]/[name]` cron detail page**: edit form (schedule, prompt, enabled, description), execution history viewer, and test-fire button.
- **`/workflows/new` page**: create a new cron for any enabled agent.
- **POST/PATCH/DELETE API routes** at `/api/workflows/crons/...`: routed through IPC (`handleAddCron`, `handleUpdateCron`, `handleRemoveCron`) with full input validation and scheduler reload after each mutation.
- **Test-fire button** (`/api/workflows/crons/[agent]/[name]/fire`): confirmation dialog, inline pending state, 30-second cooldown enforced client-side and server-side (IPC `handleFireCron`). Auto-refreshes execution history 6s after success.
- **`manualFireDisabled` flag**: setting this field on a cron definition disables the test-fire button (HTTP 403) for that cron. Useful for crons that must only fire on schedule.
- **Execution log pagination + filter + export**: history viewer supports status filter (All/Success/Failure), "Older"/"Newer" pagination with total count, and CSV/JSON export via dedicated executions API route.
- **Fleet health caching**: `computeFleetHealth` caches results for 30 seconds; cache is invalidated after any mutation or manual fire.
- **IPC commands**: `add-cron`, `update-cron`, `remove-cron`, `fire-cron`, `fleet-health`, `list-cron-executions` added to `IPCServer.handleRequest`.

### Phase 1–3 — External Persistent Cron Engine

- Crons migrated from session-local (`/loop` / `CronCreate`) to daemon-managed `crons.json` files under `${CTX_ROOT}/state/{agent}/`.
- `CronScheduler` with 30-second tick, 5-field cron expression parser, interval shorthand support, catch-up-once policy, and 3-attempt exponential backoff (1s/4s/16s).
- `readCrons` / `writeCrons` / `addCron` / `updateCron` / `removeCron` / `getCronByName` in `src/bus/crons.ts`.
- Auto-migration from `config.json` on first daemon boot per agent (`.crons-migrated` marker).
- Execution log (JSONL) with `fired` / `retried` / `failed` status entries.
- IPC `reload-crons`, `list-all-crons` commands.

---

## [0.1.1] — 2026-03-30

### Improvements

- **`/api/kb/search` result fields**: Added `filename`, `chunk_index`, `total_chunks`, and `content_full_length` to the KB search response. These fields come from mmrag.py's per-result metadata and are useful for UI display (show basename, chunk position within a document). `agent_name` and `org` now pull from the top-level JSON envelope when available rather than falling back to the request parameters.

- **`max_crashes_per_day` config field**: Added to `AgentConfig` type and all three agent templates (`config.json`). Default raised from 3 to 10 — the previous default halted agents after three transient crashes, which was too aggressive for production. Agents in high-activity environments can set a custom limit.

- **README — Agent Configuration section**: New section documenting all `config.json` fields with types, defaults, and descriptions. Includes cron format reference.

---

## [0.1.0] — 2026-03-30

### cortextOS Node.js — Initial Release

Complete TypeScript/Node.js implementation of the cortextOS agent framework. Full feature parity with the bash reference implementation. 307 unit and integration tests, 0 failures. npm-ready.

---

## What is cortextOS

cortextOS is a persistent 24/7 multi-agent framework built on Claude Code. Agents run as PM2-managed PTY processes, communicate over a file-based message bus, manage tasks, log analytics events, and are controlled via Telegram. This Node.js package ships the entire framework as a single `npm install` with a unified `cortextos` CLI.

---

## Core Features Shipped

### Message Bus

File-based inter-agent messaging with strict format parity with the bash reference implementation.

- **Priority queue**: `urgent > high > normal > low`. `checkInbox()` always returns messages sorted by priority.
- **Inbox lifecycle**: `send → inbox → inflight (on read) → processed (on ACK)`. Three-directory atomic flow.
- **Filename convention**: `{pnum}-{epochMs}-from-{sender}-{rand5}.json` where `pnum` encodes priority (0=urgent, 1=high, 2=normal, 3=low) for filesystem-native sort ordering.
- **Message ID format**: `{epochMs}-{from}-{rand5}` — globally unique, sortable, human-readable.
- **reply_to field**: Present on every message (null if no reply). Auto-ACKs the original on bus reply.
- **Undelivered redelivery**: Un-ACK'd messages in inflight redeliver after 5 minutes (daemon-level).
- **Urgent signal**: `notifyAgent()` writes `.urgent-signal` to state dir AND sends a bus message for persistence.

### Task Management

17-field task format with full lifecycle tracking.

- **Fields**: `id, title, description, type, needs_approval, status, assigned_to, created_by, org, priority, project, kpi_key, created_at, updated_at, completed_at, due_date, archived`
- **Status states**: `pending → in_progress → completed` (plus `blocked`, `cancelled`)
- **Task ID format**: `task_{epochMs}_{rand3}` — sortable, collision-resistant
- **`createTask()`**: Creates with all 17 fields, atomic write to `orgs/{org}/tasks/{id}.json`
- **`updateTask()`**: Updates status and `updated_at`, preserves all other fields
- **`completeTask()`**: Sets `status: completed`, `completed_at`, and `result` summary
- **`listTasks()`**: Scans task directory, excludes archived, supports `{ agent, status, org }` filters
- **`checkStaleTasks()`**: Identifies in-progress tasks untouched >2h, pending tasks unstarted >24h, and overdue tasks past `due_date`
- **`archiveTasks()`**: Moves completed tasks older than 7 days to `tasks/archive/`, sets `archived: true`. Supports `dry_run` mode.
- **`checkHumanTasks()`**: Finds tasks assigned to `human` or `user` that are stale (>24h pending, >2h in-progress)
- **Blocked task flow**: `update-task blocked "reason" <blocker_id>` — records `blocked_by` field, auto-sends unblock message when blocker completes

### Event Logging (Analytics)

JSONL-based event stream for dashboard Activity feed and analytics aggregation.

- **`logEvent()`**: Appends to `orgs/{org}/analytics/events/{agent}/{YYYY-MM-DD}.jsonl`
- **Event schema**: `{ id, timestamp, agent, org, category, event, level, data }`
- **Categories**: `action`, `task`, `milestone`, `error`, `system`
- **Levels**: `info`, `warning`, `error`
- **`getEvents()`**: Reads JSONL files with date-range filtering and agent/org filtering
- **`aggregateMetrics()`**: Aggregates events into task counts, session counts, KPI scores per agent

### Heartbeat System

Periodic liveness signals with context for dashboard status cards.

- **`updateHeartbeat()`**: Atomic write to `heartbeats/{agent}.json`
- **Heartbeat schema**: `{ agent, org, timestamp, last_heartbeat, status, current_task, mode, loop_interval }`
- **`readAllHeartbeats()`**: Scans heartbeats directory, returns all agents' current status
- **Running detection**: Heartbeat age <60s → agent considered `running: true`
- **`readHeartbeat()`**: Single agent read, returns null if file missing

### Approval Workflow

Pre-action approval gate for external or sensitive operations.

- **`createApproval()`**: Writes to `orgs/{org}/approvals/pending/{id}.json`
- **Approval ID format**: `approval_{epochMs}_{rand6}`
- **Fields**: `id, title, category, context, status, requesting_agent, org, created_at, resolved_at, decision_note`
- **Categories**: `external-comms`, `financial`, `deployment`, `data-deletion`, `other`
- **`updateApproval()`**: Moves from `pending/` to `resolved/` on approve/reject
- **Status values**: `pending`, `approved`, `rejected`
- **Blocked task integration**: Approval ID stored in task's `blocked_by` field; auto-unblocks on decision

### Knowledge Base (RAG / mmrag)

Semantic memory via the multimodal-rag Python library (mmrag.py).

- **`queryKnowledgeBase()`**: Runs mmrag.py query, returns `{ results: [{content, score, source}], total }`
- **`ingestKnowledgeBase()`**: Indexes documents from a path into a named collection
- **`listCollections()`**: Lists all ChromaDB collections with document counts
- **Collections**: `shared-{org}` (org-wide, all agents) and `agent-{name}` (private per-agent)
- **Environment setup**: Auto-sets `MMRAG_DIR`, `MMRAG_CHROMADB_DIR`, `MMRAG_CONFIG` for every subprocess call
- **Instance isolation**: KB root derived from `CTX_ROOT` basename — each cortextOS instance has its own KB
- **Auto-init**: `kb-ingest.sh` auto-calls `kb-setup.sh` if `config.json` is missing
- **`kb-setup.sh`**: Creates venv, installs mmrag deps, writes default `config.json`

### Experiment System (Theta Wave)

Structured hypothesis-test-evaluate loop for autonomous agent experimentation.

- **`createExperiment()`**: Creates experiment file with `id, metric, hypothesis, status, created_at`
- **`runExperiment()`**: Executes experiment, records `started_at`, transitions to `running`
- **`evaluateExperiment()`**: Records outcome, transitions to `completed` or `failed`
- **`manageCycle()`**: Manages full experiment cycle with pass/fail/continue logic
- **`loadExperimentConfig()`**: Reads `experiments/config.json` for `approval_required` and other settings
- **Approval gate**: If `experiments/config.json` has `approval_required: true`, `create-experiment` CLI auto-creates an approval and blocks until approved

### Agent Discovery

- **`listAgents()`**: Reads `config/enabled-agents.json` as authoritative source. Falls back to `orgs/` directory scan only when `CTX_FRAMEWORK_ROOT` is explicitly set in environment.
- **`buildAgentInfo()`**: Enriches agent entries with heartbeat data (status, current_task, mode), role from `IDENTITY.md`, enabled status from `config.json`
- **`notifyAgent()`**: Writes urgent signal file + sends bus message

### Catalog / Skills Marketplace

- **`browseCatalog()`**: Lists available skills from the community catalog
- **`installCommunityItem()`**: Installs a skill into an agent's skills directory
- **`prepareSubmission()`**: Packages a skill for community submission
- **`submitCommunityItem()`**: Submits a skill package to the catalog

### System / Lifecycle

- **`postActivity()`**: Sends activity update to Telegram (reads BOT_TOKEN/CHAT_ID from `.env`)
- **`selfRestart()`**: Writes `.restart-planned` marker, triggers soft restart (preserves conversation history via `--continue`)
- **`hardRestart()`**: Writes `.force-fresh` + `.restart-planned` markers, triggers fresh session
- **`uninstall()`**: Stops PM2, removes `enabled-agents.json`. With `--keep-state`: preserves CTX_ROOT. Without: full removal.

---

## CLI Reference (`cortextos`)

### Agent Management

| Command | Description |
|---------|-------------|
| `cortextos init` | Initialize a new cortextOS instance |
| `cortextos add-agent <name> --template <type>` | Create a new agent from template |
| `cortextos enable <name>` | Enable an agent (adds to enabled-agents.json) |
| `cortextos start <name>` | Start an agent (via PM2) |
| `cortextos stop <name>` | Stop an agent (via PM2) |
| `cortextos status` | Show all agents' status, heartbeat age, current task |
| `cortextos list-agents [--org <org>]` | List agents with heartbeat/role info |
| `cortextos list-skills` | List available skills |
| `cortextos install` | Install/configure cortextOS on this machine |
| `cortextos uninstall [--keep-state]` | Remove cortextOS |
| `cortextos doctor` | Diagnose common configuration issues |
| `cortextos dashboard` | Start the Next.js dashboard |

### Bus Subcommands (`cortextos bus <cmd>`)

#### Messaging
| Command | Description |
|---------|-------------|
| `bus send-message <to> <priority> '<text>' [reply_to]` | Send agent-to-agent message |
| `bus check-inbox` | Read and display pending inbox messages |
| `bus ack-inbox <msg_id>` | ACK a message (moves to processed) |
| `bus send-telegram <chat_id> '<text>'` | Send Telegram message |

#### Tasks
| Command | Description |
|---------|-------------|
| `bus create-task '<title>' ['<desc>']` | Create a new task |
| `bus update-task <id> <status> ['<note>'] ['<blocker_id>']` | Update task status |
| `bus complete-task <id> ['<result>']` | Mark task complete with result summary |
| `bus list-tasks [--agent <name>] [--status <s>] [--org <o>]` | List tasks with filters |
| `bus check-stale-tasks` | Report stale in-progress, stale pending, and overdue tasks |
| `bus archive-tasks [--dry-run]` | Archive completed tasks older than 7 days |
| `bus check-human-tasks` | Find tasks assigned to human/user that need attention |

#### Events
| Command | Description |
|---------|-------------|
| `bus log-event <category> <event> <level> [json_data]` | Append event to analytics JSONL |
| `bus get-events [--agent <a>] [--days <n>]` | Read recent events |

#### Heartbeat
| Command | Description |
|---------|-------------|
| `bus update-heartbeat '<status>'` | Write heartbeat with current status |
| `bus read-all-heartbeats` | Read all agents' heartbeats |

#### Approvals
| Command | Description |
|---------|-------------|
| `bus create-approval '<title>' '<category>' '<context>'` | Create approval request |
| `bus update-approval <id> <approved\|rejected> ['<note>']` | Resolve an approval |

#### Experiments
| Command | Description |
|---------|-------------|
| `bus create-experiment '<metric>' '<hypothesis>'` | Create experiment (auto-approval if configured) |
| `bus run-experiment <id>` | Start an experiment run |
| `bus evaluate-experiment <id> <pass\|fail> ['<notes>']` | Record experiment outcome |
| `bus list-experiments [--status <s>]` | List experiments |
| `bus manage-cycle` | Run the full experiment cycle |

#### Knowledge Base
| Command | Description |
|---------|-------------|
| `bus kb-query '<question>' --org <o> [--agent <a>] [--scope <s>]` | Semantic search |
| `bus kb-ingest <path> --org <o> [--agent <a>] [--scope shared\|private]` | Index documents |
| `bus kb-collections --org <o>` | List collections with document counts |

#### System
| Command | Description |
|---------|-------------|
| `bus self-restart --reason '<why>'` | Soft restart (preserves history) |
| `bus hard-restart --reason '<why>'` | Hard restart (fresh session) |
| `bus notify-agent <target> '<message>'` | Send urgent signal to agent |

---

## Dashboard API Endpoints

All routes require `Authorization: Bearer <token>` header (except `/api/auth/*`).

### Agents

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents` | List all agents with heartbeat, role, status |
| GET | `/api/agents/[name]` | Get single agent details |
| POST | `/api/agents` | Create new agent |
| GET | `/api/agents/[name]/crons` | List agent's cron jobs |
| POST | `/api/agents/[name]/crons` | Create cron job |
| DELETE | `/api/agents/[name]/crons` | Delete cron job |
| POST | `/api/agents/[name]/lifecycle` | Start/stop/restart agent |
| GET | `/api/agents/[name]/logs` | Stream agent activity log |
| GET | `/api/agents/[name]/memory` | Read agent's memory file |
| POST | `/api/agents/[name]/typing` | Set typing indicator |

### Tasks

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/tasks` | List tasks (filters: agent, status, org, priority) |
| POST | `/api/tasks` | Create task |
| GET | `/api/tasks/[id]` | Get single task |
| PATCH | `/api/tasks/[id]` | Update task status/fields |
| DELETE | `/api/tasks/[id]` | Delete task |

### Approvals

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/approvals` | List approvals (filters: status, org) |
| POST | `/api/approvals` | Create approval |
| GET | `/api/approvals/[id]` | Get single approval |
| PATCH | `/api/approvals/[id]` | Approve or reject |

### Messages

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/messages/send` | Send message to agent |
| GET | `/api/messages/history/[agent]` | Get message history (inbox + processed) |
| GET | `/api/messages/stream/[agent]` | SSE stream for real-time messages |
| POST | `/api/messages/upload` | Upload image/file for message |

### Analytics

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/analytics/overview` | Aggregated metrics: tasks, events, cost, KPIs per agent |
| GET | `/api/events` | Recent activity events (filters: agent, category, days) |
| GET | `/api/events/stream` | SSE stream for real-time activity feed |

### Experiments (Theta Wave)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/experiments` | List experiments (filters: status, org) |
| POST | `/api/experiments` | Create experiment |

### Knowledge Base

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/kb/search?q=<query>&org=<org>` | Semantic search across KB collections |
| GET | `/api/kb/collections?org=<org>` | List collections with document counts |

### Skills / Catalog

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/skills` | List available skills and community catalog |

### Sync

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/sync` | Sync file-system state to SQLite (tasks, approvals, events) |

### Goals / Org

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/goals` | Read org goals from `goals.json` |
| GET | `/api/orgs` | List organizations |

### Auth / Mobile

| Method | Route | Description |
|--------|-------|-------------|
| GET/POST | `/api/auth/[...nextauth]` | NextAuth session management |
| POST | `/api/auth/mobile` | Mobile app token authentication |
| POST | `/api/notifications/register` | Register push notification token |

### Media

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/media/[...filepath]` | Serve local media files (images, logs) |

---

## Shell Wrapper Scripts (`bus/`)

All scripts delegate to `dist/cli.js bus <cmd>` after sourcing `_ctx-env.sh` for environment variables.

| Script | Bus Command |
|--------|-------------|
| `send-message.sh` | `bus send-message` |
| `check-inbox.sh` | `bus check-inbox` |
| `ack-inbox.sh` | `bus ack-inbox` |
| `send-telegram.sh` | `bus send-telegram` |
| `create-task.sh` | `bus create-task` |
| `update-task.sh` | `bus update-task` |
| `complete-task.sh` | `bus complete-task` |
| `log-event.sh` | `bus log-event` |
| `update-heartbeat.sh` | `bus update-heartbeat` |
| `read-all-heartbeats.sh` | `bus read-all-heartbeats` |
| `create-approval.sh` | `bus create-approval` |
| `update-approval.sh` | `bus update-approval` |
| `create-experiment.sh` | `bus create-experiment` |
| `run-experiment.sh` | `bus run-experiment` |
| `evaluate-experiment.sh` | `bus evaluate-experiment` |
| `list-experiments.sh` | `bus list-experiments` |
| `manage-cycle.sh` | `bus manage-cycle` |
| `kb-setup.sh` | (direct Python, no bus equivalent) |
| `kb-query.sh` | `bus kb-query` |
| `kb-ingest.sh` | `bus kb-ingest` |
| `kb-collections.sh` | `bus kb-collections` |
| `self-restart.sh` | `bus self-restart` |
| `hard-restart.sh` | `bus hard-restart` |
| `browse-catalog.sh` | `bus browse-catalog` |
| `install-community-item.sh` | `bus install-community-item` |
| `prepare-submission.sh` | `bus prepare-submission` |
| `submit-community-item.sh` | `bus submit-community-item` |

---

## Agent Templates

Three templates ship in `templates/`:

### `templates/agent/`
General-purpose persistent agent. 24/7, Telegram-controlled, task-focused.
- `CLAUDE.md` — session start protocol, task workflow, messaging format, cron setup, restart procedures
- `IDENTITY.md` — name, role, personality (fill in for each agent)
- `SOUL.md` — values and operating principles
- `GOALS.md` — current objectives and KPIs
- `HEARTBEAT.md` — heartbeat protocol and cron configuration
- `MEMORY.md` — long-term memory index
- `USER.md` — user profile (who the agent reports to)
- `TOOLS.md` — available bus commands reference
- `SYSTEM.md` — system architecture notes
- `config.json` — cron definitions, max session seconds
- `.claude/settings.json` — hooks: plan mode approval, permission requests, ask-user-question, all routed to Telegram

**Skills included**:
- `skills/tasks/` — task lifecycle, KPI logging, stale task detection
- `skills/comms/` — Telegram and agent-to-agent message formats
- `skills/cron-management/` — cron setup, persistence, troubleshooting
- `skills/agent-management/` — spawn, enable, disable, restart agents
- `skills/m2c1-worker/` — autonomous software builds via M2C1 framework
- `skills/worker-agents/` — ephemeral worker session management

### `templates/orchestrator/`
Multi-agent coordinator. Manages task assignment, morning briefings, agent health.
- All agent files plus orchestrator-specific `CLAUDE.md` with 4 crons: morning briefing, task scan, evening wrap, agent health check
- `skills/agent-management/` — full lifecycle management for subordinate agents
- `skills/m2c1-worker/` — spawn M2C1 build sessions
- `skills/worker-agents/` — manage ephemeral workers

### `templates/analyst/`
Research and analytics specialist. Reads metrics, generates reports, tracks KPIs.
- 5 crons: weekly analytics, daily KPI scan, monthly cost report, experiment review, competitive analysis
- Ecosystem config for org-wide analytics
- `skills/agent-management/` — monitor and report on agent health

---

## Test Suite

**307 tests, 0 failures, 0 skipped.**

| Suite | File | Tests | Coverage |
|-------|------|-------|---------|
| Sprint 1 — Templates | `sprint1-templates.test.ts` | 24 | All template files, config schemas, no bash $CTX_FRAMEWORK_ROOT/bus/ references |
| Sprint 2 — Lifecycle | `sprint2-lifecycle.test.ts` | 8 | Agent enable, onboarding flag, config validation |
| Sprint 3 — Experiments | `sprint3-experiments.test.ts` | 12 | Full experiment CRUD, cycle management, approval gate |
| Sprint 4 — Catalog | `sprint4-catalog.test.ts` | 8 | Browse, install, prepare, submit community items |
| Sprint 5 — Metrics | `sprint5-metrics.test.ts` | 15 | Event aggregation, cost tracking, KPI scoring |
| Sprint 6 — Fast Checker | `sprint6-fastchecker.test.ts` | 18 | Telegram polling, callback routing, AskUserQuestion TUI |
| Sprint 7 — Environment | `sprint7-environment.test.ts` | 10 | CTX_ROOT resolution, env var parsing, path isolation |
| Sprint 8 — Dashboard | `sprint8-dashboard.test.ts` | 12 | Sync, SQLite integrity, API payload validation |
| Unit — Messages | `unit/bus/message.test.ts` | 22 | Send, receive, priority sort, format parity with bash |
| Unit — Tasks | `unit/bus/task.test.ts` | 9 | Create, update, complete, list with filters |
| Unit — Task Management | `unit/bus/task-management.test.ts` | 18 | Stale detection, archive, human tasks, backdated fixtures |
| Unit — Agents | `unit/bus/agents.test.ts` | 8 | listAgents, notifyAgent, heartbeat enrichment, IDENTITY.md parsing |
| Unit — System | `unit/bus/system.test.ts` | 6 | postActivity, env parsing, token validation |
| Unit — Daemon | `unit/daemon/*.test.ts` | 24 | FastChecker, message handling, callback routing |
| Unit — Hooks | `unit/hooks/*.test.ts` | 14 | Plan mode hooks, permission hooks, ask hooks |
| Unit — Utils | `unit/utils/*.test.ts` | 12 | Path resolution, atomic write, ID generation |
| Unit — Telegram | `unit/telegram/*.test.ts` | 18 | Message formatting, photo handling, keyboard markup |
| E2E — Lifecycle | `e2e/lifecycle.test.ts` | 15 | Full round-trips: message bus, task lifecycle, multi-agent coordination, approval workflow, format parity |
| Integration | `integration/*.test.ts` | 14 | CLI integration, bus command round-trips |


## Infrastructure

### CI/CD

`.github/workflows/ci.yml` — three-job GitHub Actions pipeline:

1. **`build`**: TypeScript type check (`tsc --noEmit`) + full build (`npm run build`) + CLI smoke test (`cortextos --version`)
2. **`test`**: Vitest full suite (depends on `build` job passing)
3. **`dashboard-build`**: Next.js type check + production build

Triggers: push to `main`, `feat/*`, `fix/*` branches; all pull requests.

### Directory Structure

```
cortextos/
├── src/
│   ├── bus/          # Core bus modules (message, task, event, heartbeat, approval, experiment, knowledge-base, agents, catalog, system, metrics)
│   ├── cli/          # CLI entry points (bus.ts, dashboard.ts, doctor.ts, ecosystem.ts, enable-agent.ts, init.ts, install.ts, list-agents.ts, list-skills.ts, notify-agent.ts, start.ts, status.ts, stop.ts, uninstall.ts)
│   ├── daemon/       # FastChecker daemon (Telegram polling, message routing, callback handling)
│   ├── hooks/        # Claude Code hook handlers (plan mode, permissions, ask-user-question, crash alert)
│   ├── types/        # TypeScript type definitions
│   └── utils/        # Atomic write, path resolution, ID generation
├── bus/              # Shell wrapper scripts (delegate to dist/cli.js bus)
├── dashboard/        # Next.js 14 dashboard (App Router, TypeScript, Tailwind)
├── templates/
│   ├── agent/        # General-purpose agent template
│   ├── orchestrator/ # Multi-agent coordinator template
│   └── analyst/      # Research/analytics agent template
├── skills/           # Community skills catalog
├── tests/
│   ├── unit/         # Unit tests (bus, daemon, hooks, utils, telegram)
│   ├── e2e/          # End-to-end lifecycle tests
│   ├── integration/  # CLI integration tests
│   └── sprint1–8/    # Sprint-level feature tests
└── .github/
    └── workflows/
        └── ci.yml    # Build, test, dashboard CI pipeline
```

---

## Migration Notes (from bash cortextOS)

The Node.js implementation is **format-compatible** with the bash reference implementation. All file formats match exactly:

- Message JSON: identical field set (`id, from, to, priority, timestamp, text, reply_to`)
- Task JSON: identical 17-field schema
- Heartbeat JSON: identical field set including `last_heartbeat`, `current_task`, `mode`
- Event JSONL: identical schema
- Approval JSON: identical schema (note: `rejected` not `denied`)
- Inbox filename convention: `{pnum}-{epochMs}-from-{sender}-{rand5}.json` matches bash

**One breaking difference from earlier Node.js versions**: task status was `'done'` in pre-release builds. The canonical value is `'completed'`, matching bash and dashboard. If you have existing task files with `"status": "done"`, run:

```bash
find orgs/*/tasks -name "*.json" -exec sed -i '' 's/"status": "done"/"status": "completed"/g' {} +
```
