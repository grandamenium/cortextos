# CortexOS Core Services

Status: Architecture scaffold only  
Runtime impact: None

This folder defines the core platform services that sit around the AI models.
It does not change Claude, agent prompts, the daemon, crons, or production runtime.

## Founding Principle

A conversation should never be the only place work exists.

- Obsidian is the source of truth for durable organizational knowledge.
- ClickUp is the source of truth for tasks and execution.
- Native systems remain authoritative for their operational records.
- The Command Center presents current state.
- Agents perform work within workspace and permission boundaries.

## Initial Priority Order

1. Chronicle
2. Workspace Registry
3. Obsidian Writer
4. ClickUp Sync
5. Domain Event Bus
6. Permission Manager
7. Notification Service
8. Session Manager

## Safety Rule

No service in this scaffold may be connected to production until:
1. Its input/output contract is approved.
2. It has workspace-scoped permission checks.
3. It has idempotency and audit logging.
4. It has a rollback or disable path.
5. It has been tested against a non-production workspace.

## Relationship to Existing Code

Every service here is **proposed**; none is implemented or runtime-enabled. This section
records what already exists, so nobody assumes a scaffold is live.

| Service | Current implementation |
|---|---|
| `domain-event-bus/` | **None.** No pub/sub event distribution exists today. |
| `clickup-sync/` | `orgs/atlasos/agents/forge/scripts/clickup-task-mirror.js` — **currently paused**. |
| `permission-manager/` | **None.** No centralized permission enforcement exists today. |
| `chronicle/`, `workspace-registry/`, `obsidian-writer/`, `notification-service/`, `session-manager/` | None. |

**`bus/` at the repository root is NOT part of Core Services.** It is the live agent CLI
command surface — 51 shell scripts (`create-task.sh`, `check-inbox.sh`, `send-telegram.sh`
and similar) invoked directly by agents and scheduled jobs. Despite the name it is not an
event bus, and it is unrelated to `domain-event-bus/`.
