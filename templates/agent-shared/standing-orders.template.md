# Shared Standing-Orders Template

**Single Source of Truth** for standing orders, user-proxy routing, platform-director consult,
architecture-vault protocol, and lightweight boot mode.

Each agent references this file from its `CLAUDE.md` instead of duplicating it.
Saves ~5-8k tokens per agent bootstrap.

---

> **SETUP INSTRUCTIONS (remove this block after customising)**
>
> 1. Copy this file to `orgs/<your-org>/agent-shared/standing-orders.md`
> 2. Replace every `{{PLACEHOLDER}}` with your org's values
> 3. Remove sections that don't apply to your org (e.g. ARCHITECTURE-VAULT if no vault)
> 4. Each agent's `CLAUDE.md` should reference it with one line:
>    `Read {{ORG_ROOT}}/agent-shared/standing-orders.md on cold-start only.`

---

## SIX STANDING-ORDERS (Founder-Authority)

Violations → `STANDING-ORDER-VIOLATION` tag in audit-log.

**SO-1 Ground-Truth-Verification**: Before relying on multi-agent confirmation, run your own
query, cite the source, and document any disagreement. Anti-pattern: "4 agents agree" as proof.

**SO-2 Falsification-Workflow**: Before concluding "X is the cause," list 3 hypotheses each with
Evidence-For, Evidence-Against, and an Experiment-to-falsify. Run the experiments, then conclude.

**SO-3 Risk-Calibration**: Before labelling something URGENT/CRITICAL, calculate
`Likelihood × Impact` (each 1–5). >12 = URGENT legitimate, 6–12 = HIGH, <6 = NORMAL.
Compliance claims require a legal source citation.

**SO-4 Founder-Authority**: Founder statements override agent observations on conflict.
Before escalating to Founder: `grep -r "<topic>" {{ORG_DECISIONS_LOG_PATH}}` —
if a prior decision matches, apply it rather than re-asking.

**SO-5 Self-Test Before Action**: Mental dry-run of capabilities and credentials.
For CLI commands: know your auth context. For code removal: check business consequences
(payments, auth, email, reconcilers).

**SO-6 Enforcement Over Verbal Order**: Every Founder instruction needs a technical enforcement
mechanism. Verbal-only = it will drift. Build the guard.

---

## USER-PROXY DEFAULT

When you have a question that would normally go to the Founder via Telegram: STOP.
Ask `{{USER_PROXY_AGENT}}` first:

```bash
cortextos bus send-message {{USER_PROXY_AGENT}} normal "<question + full context>"
```

`{{USER_PROXY_AGENT}}` responds via AI in 1–3 min OR escalates autonomously when needed
(>{{ESCALATION_THRESHOLD}}, legal, patient data, irreversible).

Auto-escalate to Founder for: money, legal, patient data, provider contract cancellation.

---

## PLATFORM-DIRECTOR CONSULT (codebase knowledge)

When your question is about the codebase, ask `{{PLATFORM_DIRECTOR_AGENT}}`:

```bash
cortextos bus send-message {{PLATFORM_DIRECTOR_AGENT}} normal "<question>" --reply-needed
```

Routing:
- "How should I decide between X and Y?" → **{{USER_PROXY_AGENT}}**
- "Where is X in the code?" → **{{PLATFORM_DIRECTOR_AGENT}}** (code index)
- "What was the lesson from PR #ZZZ?" → vault search `{{ORG_VAULT_PATH}}/agent-shared/`

Do NOT ask anyone if you can answer via Read+Grep in 5 min (5-min self-research > 10-min wait).

---

## ARCHITECTURE-VAULT PROTOCOL

**LAZY-LOAD MODE**: Read only when your task touches architecture-critical code.
Do not read prophylactically on boot.

When modifying architecture-critical code:
1. Read `{{ORG_VAULT_PATH}}/architecture-vault/00-MASTER-READ-ME-FIRST.md`
2. Read the matching layer doctrine: `{{ORG_VAULT_PATH}}/architecture-vault/<layer>/01-project-doctrine.md`
3. If doctrine is missing → STOP, write doctrine via PR first.

> **Customise**: remove this section if your org has no architecture vault.

---

## TASK + PR WORKFLOW (HARD RULE)

1. Push includes `Closes task_<id>` → after merge: check task status first.
   If already completed → SKIP (do NOT re-close; re-closing overwrites the original VERIFIED result).
   Only call `cortextos bus complete-task <id>` when status ≠ completed.
2. For fix PRs: READ code path → TRACE → WRITE regression test → THEN push.
3. No "done" claim without impl on main OR task verified-stale vs current main.
4. PR escalated for a decision OR under active iteration → mark DRAFT immediately
   (`gh pr ready --undo`). Auto-shepherd merges any non-draft PR on green CI
   and cannot detect functional breakage.

---

## LIGHTWEIGHT BOOT MODE

**Heartbeat cron**: ONLY `cortextos bus update-heartbeat alive` + `cortextos bus check-inbox`.
No full file-bootstrap.

**Cold-start (initial session)**: read ONLY essential files:
- `IDENTITY.md` — who am I
- `GOALS.md` — current objectives
- `memory/{{TODAY}}.md` — what I did today (if it exists)

Do NOT read on every cold-start: `SOUL.md`, `GUARDRAILS.md`, `MEMORY.md`, `USER.md`
(all on-demand when relevant).

**Sustained activity**: read what is relevant for the current task. Do not reload bootstrap.

Cost-awareness: every file read costs input tokens. Cumulative across many agents × 24/7 is significant.

---

## GIT WORKTREE ISOLATION (shared repos)

When multiple agents touch the same repo concurrently, one `git checkout` strands another
agent's uncommitted edits on the wrong branch.

**Rule**: Any agent editing `{{SHARED_REPO_PATH}}` MUST use an isolated worktree.

```bash
# Create worktree for a new task/branch
git -C {{SHARED_REPO_PATH}} worktree add -b <branch-name> /tmp/<task-slug>-wt origin/main

# Work inside the worktree
cd /tmp/<task-slug>-wt
# edit, test, commit, push

# Cleanup after PR merge
git -C {{SHARED_REPO_PATH}} worktree remove /tmp/<task-slug>-wt
```

Naming convention: `/tmp/<agent>-<task-id>-wt`. Keep worktree until PR is merged.

**NEVER**: `cd {{SHARED_REPO_PATH}} && git checkout <branch>` — guaranteed HEAD hijack with parallel agents.

> **Customise**: set `{{SHARED_REPO_PATH}}` to your shared codebase path, or remove this section
> if agents work on isolated repos only.

---

## SO-7: No-Routine-ACK in Synchronous Bus Threads

When another agent sends a polite thread-terminal ("thanks", "standing by", "got it", "confirmed",
"roger", ".") — DO NOT reply with another polite ack. The first thread-terminal from either party
ends the thread. Silence after = correct discipline.

**Exceptions — reply IS warranted when:**
- Adding new substantive info (boundary context, factual correction, hand-off detail)
- Confirming receipt of a concrete next-step action
- Closing a multi-step protocol that has a documented terminal state

**Anti-pattern:** ack-ping-pong loops. Target: ≤3 messages per resolved finding.

**Why:** messaging volume per finding trades directly against context budget and Founder cognitive load.

---

## SO-8: Skill State Management — `update-cron-fire` Inside the Skill

Any skill invoked by a recurring cron MUST call
`cortextos bus update-cron-fire <name> --interval <X>` inside its own State Management /
Finalization section.

Placing it only in the `config.json` cron prompt suffix is an anti-pattern: context exhaustion
during a long workflow silently skips the suffix, leaving `cron-state.json` stale.

**Pattern — State Management section at end of every cron-driven skill:**
```bash
cortextos bus update-cron-fire <skill-cron-name> --interval <interval>
cortextos bus update-heartbeat "<skill> complete"
```

**Anti-pattern (DO NOT):** `"prompt": "… Then call: cortextos bus update-cron-fire <name>"` as the
only place the call exists.

---

## CRON-STAMPEDE COLLAPSE (SO-8 extension)

When ≥3 crons OR ≥2 state-modifying crons fire within 60 s: invoke the cron-stampede-collapse skill.

Short rule:
1. `update-cron-fire` calls sequential (cheap — no & in parallel)
2. Actual cron work parallel where possible
3. State-modifying crons NOT parallelised
4. Validate cron names against your own `config.json` — names are agent-specific

> **Customise**: update the stampede threshold if your org uses a different collision window.
