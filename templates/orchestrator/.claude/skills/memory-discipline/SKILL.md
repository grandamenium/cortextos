---
name: memory-discipline
description: Two-layer memory protocol — daily memory and long-term MEMORY.md. Trigger on session start, before/after every task, on every heartbeat, before/after KB ingest, and on session end.
---

# Memory discipline

You have **two** memory layers. Both are mandatory.

## Layer 1: Daily memory (`memory/YYYY-MM-DD.md`)

Append to this file:

- On every **session start** (write the boot-time state: branch, focus, in-flight work)
- **Before starting** any task — `WORKING ON: <title>` entry
- **After completing** any task — `COMPLETED: <title>` + 1-line outcome
- On every **heartbeat cycle**
- On **session end**

The file is the agent's own continuity record across restarts. The daemon and orchestrator do NOT preserve session conversation; this file does.

## Layer 2: Long-term memory (`MEMORY.md`)

Update when you learn something that should **persist across sessions** — a fleet rule, a tool quirk, a stable preference, a piece of org knowledge an agent re-discovers monthly. Indexed in `MEMORY.md`; individual entries can be separate files referenced from the index.

**What NOT to save in MEMORY.md** (it would all bloat startup context):

- Code patterns / architecture / file paths — derivable from `git log`, `grep`
- Recent commits or who-changed-what — git history is authoritative
- Debugging recipes — the fix is in the code; commit message has the context
- Ephemeral state — current task, in-flight work (those belong in daily memory)
- Anything already in CLAUDE.md or skills

## Targets

- **>= 3 daily-memory entries** per active session — write entries on session start, on every task transition, and at session end.
- **MEMORY.md update** on every learning worth re-reading next session (typically 0-2 per session).

## On startup

1. Read today's `memory/YYYY-MM-DD.md`. If it doesn't exist, create it with a session-start entry.
2. Scan `MEMORY.md` index for entries relevant to whatever the user / orchestrator asks first.
3. Re-read the underlying memory file before *acting on it* — entries can be stale; verify against current code/state.

## On KB ingest

Daily memory is the agent's own log; `MEMORY.md` is durable agent state; the **knowledge base** is the org's shared memory. If you research a topic and find the org needs the result later, ingest into KB after — see `.claude/skills/knowledge-base/SKILL.md`. Don't dump research transcripts into MEMORY.md; that's KB territory.

## Failure modes

- **Daily memory absent or sparse** — on session crash, the next session starts from zero. Symptom: agent re-asks questions it already had answers to.
- **MEMORY.md polluted with ephemeral state** — startup context grows; the same context the cost-optimization plan tries to shrink.
- **Stale MEMORY.md entries acted on without verification** — a memory naming a function/file is a claim that it existed at write time, not now. Before recommending or acting on it, verify the named symbol/file still exists via grep / a quick read.
