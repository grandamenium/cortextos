---
name: delegation-matrix
effort: low
description: "Orchestrator/agent/Codex delegation matrix. Reference this when scoping a task to determine who owns what. Covers three Codex modes: reviewer-only (default), implementer+reviewer, and no Codex."
triggers: ["who owns", "delegation", "codex or agent", "should codex", "task scoping", "who does this", "delegation matrix", "codex mode"]
---

# Delegation Matrix

> Reference when scoping any task. Dividing line: **execution-heavy → Codex (if configured as implementer). Judgment-heavy → Agent always.**

Codex is a configurable option. Pick the mode that matches your setup:

| Mode | Codex role | When to use |
|------|-----------|-------------|
| **Mode 1** (default) | Reviewer only | Out of the box — Codex reviews Agent output before PR |
| **Mode 2** | Implementer + reviewer | Codex is set up and trusted for implementation |
| **Mode 3** | Not used | No Codex in your stack — Agent handles everything |

---

## Ownership Matrix

| Work type | Orchestrator | Agent | Codex (Modes 1+2) |
|-----------|-------------|-------|-------------------|
| Requirement intake from user | **owns** | — | — |
| Task decomposition + dispatch | **owns** | consults | — |
| Briefings and status to user | **owns** | input | — |
| Architecture decisions | — | **owns** | — |
| Spec writing + acceptance criteria | — | **owns** | — |
| Security and domain modeling | — | **owns** | — |
| Ambiguous / judgment calls | routes | **owns** | — |
| PR decisions (file, scope, merge) | — | **owns** | — |
| First-pass implementation (clear spec) | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Mechanical refactors and migrations | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Repetitive multi-file edits | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Test drafting and fixture setup | — | **owns** (Modes 1+3) / delegates (Mode 2) | **owns** (Mode 2) |
| Code review before PR | — | **owns** (Mode 3) | **owns** (Modes 1+2) |

---

## Default Coding Workflow by Mode

### Mode 1 — Codex as reviewer (default, out of box)

1. **Orchestrator** receives task, dispatches to Agent
2. **Agent** implements
3. **Agent** passes output to Codex for review
4. **Agent** applies Codex feedback, opens PR

### Mode 2 — Codex as implementer + reviewer

For tasks >~20 lines or touching multiple files:

1. **Orchestrator** receives task, dispatches to Agent
2. **Agent** designs the approach, writes a tight spec (what to build, file paths, expected behavior, edge cases)
3. **Agent** calls Codex with the full spec — Codex implements
4. **Agent** reviews Codex output for correctness and architectural fit
5. **Agent** opens the PR

### Mode 3 — No Codex

1. **Orchestrator** receives task, dispatches to Agent
2. **Agent** designs and implements directly
3. **Agent** opens the PR

For **one-liners and config changes**: Agent writes directly in all modes.

---

## When to Keep Implementation with Agent (Modes 1+2)

Even in Mode 2, some work stays with the Agent:
- Correct behavior is unclear and requires judgment
- Security, auth, or trust-boundary code
- Design is still open — spec isn't settled yet
- Output shown directly to users or external systems

---

*Deployment note: replace "Orchestrator" / "Agent" with your actual agent names.*
