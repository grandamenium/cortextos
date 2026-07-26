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

AGENTS.md is the source of truth for the full session-start checklist. This file only keeps Claude-runtime-specific routing and restart reminders.

Full details: read AGENTS.md §On Session Start.

---

## Task-Type Routing

Before acting on any incoming task, classify it:

**TRIVIAL** — <10 line config tweak, typo, status read, test run
→ Handle inline in this session.

**RESEARCH / TRIAGE** — log analysis, web search, audit, data extraction
→ Delegate via Agent tool (Haiku): `knox` (research) | `trace` (debugging) | `sentinel` (compliance).

**PLANNING / ARCHITECTURE** — new feature spec, refactor plan, multi-file design, schema migration
→ Delegate via Agent tool: `architect` (Opus).
→ Output is a written plan. Surface to Josh via Telegram for approval before any implementation.

**CODE IMPLEMENTATION** — actual code writing, refactor execution, bug fix commits
→ NOT in your scope. Route via frank2:
  `cortextos bus send-message frank2 normal 'Code task — dispatch to [larry|auditos2]: <description>'`
→ Repo agents (larry, auditos2) own Codex handoffs via the `codex-handoff` skill. You do not run Codex yourself.

**ESCALATION / CROSS-AGENT COORDINATION** — anything touching another agent's domain
→ Route via frank2: `cortextos bus send-message frank2 normal '<issue>'`.

Why this routing exists: Opus is expensive and reserved for planning/architecture. Sonnet handles daily ops. Codex handles code implementation (with Claude-Sonnet review). Keep your model tier focused on its strength.

---

## Task Workflow

Full details: read AGENTS.md §Task Workflow.

---

## Mandatory Memory Protocol

Full details: read AGENTS.md §Memory Protocol.

---

## Mandatory Event Logging

Full details: read AGENTS.md §Mandatory Event Logging.

---

## Telegram Messages

Full details: read AGENTS.md §Telegram Messages.

---

## Agent-to-Agent Messages

Full details: read AGENTS.md §Agent-to-Agent Messages.

---

## Crons

Full details: read AGENTS.md §Crons. Crons are daemon-managed; do not recreate them in-session.

---

## Restart

**Soft** (preserves history): `cortextos bus self-restart --reason "why"`
**Hard** (fresh session): `cortextos bus hard-restart --reason "why"`

When the user asks to restart, ALWAYS ask them first: "Fresh restart or continue with conversation history?" Do NOT restart until they specify which type.

Sessions auto-restart with `--continue` every ~71 hours. On context exhaustion, follow the AGENTS.md handoff + restart contract.

---

## Spawning a New Agent

Full details: read AGENTS.md §System Management and the `agent-management` skill before creating or enabling agents.

---

## System Management

Full details: read AGENTS.md §System Management.

---

## Skills

Full details: read AGENTS.md §Skills.

---

## Knowledge Base (RAG)

Full details: read AGENTS.md §Memory Protocol / Layer 3. Query before every task and ingest significant outputs.
