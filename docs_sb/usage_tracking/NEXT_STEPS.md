# Token-Audit — Next Steps

Companion to [PLAN.md](./PLAN.md). The plan is what was designed; this is what's done, what's left, and how to keep improving it through real use.

## Status (2026-05-13)

**Shipped on `main` as commit `dae1c8a`:**

- 47 files, +5081 lines. All three phases of the plan landed in one PR-equivalent commit.
- `src/analysis/` — pricing, types, store (JSONL), ingest, aggregate, anomalies, trigger-resolution, codex-thread-join, explain, history, ab-compare, recommendations, orchestrator.
- `src/cli/token-audit*.ts` — 12 subcommands wired into `cortextos bus token-audit`.
- `templates/token-auditor/` + `templates/token-optimizer/` — both haiku, full IDENTITY/SOUL/GOALS/GUARDRAILS/HEARTBEAT/CLAUDE/SYSTEM/USER/MEMORY/TOOLS + config.json + goals.json.
- `community/skills/token-audit/SKILL.md` — natural-language surface.
- `tests/unit/analysis/` — 45 tests covering pricing drift, ingest, aggregation, all six anomaly kinds, trigger resolution, history, ab-compare, explain, recommendation lifecycle.

**Verification done:**

- `npm run typecheck` clean.
- `npm run build` clean.
- `npm test` — 2007 passing, 1 skipped, 0 failing.
- Live smoke run against the local fleet ingested a real $45.76/hr `devops-c` session and surfaced 3 anomalies with full drill-back through `explain`.
- Merge surface against upstream: **3 added lines in `src/cli/bus.ts`**, zero other upstream-file edits.

**Plan deviations:** documented in the commit body. Three things:

1. JSONL fact store instead of SQLite (root `package.json` is dep-zero per CLAUDE.md).
2. `codex-thread.jsonl` join is dormant — upstream PTY doesn't write that file yet; the join is wired and will fill in attribution automatically when the file appears.
3. 3 lines in `bus.ts` instead of 2 — added a blank separator for readability. Still a trivial 3-way merge surface.

---

## Immediate next steps (do these first)

### 1. Push the branch + open a PR

The commit is sitting on local `main`. The push to `origin/main` was blocked by the auto-mode classifier because direct-to-default-branch pushes bypass review. Two options:

**Option A — branch + PR (recommended):**
```bash
git checkout -b feat/token-audit
git push -u origin feat/token-audit
gh pr create --title "feat(token-audit): two-agent token observability + optimization loop" \
  --body "$(cat <<'EOF'
## Summary
- Adds fleet-wide token observability: ingest Claude + Codex token logs, attribute spend, detect anomalies, drill back to evidence
- Adds token-auditor (data plane, haiku) + token-optimizer (control plane, haiku) agents
- Wires 12 CLI verbs under `cortextos bus token-audit`
- Merge surface against upstream: 3 lines in `src/cli/bus.ts`, zero other edits

## Test plan
- [x] 45 unit tests under tests/unit/analysis/ — all green
- [x] Full project suite (2007 tests) — all green
- [x] Live smoke on local fleet — ingested $45.76 session, surfaced 3 anomalies, drill-back working
- [ ] /ultrareview the PR
- [ ] Stand up token-auditor + token-optimizer agents and verify daily-digest output
- [ ] Verify threshold-check Telegram alert path end-to-end

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Option B — push to main directly:** if you decide the review burden isn't worth it for a fork, just run `git push origin main` yourself (the classifier blocks me but not you).

### 2. Run `/ultrareview` on the PR

The unit tests cover correctness of the engine but not the things humans notice:
- Whether digest copy reads cleanly to a tired Saurav on a Sunday morning.
- Whether the recommendation hypotheses are actually persuasive or read like JSON dumps.
- Whether the threshold-alert cadence (every 30m) is too noisy.
- Whether the auditor's own heartbeat + ingest spend is reasonable.
- Whether the optimizer's `approval_rules.always_ask` field is enforceable by the daemon (the rules array is informational; the actual gate is the agent's GUARDRAILS.md — verify both are aligned).

### 3. Stand up the agents

The templates exist; no agent has been instantiated yet.

```bash
# Replace <org> with your active org (boss-org? cortext-os?).
cortextos add-agent token-auditor --template token-auditor --org <org>
cortextos add-agent token-optimizer --template token-optimizer --org <org>

# Inspect the generated agent dirs to confirm the template substitutions
# (agent_name, working_directory, timezone) landed correctly.
ls ~/.cortextos/$CTX_INSTANCE_ID/orgs/<org>/agents/token-auditor/

# Start them.
cortextos start token-auditor
cortextos start token-optimizer

# Verify the daemon picked up the crons.
cortextos bus list-crons token-auditor
cortextos bus list-crons token-optimizer
```

Then wait one heartbeat cycle and check the dashboard:
- token-auditor activity feed should show `session_start` + `heartbeat` + `audit_run_started` + `audit_run_completed`.
- `~/.cortextos/$CTX_INSTANCE_ID/orgs/<org>/analytics/token-audit/turns/$(date +%Y-%m-%d).jsonl` should have rows.

### 4. Force-fire a daily-digest dry-run

Don't wait 24h. Test the digest composition path manually:

```bash
cortextos bus token-audit run --since 24h
cortextos bus token-audit summary --by agent --since 24h --format json | jq
cortextos bus token-audit anomalies --since 24h --format json | jq '.anomalies | length'
```

Then ask the token-auditor (via Telegram or bus message) to compose the daily digest now. Read the output. Edit `community/skills/token-audit/SKILL.md` if the format is wrong.

### 5. Force-fire a threshold-check at low thresholds

```bash
TOKEN_AUDIT_DAILY_USD_LIMIT=0.10 TOKEN_AUDIT_HOURLY_USD_LIMIT=0.05 \
  cortextos bus token-audit alert-check
echo "exit code: $?"
```

Should exit 1 + show breaches. Then verify the Telegram alert path: ask the token-auditor's HEARTBEAT step 3 to route the alert through boss and confirm it arrives.

---

## Soon-after next steps (week 1-2)

### 6. Stand up the codex-thread log writer

The plan calls for `codex-thread.jsonl` (per-turn tool-call events) so codex turns get proper `tools_used` / `files_touched` attribution. As of this commit, only `codex-tokens.jsonl` exists — codex turns have empty attribution and the `attribution --by file` slice misses codex work entirely.

Touchpoint: `src/pty/codex-app-server-pty.ts`. The existing `appendCodexTokenLog()` method writes tokens; a sibling `appendCodexThreadEvent()` method would write tool calls. `src/analysis/codex-thread-join.ts` is already wired to read whatever shape lands; check its expected JSON keys.

Scope: probably one method, plus a handful of call sites in the PTY's event-handling switch.

### 7. Add a dashboard panel for token-audit

Right now the dashboard reads from `cost_entries` (SQLite, via `dashboard/src/lib/cost-parser.ts`) and the token-auditor writes to JSONL under `<analyticsDir>/token-audit/`. These are parallel stores.

Two options:
- **Read JSONL from the dashboard directly.** Cheap; mirror the existing event-feed pattern. Best for the anomaly + drill-back UI.
- **Sync token-audit turns into `cost_entries`.** Heavier; gets you SQL query power. Probably not worth it for v1.

Recommendation: start with option A, a "Token Audit" tab next to "Activity" that shows: today's spend, top 5 agents, anomaly list, click-to-drill-back via `explain` JSON output.

### 8. Tune thresholds from real data

The defaults are educated guesses:
- `TOKEN_AUDIT_DAILY_USD_LIMIT=50`, `TOKEN_AUDIT_HOURLY_USD_LIMIT=10`
- cache_runaway: `cache_write / output > 50`
- compact_candidate: `cache_read ≥ 200_000`
- outlier_session: top 5% OR > 3× project median
- model_mismatch: opus with median context < 50k AND no subagent calls
- trigger_addiction: cron USD > 3× user USD per agent

After a week of real ingest, look at the false-positive rate per anomaly kind. Either:
- Adjust the constants in `src/analysis/anomalies.ts`, OR
- Promote the constants into env vars (the threshold-check already supports env overrides; do the same for cache-runaway etc.).

### 9. First end-to-end recommendation cycle

Force the optimizer to do a full recommendation lifecycle by hand, even if no proposals are warranted yet, just to walk the wiring:

```bash
# (a) Generate proposals from current fact store.
cortextos bus token-audit recommend --since 7d

# (b) Pick a proposal id and walk the state machine.
ID="<uuid-from-above>"
cortextos bus token-audit recommendation-state $ID proposed --notes "manual e2e test"
cortextos bus token-audit recommendation-state $ID approved --notes "manual e2e test"
cortextos bus token-audit recommendation-state $ID applied --notes "manual e2e test"
cortextos bus token-audit recommendation-state $ID measured --notes "manual e2e test"
cortextos bus token-audit recommendation-state $ID kept --notes "manual e2e test"

# (c) Verify the lifecycle ledger.
cortextos bus token-audit list-recommendations --format json | jq
```

Any state-transition error → bug in `src/analysis/recommendations.ts:VALID_TRANSITIONS`.

---

## How to keep improving this through use

Three feedback loops, increasing in formality:

### Loop 1 — `/ultrareview` on every change

Already covered above. Use it once when the PR opens; use it again before any significant edit to `anomalies.ts`, `recommendations.ts`, or the agent templates.

### Loop 2 — Dogfood the optimizer on itself

Both new agents are on haiku. The optimizer's own `model_mismatch` detector should fire on the optimizer if haiku is genuinely too cheap for proposal synthesis. After a week:
- If `model_mismatch` fires on `token-optimizer` itself → that's the framework telling you to bump to sonnet. Edit `templates/token-optimizer/config.json:model` to `claude-sonnet-4-6` and document why in `MEMORY.md`.
- If it stays silent → haiku is fine for the synthesis workload.

The auditor stays on haiku regardless — its work is mechanical.

### Loop 3 — Measurement honesty

This is the loop the entire design depends on. Every `applied` recommendation gets a `recommendation_outcomes` row ~7 days later. After 4-6 recommendations cycle through, you'll know:

- **Are the savings estimates calibrated?** If actual is consistently 30-50% of expected, the projections in `recommendations.ts` are too optimistic — tighten them.
- **Are the evidence floors right?** If thin-evidence proposals (close to the 10-turn floor) succeed at the same rate as fat-evidence proposals (50+ turns), the floor is too high. If thin proposals fail more often, raise the floor.
- **Which anomaly kinds are noise?** Track which kinds produce proposals that get rejected at the `proposed → approved` gate vs approved + kept. Low-yield anomaly kinds should be retired or have stricter detection criteria.

**Weekly habit (Sunday, 15 min):** read the last week's `recommendation_outcomes` JSONL. Write one MEMORY.md entry to either the auditor or optimizer about what surprised you. That entry gets reloaded on every session start by both agents and shapes the next week's behavior.

### Loop 4 — `/ultrareview` after measurement

Once you have ~5 measured recommendations, run `/ultrareview` on the **outcomes file** specifically — ask the review agent "did the framework's hypotheses match reality, and what would you change about the recommendation generation logic given these outcomes?" That gets you a second-opinion code review informed by real measurement data, not just static analysis.

---

## Open questions worth resolving early

1. **Org scoping.** Does the daemon spawn one token-auditor per org, or one per instance? The plan assumes per-instance (one auditor watching all orgs); the template's `analyticsDir` is org-scoped via `resolvePaths`. If you want per-instance, the auditor needs to walk all orgs explicitly — small change to `discoverAgents()`.

2. **Approval-rule enforcement.** The optimizer's `config.json` has `approval_rules.always_ask: [...]`. Does the daemon actually intercept Edit/Write actions and route them through `approvals`, or is the field informational and the gate lives in GUARDRAILS.md? Worth confirming before assuming the safety net is automatic.

3. **Pricing-table drift cadence.** The unit test catches drift between `src/analysis/pricing.ts` and the inlined dashboard table. The dashboard test imports the dashboard's runtime, so it can't directly import our pricing.ts to compare. Right now drift detection runs only when somebody touches one of the two files. Worth adding a weekly `check-upstream` action that diffs them out-of-band.

4. **`token-auditor` event log size.** Daily ingest writes one `audit_run_completed` + N `anomaly_detected` events. Over a year that's ~365 + maybe a few thousand. Fine. But the `<analyticsDir>/events/token-auditor/<date>.jsonl` files grow forever — same as every other agent. No special action needed unless your existing rotation policy doesn't cover analytics events.

5. **What "approve" actually means.** The plan says recommendations route through the `approvals` skill. Today, the optimizer would create an approval record and wait. Confirm there's a path from "user clicks approve in the dashboard / replies to Telegram" → optimizer's recommendation moving from `proposed` to `approved`. If not, the lifecycle stalls at step one.

---

## Files in this directory

- [PLAN.md](./PLAN.md) — the original design plan (verbatim copy).
- [NEXT_STEPS.md](./NEXT_STEPS.md) — this file.

Add new docs here as you go: outcome retros, threshold tuning notes, dashboard wireframes, etc.
