# Plan — Agent cost & context optimization (cortextOS + Jarvis)

> **SUPERSEDED 2026-05-11.** PR-A and PR-A2 shipped from this plan (per-role payload trim, configs, 1M-off, skills extraction). The forward-looking decisions in this doc — particularly the model assignments (engineer=sonnet, analyst=opus, devops=sonnet) and the Phase 2/3 daemon-side roadmap — have been re-decided from data, not from this plan, in `orgs/sb-personal/backlog/REASSESSMENT-2026-05-11.md`. Read the reassessment first for the current direction. The sections below remain useful as historical context for PR-A/A2 design rationale.

## Context

Token-spend analysis (`scripts/session-analysis/analyze.py`, 2026-05-11) surfaced **~$9.9k list across the four cortextOS org-agent dirs** (boss $2.7k · analyst $2.2k · engineer $2.6k · devops $0.4k · fullstack $2.0k) and ~$9.2k on `sb-claude-jarvis`. One cortextOS engineer session reached **658M tokens / 1,664 turns / 79 hours**. Goal: cut spend significantly without degrading agent usefulness.

Research (Anthropic Claude Code docs, 2026 community guidance) plus per-role data dive plus per-file content audit grounded the plan. Three independent levers, applied together:

1. **Model + context** — Sonnet 4.6 @ 200K default; Opus only where data shows it's needed; 1M off everywhere by default.
2. **File-level restructure** — Anthropic's <200-line CLAUDE.md cap; eliminate 2,300+ lines of cross-role boilerplate by extracting to shared skills; delete role-duplicated `AGENTS.md` and `TOOLS.md`.
3. **Session-design controls** — 8h `max_session_seconds` cap (was 71h); threshold corrections for 200K tier (70/80); Bash-batching + `/compact`-cadence prose.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Default model (boss, devops) | **Sonnet 4.6 @ 200K** | Procedural Bash-dominated dispatch (boss 92% Bash, devops 68%); Anthropic docs explicitly endorse Sonnet-default |
| **analyst** | **Opus 4.7 @ 200K** | Data: 317M-token / 1,113-turn synthesis runaway; multi-day interpretation-critical work. Sonnet would degrade quality. |
| **engineer / fullstack** | **Sonnet 4.6 @ 200K + operator-triggered Opus escalation** | Median sessions short (344/438 turns) fit Sonnet; outlier sessions are *session-design* failures, not model failures |
| 1M context | **Off by default**; on per-task only | Caps per-turn cache_read scaling |
| `max_session_seconds` | **28800 (8h)** | Was 255600 (71h) — the runaway-permitting setting |
| Thresholds | **70/80** for 200K-tier agents | Matches `compact-instructions.md` table |
| Startup-file restructure | **Aggressive**, target <15K tokens/role | Anthropic <200-line CLAUDE.md cap + delete cross-role duplication |
| Rollout | **Both projects in parallel** | One PR per project |

## PR-A — cortextOS (`/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork/`)

### A1. Per-agent config.json changes

For each `orgs/sb-personal/agents/<role>/config.json` and matching `templates/{agent,analyst,orchestrator}/config.json`:

```jsonc
{
  "model": "sonnet",                    // "opus" for analyst only
  "ctx_warning_threshold": 70,
  "ctx_handoff_threshold": 80,
  "max_session_seconds": 28800,         // was 255600
  // ... existing fields preserved
}
```

Per-role overrides:
- boss → `"sonnet"`
- analyst → `"opus"`  ← only exception
- devops → `"sonnet"` (also fix unset thresholds)
- engineer → `"sonnet"`
- fullstack → `"sonnet"`

Verify model strings via `src/cli/add-agent.ts` resolver path; avoid `opus[1m]` rejection trap.

### A2. Disable 1M-context by default
- `src/cli/add-agent.ts:174` — **uncomment** `CLAUDE_CODE_DISABLE_1M_CONTEXT=true` in `.env` template.
- New script: `scripts/migrations/2026-05-disable-1m-context.sh` — idempotent; ensures every existing `orgs/*/agents/*/.env` has the line uncommented.

### A3. File-by-file restructure (the substantive content work)

Anthropic guidance: CLAUDE.md <200 lines per agent. Current files: 308–419 lines (boss 377, analyst 419, engineer/devops/fullstack 308). Audit found ~2,300 lines of cross-role boilerplate.

**Files to DELETE (move content to skills/docs):**

| Path pattern | Lines × 5 roles | Reason |
|---|---:|---|
| `orgs/sb-personal/agents/*/AGENTS.md` | 526–534 × 5 = ~2,650 | Pure boilerplate, 80%+ identical across roles; content already in CLAUDE.md and skills |
| `orgs/sb-personal/agents/*/ONBOARDING.md` | 485–675 × 5 = ~2,800 | One-time onboarding — existing `onboarding` skill already covers it |
| `orgs/sb-personal/agents/*/TOOLS.md` | 159–161 × 5 = ~800 | Identical across roles → consolidate to one `docs/guides/bus-cli-reference.md` |

Apply same deletions to `templates/{agent,analyst,orchestrator}/` versions.

**Files to TRIM in place (per-role concrete targets):**

| Role | File | Current lines | Target | Specific cuts |
|---|---|---:|---:|---|
| boss | CLAUDE.md | 377 | **160** | Cut "First Boot Check" (use onboarding skill ref); cut Memory Protocol Layer 1–3 (→ new `memory-discipline` skill); cut "Spawning a New Agent" (→ orchestrator-specific skill); cut Telegram boilerplate (→ existing `comms` skill). Keep: role definition, daily ops summary, skill index. |
| analyst | CLAUDE.md | 419 | **140** | Cut duplicate onboarding/session/memory blocks (same as boss); cut "Spawning a New Agent" 307–335 (analyst doesn't spawn — pure copy-paste from boss); cut "Analyst Responsibilities" 383–420 → skill `system-diagnostics`. Keep: synthesis-cycle role guidance. |
| engineer | CLAUDE.md | 308 | **120** | Cut duplicate boot/session/memory blocks; cut worktree discipline (50 lines) → new `worktree-discipline` skill with 2-line summary. Keep: code-task workflow, build/test cadence. |
| devops | CLAUDE.md | 308 | **120** | Same shape as engineer; emphasize ops surface. |
| fullstack | CLAUDE.md | 308 | **120** | Same shape as engineer. |
| all roles | HEARTBEAT.md | 141–312 | **50–100** | boss HEARTBEAT 218 → 80 (fleet health → skill); analyst 312 → 80 (deep-health → skill); engineer/devops/fullstack 141–160 → 50 (just heartbeat + inbox sweep). Cut 2026-05-07 disk-pressure incident-specific content from boss line 60–74. |
| all roles | SOUL.md | 63–104 | **30** | 60+ lines identical across roles; keep role-specific 5–10 lines, reference shared `soul-philosophy` skill (already exists). |
| all roles | GUARDRAILS.md | 47–68 | **25–35** | Keep core red-flag table; cut role-irrelevant rows; flag deprecated "BL-003 phase-3" reference in analyst GUARDRAILS.md:23 for verification before keeping. |

**Per-role post-restructure target:** CLAUDE.md (≤200) + HEARTBEAT.md (≤100) + SOUL.md (~30) + GUARDRAILS.md (~30) + MEMORY.md (existing 1-4K) + value-spec.md (~30) = **~12–15K tokens** (down from 23–30K).

### A4. New skills + shared docs to create (extract destinations)

| New file | Content extracted from | Approx size | Triggers |
|---|---|---:|---|
| `.claude/skills/memory-discipline/SKILL.md` | Memory Protocol Layer 1-3 (boss CLAUDE.md:106-124, analyst:75-92, engineer:84-125) | 80 lines | Triggered on session-start memory writes, daily memory snapshot, KB-ingest |
| `.claude/skills/dispatch-protocol/SKILL.md` | Fresh-restart heuristic (boss/analyst:172-252, engineer:145-225) | 80 lines | Triggered on inbox-sweep, send-message-to-agent, fresh-restart decisions |
| `.claude/skills/worktree-discipline/SKILL.md` | Multi-agent git contamination rules (all roles ~50 lines each, identical) | 40 lines | Triggered before code edits / git checkout |
| `templates/EVENT_LOGGING_PROTOCOL.md` (shared) | Event-logging boilerplate (~25 lines × 5 roles) | 40 lines | Referenced from each agent's CLAUDE.md by path |
| `docs/guides/bus-cli-reference.md` | TOOLS.md content (currently 5 identical copies) | 150 lines | Pure reference, never auto-loaded |
| `docs/guides/agent-protocol.md` | Agent-to-agent message format, inbox sweep, ACK semantics | 50 lines | Operator-facing |

Net effect: ~2,300 lines of duplicated boilerplate collapse into ~440 lines of single-source skills + shared docs.

### A5. Template prose updates (≤30 net lines per CLAUDE.md)

Add to each post-trimmed CLAUDE.md:
- **Bash batching:** "Run `git status && git log -5 && git diff --stat` in one Bash call; three sequential turns each pay full cache_read." (Issue 02)
- **`/compact` cadence:** "At phase boundary with context yellow+, request operator-side `/compact` before continuing. Canned prompts in `.claude/rules/code-quality/compact-instructions.md`." (Issue 06)
- **CLI over MCP:** "Prefer `gh`, `aws`, `gcloud`, `bun` CLI over MCP equivalents — fewer per-tool listing tokens."
- **Cache hygiene:** "Don't modify tool definitions or system messages mid-session — invalidates the cache prefix."

### A6. Engineer/Fullstack Opus-escalation rule (operator-triggered, Phase 1)

Document in engineer + fullstack CLAUDE.md:
> "For complex multi-phase work (architectural decisions, multi-step refactors, ambiguous-spec resolution), the operator starts with `cortextos start <agent> --model opus` per-task override. Default `sonnet` covers the median work."

Heuristic-triggered auto-escalation (Agent calls > 5 → respawn on Opus) is **Phase 2** — requires FastChecker change.

### A7. MCP audit
For each agent, list MCP servers registered. For each, justify "is CLI equivalent available?" If yes, drop the MCP server. Findings as checklist in PR body. Reduces per-tool listing overhead.

### A8. Quality-flag fixes (found by content audit)

| Path | Issue | Fix |
|---|---|---|
| `orgs/sb-personal/agents/boss/HEARTBEAT.md:60-74` | Disk pressure check references resolved 2026-05-07 incident | Generalize to "check disk quarterly" or remove |
| `orgs/sb-personal/agents/analyst/CLAUDE.md:307-335` | "Spawning a New Agent" — analyst doesn't spawn, pure copy from boss | Delete |
| `orgs/sb-personal/agents/analyst/GUARDRAILS.md:23` | Deprecated "BL-003 phase-3 boss-failover" reference | Verify current failover spec or deprecate |

## PR-B — Jarvis (`/Volumes/MacStorage/UserData/0devprojects/sb-claude-jarvis/`)

### B1. Model defaults
- `core/config.py:claude_default_model` → `"sonnet"` (was `"opus[1m]"`)
- `docs/examples/fleet/agent-config.example.json` — update example
- Per-agent overrides (path verified during impl): synthesis/analyst-equivalent role → `"opus"`; all others inherit Sonnet default
- Same `max_session_seconds: 28800` cap

### B2. Threshold corrections
- `ctx_warning_pct: 70`, `ctx_handoff_pct: 80` — current values already 70/80 but were decorative under `opus[1m]`; now meaningful under Sonnet 200K

### B3. `.claude/rules/code-quality.md` split
Currently 9.4K inline-loaded (largest startup file across both projects). Split into:
- `code-quality.md` inline core ≤ 4K (universal P9 only — same shape cortextOS adopted)
- `code-quality/<slug>.md` on-demand subfiles
- Subfile index at bottom

### B4. Root markdown audit
- `KI-UPGRADE.md` (491 lines, 2026-04-06 unimplemented proposal) → **move to `docs/proposals/`** — does not belong in agent context
- `HOW-TO-USE.md` (697 lines, user-facing guide) → **split into `docs/guides/`** topic files (notes-and-tasks, todoist-taxonomy, memory-layer, fleet-operations)
- Root `CLAUDE.md` (68 lines) → tighten to **~50 lines**, architecture rules only. Fix hardcoded path at line 62–64 (`/Volumes/MacStorage/...`) → use `$CTX_FRAMEWORK_ROOT`. Verify voice-NLP claims at HOW-TO-USE.md:32–50 are implemented or mark "planned".

### B5. Same Phase 1 prose additions (Bash batching, /compact cadence, CLI-over-MCP, cache hygiene) in Jarvis's equivalent template path.

## Phase 2 — Daemon-side cost controls (separate PRs after Phase 1 stabilizes)

- **USD budget caps per agent.** FastChecker reads JSONL token counters; bus-alerts at `max_session_cost_usd_soft` (default $25), force-handoff at `_hard` (default $75).
- **Live cost surface in statusline.** Emit `cost: $X.YY · ctx: ZZ% · cache_read: NN%` per turn. (cache_read share addresses March-2026 caching-bug class.)
- **Cron-injection slim-down.** `src/daemon/agent-manager.ts:934` — cron-fire prompts reference cron by name, full body in versioned file the agent reads on first need.
- **Heuristic Opus escalation** for engineer/fullstack (Agent calls > 5 → auto-respawn on Opus).
- **Issue 03 — subagent attribution.** Correlate sibling `~/.claude/projects/` dirs by branch + time-window. Without it, our verification numbers undercount true spend ~5–10×.

## Phase 3 — Future experimentation

- **Advisor Strategy.** `advisor-tool-2026-03-01` beta — Haiku executor + Opus advisor. Pilot on analyst (currently Opus); if quality holds, ~50% further cost cut.
- **Haiku for procedural roles.** Boss/devops on Haiku 4.5 after Phase 1 stabilizes. Higher behavioral risk; needs A/B.
- **Skill-only context loading.** All current always-loaded role guidance moves into skills with explicit triggers; CLAUDE.md becomes a thin pointer file.

## Verification framework

### Pre-rollout snapshot (per project)
```bash
python3 scripts/session-analysis/analyze.py summary > /tmp/<project>-before.txt
python3 scripts/session-analysis/analyze.py tools   > /tmp/<project>-tools-before.txt
python3 scripts/session-analysis/analyze.py projects --limit 20 > /tmp/projects-before.txt
for role in boss analyst devops engineer fullstack; do
  echo "=== $role ==="
  wc -c orgs/sb-personal/agents/$role/*.md 2>/dev/null | tail -1
done > /tmp/<project>-payload-before.txt
```

### Per-PR acceptance gates
- All agents start and pass first-turn heartbeat after restart.
- `cortextos start <agent>` logs show correct `model=` and **no `1m` marker**.
- Operator can manually escalate one engineer task to Opus (regression check for the escalation path).
- New agent created via `add-agent` inherits the new defaults.
- Per-role startup payload ≤15K tokens.
- New skills load on their documented triggers; agents reference them correctly.
- `npm run build` + `npm test` green in cortextOS; equivalent for Jarvis.

### Post-rollout targets (3–5 days normal work, then re-analyze)
- **Median session tokens** ≤25% of baseline
- **Max session $** ≤$50 (was $334)
- **Max session wall-clock** ≤8h (was 79h)
- **Cache_read share** ≤90% of session spend (was 97%)
- **Per-agent startup payload** ≤15K tokens (was 23–30K)
- **Bash share of tool tokens** ≤40% (was 57%)
- **`compact-candidates --threshold 350`** ≤5 per session (was 30+)

### Behavior regression watch (2 weeks)
Track user-visible degradation: slower responses, worse code, more retries, user complaints. If Sonnet fails on a class of task, escalate that role to Opus 200K specifically — don't roll back the whole change. Document each failure case in `docs_sb/issues/`.

## Critical files (consolidated)

### cortextOS — modified
- `orgs/sb-personal/agents/{boss,analyst,devops,engineer,fullstack}/config.json`
- `orgs/sb-personal/agents/*/.env`
- `orgs/sb-personal/agents/*/CLAUDE.md` (trim ≤200 lines)
- `orgs/sb-personal/agents/*/HEARTBEAT.md` (trim ≤100 lines)
- `orgs/sb-personal/agents/*/SOUL.md` (trim ~30 lines)
- `orgs/sb-personal/agents/*/GUARDRAILS.md` (trim ~30 lines)
- `templates/{agent,analyst,orchestrator}/*` (apply matching changes)
- `src/cli/add-agent.ts:174`
- `src/daemon/agent-process.ts:514-522` (verify boot-prompt assembly doesn't re-introduce moved files)

### cortextOS — deleted
- `orgs/sb-personal/agents/*/AGENTS.md` (×5)
- `orgs/sb-personal/agents/*/ONBOARDING.md` (×5)
- `orgs/sb-personal/agents/*/TOOLS.md` (×5, replaced by single shared reference)
- Same deletions in `templates/`

### cortextOS — new
- `.claude/skills/memory-discipline/SKILL.md`
- `.claude/skills/dispatch-protocol/SKILL.md`
- `.claude/skills/worktree-discipline/SKILL.md`
- `templates/EVENT_LOGGING_PROTOCOL.md`
- `docs/guides/bus-cli-reference.md`
- `docs/guides/agent-protocol.md`
- `scripts/migrations/2026-05-disable-1m-context.sh`

### Jarvis — modified
- `core/config.py`
- `docs/examples/fleet/agent-config.example.json`
- Per-agent configs (location verified during impl)
- Root `CLAUDE.md` (trim to ~50 lines; fix hardcoded path)
- `.claude/rules/code-quality.md` (split into inline-core + subfiles)

### Jarvis — moved (`git mv`)
- `KI-UPGRADE.md` → `docs/proposals/2026-04-ki-upgrade.md`
- `HOW-TO-USE.md` → split into `docs/guides/{notes-and-tasks,todoist-taxonomy,memory-layer,fleet-operations}.md`

### Jarvis — new
- `.claude/rules/code-quality/` (subfile dir)

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Sonnet can't handle a role's workload | M | Per-role escalation path; 2-week watch; promote specific role to Opus 200K if needed without rolling back full change. Analyst already pre-emptively on Opus. |
| Deleting files breaks something silently loaded | M | Move (rename) before delete in a separate commit; verify via session-start log; rollback is `git revert` of one commit. |
| Skill triggers don't fire when needed | M | Each new skill (memory-discipline, dispatch-protocol, worktree-discipline) gets at least one explicit reference in CLAUDE.md so the agent can name it. Monitor first week for "agent didn't load X" reports. |
| 8h `max_session_seconds` forces handoff mid-work | M | Handoff prompt + MEMORY.md / daily memory already exist. Pilot on one agent first 3 days. If frequent mid-work handoffs, raise to 12h. |
| Engineer needs Opus more than data shows | M | Operator escalation explicit and cheap; watch escalation frequency; if >30% of engineer sessions escalate, promote engineer to Opus default. |
| Jarvis layout differs more than expected | M | PR-B has explicit "verify during implementation" step for agent-config path discovery; surface as blocker if structurally different. |
| `analyze.py` USD numbers diverge from real billing | L | Numbers are directional; cross-check vs ccusage at rollout. |
| Quality-flag-fix deletes load-bearing rule | L | Each deletion in PR body lists what the rule said + why we believe it's stale; rollback via cherry-pick. |
| Cross-fleet contamination via working trees | L | Existing `cross-fleet-contamination.md` rule applies; commit cortextOS PR-A and Jarvis PR-B from separate worktrees. |

## Out of scope (separate issues)

- **Issue 03** — Subagent attribution → promoted to Phase 2.
- **Issue 04** — Live cost surface → promoted to Phase 2.
- **Issue 05** — TaskCreate cache_create anomaly → keeps as standalone investigation.
