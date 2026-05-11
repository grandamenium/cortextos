---
domain: [llm, context-management, agent-orchestration]
applies_to: cortextos coding agents, BL-004 context-discipline
severity: should-know
source_incident: 2026-05-08T20:36Z — fullstack agent at BL-004 Phase 2b commit boundary, 37% / yellow context
---

# `/compact` is operator-only; agent-side cooperative compaction primitive is hard-restart-with-fresh-MEMORY

## Symptom

A coding agent reaches a phase boundary, reads the canned `/compact` instruction library it just shipped (`.claude/rules/code-quality/compact-instructions.md`), selects the right canned prompt for its current severity tier — and then realizes it cannot run `/compact` from a tool call. `/compact` is a Claude Code built-in **slash command** typed at the prompt; it has no corresponding agent-tool-API. Agents have:

- `cortextos bus self-restart` — soft-restart, **preserves conversation history**, so does NOT free context.
- `cortextos bus hard-restart` — fresh session, **clears all conversation**, so over-compacts to durable-memory-only.
- No `/compact` equivalent. None.

The dogfood loop closing on itself surfaced this gap on the very first agent (fullstack) attempting Layer 1 cooperative compaction at a yellow severity. The agent is structurally unable to execute the action its own canned-instruction library recommends.

## Why this is a class-of-trap

The trap is treating `/compact` as a uniform action across user-side and agent-side execution paths. The shape:

- Operators (Saurav, in cortextOS's case) DO have access to the slash-command surface — they can type `/compact <canned-prompt>` against any Claude Code session via Telegram-bridge or directly.
- Agents have ONLY structured tool-call APIs. Slash commands aren't on that list.

This is the same shape as **brief-coverage-vs-test-coverage** (an LLM-worker only validates code paths covered by its tests) and **bus-cli-flag-source-of-truth** (templates accumulate flag references that drift from the actual CLI). Both rules name the trap of writing instructions that look executable from one viewpoint and aren't from another. `compact-instructions.md` was authored by an agent for an agent, but its contents are operator-actions disguised as agent-self-actions.

The **rule of thumb:** if the recommended action is a slash-command, an interactive prompt, or anything typed at a keyboard, the audience is OPERATOR not agent. Agents only execute tool-call-shaped actions. Re-derive the agent-actionable equivalent (or label the recommendation as operator-only) before shipping the instruction.

## Pattern fix

**For BL-2026-05-08-004 (context-discipline) specifically:**

Split the "Threshold table + actions" decision tree into two columns:

- **Agent-self-action column** (what the agent can autonomously do):
  - green / soft / yellow → no autonomous action; log a heartbeat note
  - orange → log a heartbeat note recommending operator-driven /compact (don't expect the agent to do it itself)
  - red → invoke `cortextos bus hard-restart --reason "context-red"` (this IS agent-invokable; full reset is the agent-side cooperative-compaction primitive)

- **Operator-action column** (what Saurav can do via Telegram-bridge or directly):
  - yellow → optional `/compact` with the "phase boundary" canned prompt
  - orange → `/compact` with the same prompt or "mid-task emergency" depending on context
  - red → either `/compact` immediately, or let the agent's own hard-restart fire (Layer 1a)
  - any tier → manual intervention to debug a stuck agent

`compact-instructions.md` should label each canned prompt `**Agent-self?** No / Operator-applied via Saurav` so future readers don't hit the same expectation gap.

Layer 2 (daemon-forced FastChecker) is unaffected — it operates outside agent cooperation entirely.

**For the broader class:**

When you ship instruction libraries (canned prompts, runbooks, recovery procedures) that mix operator-actions and agent-actions, label each entry with its actor. A library entry that says "run X" without specifying *who* leaves the actor to be inferred — and the inferring reader can be wrong (the agent reading "run /compact" assumes it's the actor; the canned prompt was written for the operator).

## Source incident

2026-05-08T20:36Z. fullstack agent at BL-004 Phase 2b commit boundary (commit 79f9430). Self-monitor reported context-pct = 37.13% / yellow / 5pct from orange. Per the canned-instruction "phase boundary" template just shipped in Phase 1, the right action was `/compact` with the "preserve current branch + last 5 commits + open file paths; drop completed evaluator transcripts" prompt. The agent attempted to execute and could not — `/compact` is not an exposed tool. Boss directive (msg_id 1778271888102) reshaped BL-004's Layer 1 to split agent-self-action (hard-restart at red) from operator-action (/compact at yellow/orange) and instructed this finding be filed as a class-of-trap subfile.

The dogfood loop validated itself: the very first attempt at Layer 1 cooperative compaction by an agent on itself surfaced an architectural gap that the spec author (boss + fullstack at Phase 1 design time) did not foresee. Phase 2's PR description folds the architecture correction.
