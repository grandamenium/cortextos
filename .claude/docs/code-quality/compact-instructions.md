# /compact instruction library

Canned `/compact` instructions used at decision points by the context-discipline system (BL-2026-05-08-004). Each instruction is opinionated and surgical: it names what to PRESERVE and what to DROP. "Summarize everything" is the failure mode this library exists to avoid.

## Who runs these — IMPORTANT

`/compact` is a Claude Code **built-in slash command** — it is typed at the prompt by an operator (Saurav, via Telegram-bridge or directly). **Agents cannot invoke `/compact` from a tool call.** This was the first dogfood-loop finding on BL-004 (2026-05-08T20:36Z) and reshaped Layer 1 of the design. See `code-quality/agent-side-compact-not-invokable.md` for the class-of-trap rule.

Each canned prompt below is labeled with its actor:

- **Operator-applied** — Saurav types `/compact <prompt>` from the Telegram surface or directly into the agent's Claude Code session. Use these at yellow / orange severity for Layer 1b cooperative compaction.
- **Agent-self** — the agent invokes the action via its tool-call API. Today the only agent-self cooperative-compaction primitive is `cortextos bus hard-restart` (full reset; durable state from MEMORY.md and daily memory carries forward). Use at red severity per Layer 1a.

Read this file when your `~/.cortextos/<inst>/state/<agent>/context-pct.json` reports `severity != green` and you are at a safe boundary (phase / feature / merge / mid-task emergency). For agent-self actions, follow the labeled instruction. For operator-applied actions, surface a heartbeat note recommending the prompt and let Saurav decide.

## At phase boundary (within same feature) — Operator-applied

Use this BETWEEN phases of the same feature (e.g. between Phase 1 and Phase 2 of a multi-phase backlog item) when context-pct is at `yellow` and the agent has just committed a phase. Saurav types this at the prompt:

```
/compact preserve: current branch name, last 5 commits with their messages, current spec file paths, open file paths, in-flight TODO/blockers, this phase's acceptance criteria. drop: completed code-evaluator subagent transcripts, deep-eval discussions on already-merged PRs, exploration discussions on resolved questions, intermediate debugging chains where the bug is fixed.
```

**Agent-self equivalent at yellow:** none. Log a heartbeat note ("context yellow — operator /compact recommended at next phase boundary") and continue work. Wait for Saurav to compact, or let severity escalate to red and self-invoke hard-restart there.

## At feature merge (between features in the same task queue) — Operator-applied

Use this AFTER a feature PR has merged and BEFORE picking up the next backlog item.

**Step 1 (mandatory, agent-self):** the agent writes the 3-5 key learnings from the just-merged feature to MEMORY.md. Don't proceed until durable state is on disk.

**Step 2 (Operator-applied):** Saurav types:
```
/compact preserve: which feature just merged + the 3-5 key learnings (already in MEMORY.md), current backlog item if any, queue of upcoming tasks, MEMORY.md last-modified pointer. drop: ALL per-phase implementation details from the just-merged feature, all evaluator transcripts on its phases, intermediate debug chains, exploration on resolved questions.
```

**Agent-self equivalent at feature merge:** if Saurav is unavailable to compact, the agent can `cortextos bus hard-restart --reason "post-feature-merge fresh start"`. Conversation history is lost; durable memory carries forward. This is option (b) from the agent-side-compact-not-invokable rule.

## Before unrelated-task hard-restart — Agent-self

Use this branch when the next task is unrelated to the current one (different repo, different code area, different working surface).

**DO NOT `/compact` here.** Hard-restart with `--continue` gives a fresh session whose conversation history is preserved, and memory files (MEMORY.md, daily memory) carry the durable context forward. `/compact` followed by an unrelated task accumulates two layers of stale residue; hard-restart drops both cleanly.

```bash
cortextos bus hard-restart --reason "fresh-start for <new-task-name>"
```

This is agent-invokable (no operator needed).

## Mid-task emergency (severity=orange/red AND no phase boundary reachable) — Mixed

Use this only when context-pct has crossed the orange/red threshold and the agent cannot safely reach a commit boundary first. This is the worst case — accept losing some live context.

**Step 1 (Agent-self):** capture durable state to disk:
```bash
git add -A && git commit -m "wip: pre-compact safety commit"
```

**Step 2a (Operator-applied — preferred):** Saurav types:
```
/compact preserve: current uncommitted intent ("I am implementing X with approach Y, currently stuck on Z"), branch name, spec file path. drop: everything else aggressively. Be willing to lose subagent results — they can be re-fetched.
```

**Step 2b (Agent-self fallback if Saurav unavailable):**
```bash
cortextos bus hard-restart --reason "mid-task emergency at <pct>%"
```

The agent loses live conversation; the wip commit + MEMORY.md are the recovery layer.

## Anti-patterns

- **Don't `/compact` mid-subagent dispatch.** Wait for the subagent to return — its result IS context, dropping it pre-merge wastes the call. (Operator-applicable.)
- **Don't `/compact` as a substitute for memory.** MEMORY.md and daily memory are the durable layer; `/compact` only manages live conversation context. (Both audiences.)
- **Don't reload recently-discarded context after a hard-restart.** Hard-restart's purpose is a fresh start; reloading defeats it. (Agent-self.)
- **Don't expect the agent to invoke `/compact` itself.** It cannot. Either Saurav compacts, or the agent escalates to hard-restart at red. (Both audiences — class-of-trap rule lives at `code-quality/agent-side-compact-not-invokable.md`.)

## How thresholds drive these instructions (post Phase-2 architecture correction)

The context-discipline monitor computes severity from `current_loaded_tokens / context_limit` (or Claude-Code-reported `used_percentage` from the statusLine block) and the model-aware threshold table:

| Limit | green | soft | yellow | orange | red |
|---|---|---|---|---|---|
| 1M (Opus 1M) | <25% | 25–35% | 35–42% | 42–50% | ≥50% |
| 200k (Sonnet/Haiku/Opus default) | <50% | 50–65% | 65–75% | 75–85% | ≥85% |

**Action split (Phase 2 architecture correction):**

| Severity | Layer 1a — Agent-self action | Layer 1b — Operator action (Saurav) | Layer 2 — Daemon-forced (FastChecker) |
|---|---|---|---|
| green | none | none | none |
| soft | log heartbeat note | none recommended | none |
| yellow | log heartbeat note recommending operator /compact | optional `/compact` at next phase boundary | none |
| orange | log heartbeat note recommending operator /compact NOW | `/compact` NOW (or wait for red and let agent self-restart) | none |
| red | `cortextos bus hard-restart --reason "context-red"` | `/compact` immediately OR allow agent self-restart | inject handoff prompt + force hard-restart at `ctx_handoff_threshold` pct override |

The agent only has autonomous authority at red. Yellow + orange are monitoring-only for the agent; the operator decides whether to /compact.

**Tuning `ctx_handoff_threshold` (per-agent config.json):**

The legacy default is `80` (pct), which was set for 200k-context agents. Two failure modes if left unchanged across the fleet:

- **200k models (Sonnet, Haiku, Opus default):** Layer 2 fires at 80%, BEFORE Layer 1a's red boundary at 85%. That's intentional — daemon-forced handoff (with handoff prompt + .force-fresh) is preferable to the agent's self-hard-restart at 85% because it preserves more context via the handoff doc. Default 80% is fine.
- **1M-opus deployments:** Layer 2 default 80% is effectively never reached because Claude Code auto-compacts at ~42-45% (well below 80%) and the red severity boundary is at 50%. **Operators MUST override** `ctx_handoff_threshold` to 50 (match red) for 1M-opus agents, otherwise Layer 2 is decorative on those agents. The model-aware threshold table in `src/monitor/context-usage.ts` is the canonical reference.

Recommended per-model values (pct):

| Model context | `ctx_warning_threshold` | `ctx_handoff_threshold` |
|---|---|---|
| 200k (Sonnet/Haiku/Opus default) | 70 (legacy default; sits between yellow=65 and orange=75) | 80 (legacy default; sits between orange=75 and red=85) |
| 1M (Opus 1M) | 42 (matches orange boundary) | 50 (matches red boundary) |

Source: BL-2026-05-08-004 (engineer context discipline) — sb-personal-org-only spec; not part of the upstream cortextOS installer payload. Adopting orgs can re-derive the threshold tables from observed Claude Code auto-compact pressure points (~350-450k on 1M Opus, ~150-160k on 200k models). Thresholds tuneable after 1-2 weeks of observation.
