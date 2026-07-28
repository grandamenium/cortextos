# Permission Manager

Status: Proposed  
Runtime enabled: No

## Purpose

Enforce workspace, role, system, record, and action-level access controls.

## Definition of Done

- Input and output schemas approved
- Workspace authorization enforced
- Idempotency implemented
- Audit trail implemented
- Failure behavior documented
- Non-production test completed
- Explicit production approval recorded

## Why this service exists — measured gap

**No centralized permission enforcement exists in CortexOS today.** This is not a
refinement of an existing control; the control is absent.

Measured 2026-07-27. `dist/daemon.js`, `buildClaudeArgs()`, lines 426–427 — the argument
builder used to launch **every** agent:

```js
args.push("--dangerously-skip-permissions");
args.push("--permission-mode", "bypassPermissions");
```

Consequences, recorded in `GOVERNANCE-DECISION.md`:

- Every agent and every scheduled job runs with **permissions bypassed**.
- No per-agent tool allowlist is applied at spawn.
- **No resolved capability set is logged**, so there is no detection either — the empty
  state cannot be proven after the fact.
- `--append-system-prompt` injects `local/*.md` content, so sessions inherit context
  represented in no allowlist.

Any agent profile declaring "no tools" is therefore **prompt language, not a control**. A
capability gate built on such a profile fails: this was established when the continuity
review's empty-tool gate failed affirmatively rather than for want of evidence.

This service is the Tier-0 enforcement layer that closes the gap. Until it exists, treat
every documented authority level, approval threshold, and prohibited action as advisory.
