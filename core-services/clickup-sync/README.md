# Clickup Sync

Status: Proposed  
Runtime enabled: No

## Purpose

Create and update work items in ClickUp with owners, priorities, due dates, and dependencies.

## Definition of Done

- Input and output schemas approved
- Workspace authorization enforced
- Idempotency implemented
- Audit trail implemented
- Failure behavior documented
- Non-production test completed
- Explicit production approval recorded

## Current implementation

This scaffold is the **target contract** for code that already exists.

**Current implementation:** `orgs/atlasos/agents/forge/scripts/clickup-task-mirror.js`
**Status: PAUSED** (Windows scheduled task `cortextos-clickup-task-mirror`, disabled
2026-07-27). It ran every 30 minutes, writing local tasks to ClickUp via
`POST /list/{listId}/task` and pushing status via `PUT /task/{clickup_id}`.

### Contract compliance as of 2026-07-27

| Contract rule | Current implementation |
|---|---|
| `must_not: Create duplicate tasks` | **Met.** Deterministic id mapping in `orgs/state/forge/clickup-mirror-state.json` — 116 tasks mapped, zero duplicate `clickup_id` values. |
| `must_not: Invent owners or due dates` | **At risk.** See below. |

### Open issue to resolve before reactivation

The reverse path, `cortextos bus clickup-pull` (a separate, currently disabled cron),
matches records by **lowercased title** rather than by id, and overwrites local `due_date`
and `priority` **with no timestamp comparison**. A newer local edit therefore loses to an
older remote value, and a task renamed in ClickUp silently stops matching altogether.

Neither behaviour is an invented date, but both let a stale remote value silently replace a
correct local one. **Resolve before this contract can be considered met**, and before the
mirror is reactivated. Note also that the authoritative source of truth between the local
store and ClickUp is not declared in any configuration file — see `TASK-TRACKING-DESIGN.md`.
