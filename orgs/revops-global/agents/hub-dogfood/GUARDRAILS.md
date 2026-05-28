# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |
| Completing a code-fix task (Fix/Wire/Implement/Add) | "I found the issue and fixed it — I'll complete it myself" | **STOP.** hub-dogfood is QA-only. Route to dev via `mcp__rgos__cortex_create_task` + `cortextos bus send-message dev`. Never call `cortextos bus complete-task` on a code-fix without a PR URL in the result. Self-completing without a PR inflates counts and corrupts dashboard trust. See Code-Fix Task Dispatch Rule in CLAUDE.md. |

For the complete red flag table (15 patterns), see `.claude/skills/guardrails-reference/SKILL.md`.

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check - did I hit any guardrails this cycle? If yes, log it:
   ```bash
   cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row to the table in `.claude/skills/guardrails-reference/SKILL.md`. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it to the skill file. Format:

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

---

## Fan-Out + Goal Validation Discipline (2026-05-20)

Triggered by Greg's directive: cortextos spends too much time patching issues instead of setting clear goals + having agents validate them. Three rules — apply on every non-trivial task.

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task has 3+ decomposable parts | "I'll do them one at a time so I can think clearly" | **NON-TRIVIAL TASK = FAN OUT.** Spawn parallel subagents (Agent-tool or `cortextos bus spawn-worker`) for each independent part BEFORE delegating to a specialist. Specialists are for their lane, not for orchestration. Serial-when-should-parallel is a velocity bug. |
| `cortextos bus create-task` invocation | "I'll add success_criteria later, the title is clear enough" | **SUCCESS_CRITERIA OR REJECT.** Every task created without `success_criteria` is rejected by the bus. Completion requires an LLM-judge pass against the criteria. No criteria = no task. |
| Dispatching multiple sub-tasks | "Better do these in order so nothing breaks" | **SEQUENCE WHEN ORDER MATTERS, PARALLEL OTHERWISE.** Default is parallel. Sequencing is the exception and requires an explicit dependency reason in the task description (e.g. "task B needs the artifact from task A"). Vague "feels safer to sequence" does not justify serialization. |

### Why this exists
- Antigravity 2.0 (Google I/O 2026) demoed 93 parallel sub-agents shipping a core OS framework in 12h. cortextos already has the fan-out primitives (Agent-tool subagents + spawn-worker) but under-uses them.
- Today's morning brief shipped at 5.3/10 because the experiment treatment was never wired in for 5 days — no success_criteria validation gate.
- Every patches-not-validation incident is a missing instance of one of these three rules.

### Companions
- `goal-completion-probe` cron (every 4h) measures per-agent advance ratio = (tasks advancing goals) / (recent completed tasks). Drift flag fires if ratio < 30%.
- `bus validate-task <id>` (forthcoming) — LLM-judge gate before completion status flip.


---

## Orgo Usage (2026-05-20)

Greg directive: Orgo VMs are the DEFAULT for browser/GUI/computer-use work. Greg is watching the Orgo fleet through **2026-05-28** ([[project_orgo_value_watch]]) — under-utilization counts against the eval.

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Need a browser, GUI, or computer-use surface | "I'll SSH to Greg's Mac" | **Orgo lease first.** `cortextos bus orgo-lease-claim` against one of the 5 nodes: `orgo-codex-computeruse`, `orgo-hub-qa`, `orgo-linkedin-session`, `orgo-telegram-web`, `orgo-wiki-ingestion-worker`. Mac SSH is only for Mac-specific apps/state. |
| Task requires Codex.app, Greg's saved browser session, or Greg's open Chrome profile | "Use Orgo, it's the default" | **Use `mac-codex` instead.** Orgo VMs do not have Greg's local Mac auth state. If the task explicitly needs Greg's Mac-side credentials/apps, dispatch via `mac-codex`. |
| Task needs a browser and Orgo has the right pre-auth state | "I'll just spin up Playwright locally" | **Claim the Orgo lease that already has the auth state baked in** (e.g. `orgo-linkedin-session` for LinkedIn). Idle Orgo nodes = wasted utilization. |
| Multiple agents need Orgo nodes simultaneously | "Whoever gets there first wins" | **Lease before use.** `orgo-lease-claim` holds the node for your task; release with `orgo-lease-release` when done. Skipping the lease = clobbered sessions. |
| Orgo task seems too small | "Not worth the lease overhead" | **Still lease.** Sub-100% utilization counts against the value watch. Stack quick tasks onto already-leased nodes when possible. |

### Decision matrix

- **Public web page, no saved-state needed** → Orgo (`orgo-codex-computeruse` is the general-purpose default)
- **Greg's own Mac browser / Codex.app / saved Greg auth** → `mac-codex`
- **hub.revopsglobal.com QA** → `orgo-hub-qa`
- **LinkedIn (any account)** → `orgo-linkedin-session`
- **Telegram web client** → `orgo-telegram-web`
- **Wiki ingestion / scraping** → `orgo-wiki-ingestion-worker`

### Why this exists
Two Greg memories drive this: [[feedback_orgo_vm_cu_replaces_mac_default]] (2026-05-18: "every 'take over your computer' task → Orgo VM") and [[feedback_orgo_capacity_proof_first]] (don't grow fleet beyond 5 until current pool shows 100% util with shipped artifacts). The Orgo value watch closes 2026-05-28.

