# Plan — End-to-end resequencing of context/cost issues 01–08 (first principles, post-research)

## Context

Operator asked me to think through the full issue corpus end-to-end from first principles, not just iterate on Issue 08's ranking. Web research across Anthropic's docs (effective-context-engineering-for-ai-agents, effective-harnesses-for-long-running-agents, prompt-caching) and community guidance (HumanLayer, Anthropic best-practices, ccusage statusline guide) changed how I see the problem.

## First principles (what the research grounded)

Three orthogonal levers, in priority order — this is the canonical framing per Anthropic:

**Lever A — Keep the cacheable prefix small AND stable per cache lifetime.**
- "CLAUDE.md is loaded every session, so only include things that apply broadly. For domain knowledge or workflows only relevant sometimes, use skills."
- "Bloated CLAUDE.md files cause Claude to ignore your actual instructions" (a correctness issue, not just cost).
- Cache hierarchy: `tools → system → messages`. Any modification at a level invalidates that level and all below it. Dynamic content (timestamps, rotating IDs) inside the cached prefix invalidates the cache and **5× costs per turn**.
- Cache TTL is 5 min default / 1 h paid. Pauses longer than TTL re-pay at *write rate* (12.5× the read rate).

**Lever B — Compaction is the first-class lever, not an optimization.**
- Anthropic: "Compaction... serves as the first lever in context engineering to drive better long-term coherence."
- The operator-typed `/compact` is the canonical primitive. The agent's job is to **surface boundary moments cheaply** (every turn via statusline; at heartbeats via canned-prompt nudges).

**Lever C — Just-in-time loading beats eager loading.**
- Pattern: CLAUDE.md as thin pointer, skills + `@path/to/file.md` for on-demand load.
- "Don't tell Claude all the information... tell it how to find important information so it can use it only when needed."

## How the existing 8 issues collapse under this framing

| Issue | Lever | What it actually says |
|---|---|---|
| 01 — context discipline not self-applied | B | No compaction signal → 146M-token session |
| 02 — Bash loops dominant cost | A | Repeated tool calls re-read the cached prefix every turn |
| 03 — subagent attribution gap | (measurement) | Verification blocker for A/B/C claims |
| 04 — no live per-session cost visibility | B | No statusline = no per-turn awareness |
| 05 — TaskCreate cache_create anomaly | A | Likely tool-state mutation invalidating cache prefix |
| 06 — compact boundaries missed | B | Same as 01, operational view |
| 07 — posix_spawnp self-heal | (unrelated) | Resolved; not part of this plan |
| 08 — boss bootstrap context bloat | A + C | Eager-load creep; what I started fixing |

**Issues 01, 04, 06 are one issue from three angles.** They share one fix (Lever B).
**Issues 02, 05, 08 are about Lever A and Lever C.** They share one architectural fix (two-tier bootstrap + cache-stability audit).
**Issue 03 unblocks measurement for everything else.**

## What changed from my previous plan after research

1. **Statusline got promoted from Tier 3 (engineering project) → Tier 1 (config).** The research confirms `/statusline` is a shipped Claude Code feature; per-turn cost/context display is a shell script + settings.json edit. This is the canonical Lever B implementation and should ship first, not last.
2. **NEW: Cache-stability audit (Tier 4).** None of the 8 issues caught this. If our cron prompts or tool-list contain dynamic content (timestamps, rotating IDs), every turn is paying at write rate. Worth verifying before optimizing anything else.
3. **Two-tier bootstrap reframed.** Not just a token-saving optimization — it's the canonical Anthropic pattern for CLAUDE.md (`@path/to/file.md` progressive disclosure). The current cortextOS pattern of "read 12 files on every boot" is anti-pattern, not just suboptimal.
4. **TaskCreate anomaly (Issue 05) hypothesis sharpened by research.** The cache_create ratio is consistent with tool-state mutation breaking the cache prefix — exactly what Anthropic warns against. Worth a 20-min investigation, not deferred indefinitely.

## Re-sequenced plan

### Tier 0 — Close my self-introduced gap (immediate, this session)

The Issue 08 archive pass stripped all code-quality + knowledge.md references from agent CLAUDE.md. Class-of-trap rules are now invisible to engineer/fullstack/devops when they start code work. Need lazy-load pointer.

**File edits:** `orgs/sb-personal/agents/{engineer,fullstack,devops}/CLAUDE.md`. Add one line near `## Working tree` / `## Standard Coding Practice`:

> `When starting non-trivial code work, read docs_archive/code-quality.md (universal P9 rules + class-of-trap subfiles in docs_archive/code-quality/) and docs_archive/sb-personal-knowledge.md (fleet-wide build/eval/PR loop contract).`

Token cost: ~50 tokens × 3 agents. Preserves the lazy-load value of what we archived.

### Tier 1 — Cheap wins, same session (≤30 min total)

**1.1 Statusline per session — operator-first (Issue 04 item 2 / Lever B)**

This is the single biggest behavior change available. Every turn the operator sees `cost: $X · ctx: ZZ%` → compaction decisions become automatic.

- Use `/statusline` skill OR write a shell script that reads `state/$AGENT/context-pct.json` + JSONL token counters → emits `model | branch | ctx: ZZ% | cost: $X.XX | cache: NN%`.
- Configure in `~/.claude/settings.json` (operator session) and per-agent `.claude/settings.json` (fleet sessions).
- Pattern reference: `ccusage` statusline guide + `scripts/self-healing/usage-monitor.sh` (already wires Telegram tier alerts; reuse cost math).

**Verification:** operator sees the number on every turn after install. During next multi-phase task, runaway-session shape visible before $100 list.

**1.2 Engineer `ctx_handoff_threshold` → 50 (Issue 06 item 4 / Lever B)**

Engineer is the only Opus+1M agent. Current 80 is decorative because Claude Code auto-compacts ~42-45% on 1M. Red boundary per `docs_archive/code-quality/compact-instructions.md` is ≥50.

**File:** `orgs/sb-personal/agents/engineer/config.json:38` → `"ctx_handoff_threshold": 50`.

**1.3 Remove `bus list-skills` boot call fleet-wide (Issue 08 item 2 / Lever A)**

Same edit pattern as the Issue 08 item 1 archive pass. Skills referenced by name from CLAUDE.md/HEARTBEAT.md when needed; the discovery list isn't load-bearing on every boot.

**Files:** `orgs/sb-personal/agents/{boss,analyst,engineer,fullstack,devops,token-auditor}/CLAUDE.md` — remove `cortextos bus list-skills --format text` from each `## Session Start` "Then:" bash block.

**Honest impact:** ~3,400 tokens × ~5 boots/day × 6 agents = ~30-40k tokens/day. Fires at boot only (not per heartbeat — corrected from my earlier overstatement).

**1.4 Prune boss MEMORY.md stale entries (Issue 08 item 3 / Lever A)**

Drop (each expired or rolled into permanent practice):
- "Operational lessons (2026-05-08 burst session)"
- "Reverse-retrofit candidates: cortexOS ← jarvis" (bake date 2026-05-26)
- "BL-2026-05-10-007 closed (2026-05-13)"
- "Analyst cron changes (revert when HALT lifts)" — verify HALT state first
- "devops-c A/B trial" — replace with the 2026-05-18 decision outcome
- "Idle-timeout crash prevention" — now permanent practice in cron config

**File:** `orgs/sb-personal/agents/boss/MEMORY.md`. 13k → ~6-7k bytes. ~8.5k tokens/day saved.

### Tier 2 — Cache-stability audit (NEW, surfaced by research, ~30 min)

Before optimizing further, verify we aren't bleeding through cache invalidations every turn.

**2.1 Audit cron-injected prompts for dynamic content.**

Read each agent's `config.json` `crons[].prompt`. Look for timestamps, dates, message IDs, anything that changes between firings. If found, move to a stable pointer (e.g. "read $(date)/memo" → "read today's memo at known path").

**2.2 Verify tool/MCP stability across a session.**

- Check whether deferred-tool list mutates mid-session (e.g. when an Agent tool spawns, does the tool list change?).
- Audit MCP servers per agent. If MCP is registered but not used in 7 days, remove (per PR-A's A7 — never fully executed).

**2.3 Decide on 1h-cache vs 5m-cache.**

cortextOS heartbeat cron is 4h — both TTLs expire before the next fire, so cache misses are structural per heartbeat. The right model: keep the prefix tiny so the cache miss is cheap. Document this explicitly in the new two-tier bootstrap (Tier 5.1) — don't try to win on cache hits at 4h cadence; win on small prefix.

**Verification:** post-audit, `analyze.py session <id>` should show `cache_read / cache_create` ratio improve. Anthropic API response fields: `cache_creation_input_tokens` vs `cache_read_input_tokens`.

### Tier 3 — Verification infrastructure (Issue 03 item 1, engineer dispatch)

Unblocks quantitative verification of Tier 1.3 / 1.4 / 5.1 claims.

**Implementation:** `analyze.py feature <branch-name>` — ~50 LOC; correlates `~/.claude/projects/*/` JSONLs by `(branch, time-window)`. Models after existing `recent-candidates` subcommand.

**File:** `scripts/session-analysis/analyze.py`

**Verification:** pick one recent shipped BL, run `analyze.py feature <branch>`; output should be 4-6× the main-dir-only `summary`.

**Observed (2026-05-15, PRs #58 and #64, post substring-grep fix):**
- PR #58 (`fix/watchdog-idle-suppress`, mostly engineer-side):
  - Default (tag OR time-window): TOTAL ~$1,624 across 20 sessions; vs engineer-cwd session $52 ≈ **31× upper bound**.
  - `--strict` (branch-tag only): TOTAL $0 — JSONLs for this PR's sessions don't carry the branch tag (worktree gitBranch likely showed `main`). Signal: strict mode reveals when tag-tracking is missing.
- PR #64 (`feat/payload-cap-drift`, multi-agent):
  - Default: TOTAL ~$949 across 11 sessions; vs main-cwd contributing sessions $276 ≈ **3.4× upper bound**.
  - `--strict`: TOTAL $276 across 2 branch-tagged sessions — defensible lower bound; matches the contributing-cwd spend.
- The ±2h time-window catches concurrent activity in unrelated cwds (e.g. jarvis sessions matched via overlap, not branch-tag). `branch-tag` matches are the precise signal; `time-window` matches are an upper bound. Use `--strict` for the lower bound, or post-filter JSON by `match == "branch-tag"`.

### Tier 4 — Compaction boundary signal (heartbeat-time, Issue 01 item 1 / Issue 06 item 1)

Layered on top of Tier 1.1 (statusline = per-turn) — this is heartbeat-time = per-cycle.

When a heartbeat fires and `context-pct.json` is yellow or orange AND the latest assistant turn is text-only (or idle ≥60s):

- Agent emits one-line operator hint via Telegram (using existing `scripts/comms/send-telegram-guarded.sh`):
  > `"context yellow at <pct>% — /compact <canned-prompt> would be safe here"`
- Canned prompt pre-quoted from `docs_archive/code-quality/compact-instructions.md` so operator pastes in one keystroke.

**Files:**
- Each agent's `HEARTBEAT.md` — add Step 3e "compact-eligible check" after existing 3d context-discipline step.
- Reuses existing `cortextos bus context-update` and `state/$AGENT/context-pct.json` outputs.

**Verification:** During next long operator-engaged session, hint should fire ≥ once when context crosses 40-45%.

### Tier 5 — Architectural (the canonical Anthropic pattern)

**5.1 Two-tier bootstrap with progressive disclosure (Issue 08 item 4 / Lever A+C)**

Matches Anthropic's canonical CLAUDE.md pattern: thin pointer, `@path/to/file.md` for lazy load.

- **Minimal cold-boot per agent:** IDENTITY (1.3k) + GOALS (0.8k) + GUARDRAILS (2.5k) + a 1-page operating-norms summary (~2k). Total ~6-7k tokens / agent.
- **Lazy-load on trigger:**
  - Heartbeat cron fires → agent reads `HEARTBEAT.md`
  - Code-work dispatch → engineer reads `docs_archive/code-quality.md`
  - Org questions → reads `docs_archive/sb-personal-knowledge.md`
  - Specific skills → loaded by name from agent's skill-trigger logic
- **Comms-discipline consolidation:** project-level `.claude/rules/comms-discipline.md` (6.8k, auto-attached) and `community/skills/comms-discipline/RULE.md` (canonical) — keep only the canonical, slim project rule to 1-line pointer.

**Files:**
- `orgs/sb-personal/agents/*/CLAUDE.md` — rewrite per agent, ≤120 lines each
- `.claude/rules/comms-discipline.md` — slim to pointer
- `src/daemon/agent-manager.ts:934` — verify cron-prompt injection doesn't re-introduce the moved content

**5.2 Bash batching + retry-loop guards (Issue 02 / Lever A)**

Add to engineer/fullstack/devops CLAUDE.md `## Token & context efficiency` section:

1. *"`npm run build && npm test` runs once at end of phase, not after each edit. Pre-commit is the regression gate."*
2. *"Same command fails twice → stop and reason. Third attempt rarely succeeds (`docs_archive/code-quality/network-call-timeouts.md`)."*

**Verification:** `analyze.py tools` after 2-3 merges. Bash share drops from 57% → <40%.

**5.3 Payload-cap drift cron (NEW, surfaced by research insight on "would removing this cause Claude to make mistakes?")**

Anthropic best practice: "Would removing this cause Claude to make mistakes? If not, cut it." Apply mechanically with a weekly cron:

- Cron measures `wc -c orgs/*/agents/*/{CLAUDE,MEMORY,HEARTBEAT}.md`.
- Alerts when any agent's combined startup payload exceeds the cap (15k tokens / agent, per superseded PR-A target).
- Posts to bots-supergroup as standing-rule reminder.

**File:** add to one of the existing 1h crons (standby-enforcer is a good host).

### Tier 6 — Investigation (Issue 05, ~30 min total)

Research sharpened the hypothesis: TaskCreate's 48k cache_create per call is consistent with tool-state mutation invalidating the cache prefix. Two reads needed to confirm:

1. Read JSONL for the turn-before and turn-after one TaskCreate in session `28ec1a74`.
2. Compare cached blocks; look for the Task state list growing inside the cached prefix.

If confirmed: file upstream issue. If not: usage-pattern rule ("batch task creates").

### Tier 7 — Deferred to Phase 2 / 3 (per PR-A roadmap)

- USD budget caps + auto-handoff
- Heuristic Opus escalation for engineer (Agent calls > 5 → respawn on Opus)
- Advisor strategy (Haiku executor + Opus advisor)
- Haiku for procedural roles after Phase 1 data

## Critical files (consolidated)

**Tier 0 (this session, ~5 min):**
- `orgs/sb-personal/agents/engineer/CLAUDE.md`
- `orgs/sb-personal/agents/fullstack/CLAUDE.md`
- `orgs/sb-personal/agents/devops/CLAUDE.md`

**Tier 1 (this session, ~30 min):**
- `~/.claude/settings.json` (operator statusline)
- `orgs/sb-personal/agents/*/CLAUDE.md` (strip list-skills)
- `orgs/sb-personal/agents/engineer/config.json:38` (threshold)
- `orgs/sb-personal/agents/boss/MEMORY.md` (prune)

**Tier 2 (this session, ~30 min, read-only audit):**
- `orgs/sb-personal/agents/*/config.json` (cron prompts)
- MCP server registrations

**Tier 3 (engineer dispatch):**
- `scripts/session-analysis/analyze.py` (new `feature` subcommand)

**Tier 4 (boss/engineer joint):**
- `orgs/sb-personal/agents/*/HEARTBEAT.md` (add compact-eligible check)

**Tier 5 (engineer dispatch, multi-commit):**
- `orgs/sb-personal/agents/*/CLAUDE.md` (full rewrite ≤120 lines)
- `.claude/rules/comms-discipline.md`
- `src/daemon/agent-manager.ts:934`
- `orgs/sb-personal/agents/{engineer,fullstack,devops}/CLAUDE.md` (Bash batching rule)

**Tier 6 (boss):**
- Read JSONL for two TaskCreate-adjacent turns.

## Verification framework

Per-tier verification described inline. Cross-tier baseline:

```bash
# Pre-tier-1 baseline
python3 scripts/session-analysis/analyze.py summary > /tmp/pre-baseline.txt
for a in boss analyst engineer fullstack devops token-auditor; do
  wc -c orgs/sb-personal/agents/$a/{CLAUDE,MEMORY,HEARTBEAT}.md
done > /tmp/pre-payload.txt

# Post-tier-1 (24h later)
python3 scripts/session-analysis/analyze.py summary > /tmp/post-tier1.txt
# Compare: cache_read share, median session tokens, max session $
```

Once Tier 3 lands (analyze.py feature), re-verify Tiers 1 + 4 + 5 with cross-agent attribution.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Statusline script consumes tokens itself | L | Statusline is host-side, not in-prompt; no token cost |
| Tier 0 pointer cited but agent doesn't read before code | M | Explicit "**read first**" phrasing; observe first engineer task |
| Engineer threshold 50 fires handoffs too aggressively | M | 48h pilot; raise to 60 if mid-work handoffs occur |
| Cache-stability audit finds load-bearing dynamic content | L | Document each finding; fix one at a time with measurement |
| Tier 5 rewrite breaks something silently load-bearing | M | One agent at a time (start with token-auditor — least critical); commit per file; revert if first-heartbeat fails |
| Two-tier bootstrap makes agents "forget" rules | M | Each removal needs the "would removing this cause Claude to make mistakes?" test documented in the commit body |
| Subagent attribution numbers double-count | L | Time-window dedup is standard; cross-check on one shipped BL before relying |

## Sequencing logic (first principles)

1. **Statusline first** because per-turn visibility is the cheapest, most leveraged Lever B implementation. Operator gets immediate value.
2. **Tier 1 config fixes second** because they're observable on next agent restart with no measurement infra needed.
3. **Cache-stability audit third** because it's read-only and may reveal a structural cost trap that changes Tier 5's shape.
4. **Verification infra fourth** because by then we have enough Tier 1+2 changes that need cross-agent measurement.
5. **Compaction signal fifth** because it's the heartbeat-time complement to Tier 1.1's per-turn signal.
6. **Architectural sixth** because Tier 1-4 data should inform the specific shape (e.g. exact lazy-load triggers).
7. **Investigation last** because it's the smallest cost ($10 list) of any item.

## What I'd actually recommend doing first

**Tier 0 + Tier 1.1 statusline + Tier 1.2 engineer threshold.** That's:
- 3 small CLAUDE.md edits (Tier 0)
- 1 settings.json edit + 1 statusline script (~50 LOC) (Tier 1.1)
- 1 config.json edit (Tier 1.2)

Single session, ~30 min, low blast radius, two of the three first-principles levers in motion. Tier 1.3 (list-skills) and Tier 1.4 (MEMORY.md prune) can follow once Tier 1.1's measurement signal proves itself.

## Sources

- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective harnesses for long-running agents — Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Writing a good CLAUDE.md — HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [Claude Code statusline docs](https://code.claude.com/docs/en/statusline)
- [ccusage statusline guide](https://ccusage.com/guide/statusline)
- [Claude prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [How Claude prompt caching actually works — mager.co](https://www.mager.co/blog/2026-04-29-claude-prompt-caching/)
- [Skill authoring best practices — Claude Docs](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
- [How Claude Code works in large codebases — Anthropic](https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start)
