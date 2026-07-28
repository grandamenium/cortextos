# Domain Event Bus

Status: Proposed  
Runtime enabled: No

## Purpose

Publish structured events so Atlas, the Command Center, and authorized services receive bounded updates.

## Definition of Done

- Input and output schemas approved
- Workspace authorization enforced
- Idempotency implemented
- Audit trail implemented
- Failure behavior documented
- Non-production test completed
- Explicit production approval recorded

## Not to be confused with `bus/`

The repository root contains a directory named **`bus/`**. It is unrelated to this service.

- `bus/` is the **live agent CLI command surface** — 51 shell scripts such as
  `create-task.sh`, `check-inbox.sh`, `send-telegram.sh`, invoked directly by agents and
  scheduled jobs. It is imperative and synchronous: a script runs, and returns.
- `domain-event-bus/` is a **proposed** asynchronous pub/sub service: publish a
  `domain_event`, subscribers receive `subscriber_delivery` plus an `audit_record`.

These are different layers, not two versions of one thing. **This scaffold does not
supersede, replace, or govern `bus/`.** `bus/` remains authoritative for agent CLI
commands. The name collision is historical — `bus/` predates this scaffold and is misnamed
for what it does, but renaming it would touch live scripts referenced by agents and crons.
