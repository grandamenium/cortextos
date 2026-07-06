# WS8 — Multi-Harness Model Routing

_Spec written 2026-07-04. Planning pass only — no code, no PRs, no live-fleet changes. Fork = `clearworks-ai/cortextos` (Josh's). Design input: James's (upstream creator) 2 IG reels — his 7-agent / 3-harness roster + model-routing rubric + orchestrator digest — adapted to OUR fleet, NOT copied._

---

## 1. GOAL

Stop the fleet from being ~8/10 concentrated on Anthropic, which is the single-point-of-failure that **broke the fleet this morning** when Josh's Anthropic credits depleted (trending + wiki-synthesis crons failed). Josh's ruling was **"failover-only for now"** — so the primary deliverable is a **graceful degrade path** (when Anthropic rate-limits or depletes, drop to a cheap non-Anthropic tier instead of failing silently), tied to the credential-preflight cron that already detects depletion. On top of that, this spec designs — but does NOT auto-apply — a **cost/capability routing rubric** (task-type → harness + model + cost-tier) and a **concrete redistribution plan** so Josh can, at his discretion, move bulk/mechanical crons off Opus/Sonnet onto OpenCode/Haiku and reserve Claude/Fable for real reasoning. This directly serves the governing goal of **certainty** (a depletion event produces a visible degrade + a receipt, never a silent stall) and a **reliable remote manager** (Josh sees "fleet degraded to cheap tier, Anthropic depleted" on his phone, not 6 dead crons discovered hours later).

**Scope discipline (per Josh's ruling):** ship the failover mechanism + the rubric-as-documentation. Do NOT do a fleet-wide model migration in this WS — that is a per-agent, Josh-gated decision the rubric enables. This keeps WS8 small and additive, avoiding the conflict-bomb failure mode that closed #717/#718/#719.

---

## 2. GROUNDED CURRENT STATE (file:line evidence)

Verified by reading the real files on `main` today. **Batch A (#718, which contained the first WS8 attempt) is CLOSED, not merged** — assume nothing from it landed. Confirmed: nothing failover-related exists on the fork.

### 2.1 How an agent declares its model + harness (the lever WS8 uses)
- **Two fields, both in `config.json`:** `runtime` (the harness) and `model` (the model string). Typed at `src/types/index.ts:220`: `runtime?: 'claude-code' | 'hermes' | 'codex-app-server' | 'opencode'` (defaults to `claude-code` when absent), and `src/types/index.ts:167`: `model?: string`.
- **The `model` field IS honored by all three live runtimes** — this is the load-bearing fact that makes WS8 cheap:
  - **claude-code:** `src/pty/agent-pty.ts:261-262` — `if (this.config.model) args.push('--model', this.config.model)`. So Claude agents launch with `claude --model <config.model>`.
  - **opencode:** `src/pty/opencode-pty.ts:90-91` — `if (this.config.model) args.push('--model', this.config.model)`. The model string is `provider/model` (e.g. `openrouter/moonshotai/kimi-k2-thinking`, `orgs/clearworksai/agents/opencode/config.json`).
  - **codex-app-server:** model is fixed by the codex runtime (`gpt-5-codex`, `orgs/clearworksai/agents/codexer/config.json`).
- **Config is re-read from disk per spawn.** `src/daemon/agent-process.ts:1086-1097` already re-reads `config.json` on the session-timer path (BUG-048 fix), and the daemon reads each agent's `config.json` fresh at process start (`src/daemon/index.ts`). **Consequence: changing `config.json` `model` (+ `runtime` for a cross-vendor switch) + `cortextos restart <agent> --instance cortextos1` is a complete, supported live model switch. No new spawn code is needed to change a model.**

### 2.2 The live fleet is ~8/10 Anthropic (the concentration this WS attacks)
Grounded from `config.json` `model` fields across `orgs/*/agents/*/`:
| Agent | runtime | model | vendor |
|---|---|---|---|
| larry | claude-code | claude-opus-4-8 | Anthropic |
| frank2 | claude-code | claude-sonnet-5 | Anthropic |
| muse | claude-code | claude-sonnet-5 | Anthropic |
| maven (×2) | claude-code | claude-sonnet-5 | Anthropic |
| sage | claude-code | claude-sonnet-4-6 | Anthropic |
| hunter | claude-code | claude-sonnet-4-6 | Anthropic (OFF — `feedback_hunter_permanently_off`) |
| auditos/auditos2/academy/sre | claude-code | claude-sonnet-4-6 | Anthropic |
| ophir | claude-code | (unset → default) | Anthropic |
| **codexer** | **codex-app-server** | **gpt-5-codex** | **OpenAI** |
| **opencode** | **opencode** | **openrouter/moonshotai/kimi-k2-thinking** | **OpenRouter** |

So of the ~10 live agents, only 2 are off Anthropic (codexer, opencode). Every recurring cron on every claude-code agent runs on Anthropic. **When Anthropic depleted this morning, there was no non-Anthropic path for any of the bulk crons.**

### 2.3 Routing is per-AGENT today, never per-TASK or per-CRON
- **`CronEntry` has NO `model` field.** Verified `src/types/index.ts:245`+ — a cron carries `name`, `interval`/`cron`/`fire_at`, `prompt`, `type`, `description`, `metadata`, `manualFireDisabled`. There is no per-cron model/runtime override. **A cron always runs under its host agent's runtime+model.** (larry's 8 crons all run on Opus 4.8; muse's fleet-activity + trending run on Sonnet-5.)
- **Workers inherit too.** `spawn-worker` (`src/daemon/ipc-server.ts:665`) takes `name`/`dir`/`prompt` — no model param. Comms-check / meeting-brief workers run under the spawning agent's model.
- **Implication:** "move heartbeats to Haiku" is impossible at the cron granularity today without either (a) moving the whole host agent, or (b) adding per-cron routing (a real code change — see Design 3.4, deferred).

### 2.4 The credential-preflight cron detects depletion but does NOT degrade anything
- **The detector is real and good:** `orgs/clearworksai/agents/larry/scripts/credential-preflight.py`. It probes Anthropic (`api.anthropic.com/v1/messages` with `claude-haiku-4-5`, `:47-63`) + OpenAI embeddings, classifies `DEPLETED` on HTTP 400 + "credit balance" body text (`:112-114`), `RATE_LIMITED` on 429 (`:117`), debounces (alert on the 2nd consecutive hard failure, `:139-146`), and on `ALERT_FAIL` calls `cortextos bus send-message larry high <msg>` + `log-event preflight credential_failure error` (`:287-307`).
- **What it does NOT do:** it only ALERTS. There is **no action taken to keep the fleet running** on depletion. The `depends` field (`:62`, `"daily-wiki-prep/wiki-synthesis, Claude-direct cron tasks"`) documents the blast radius but nothing consumes it to degrade. **This is the exact gap that let this morning's outage cascade** (`incident_anthropic_api_credits_depleted_2026-07-03`: "SILENT-OK generated=0 masks it").
- Registry is Anthropic + OpenAI only; per `reference_kb_embeddings_gemini_not_openai`, OpenAI is stale for embeddings (Gemini now) — but the Anthropic probe is exactly right and is WS8's failover trigger.

### 2.5 No failover / degraded-mode primitive exists anywhere
- `grep -rn "DEGRADED\|failover\|fallback.*model" src` → the only hits are unrelated (`codex-app-server-pty.ts:166` "degraded" = a codex transport error string; `crons.ts:107` "degraded sentinel" = a schedule concept). **Confirmed: no model-failover mechanism, no degraded-mode flag, no cheap-tier fallback exists on the fork.**
- `OPENROUTER_API_KEY` is NOT in any tracked agent `.env` or config — per `reference_opencode_openrouter_setup` it is set at process/shell env level, and the opencode runtime auto-detects it. So OpenRouter is already reachable by the daemon's child processes; WS8 does not need to plumb a new key, only confirm it is present (`required_env`).

### 2.6 WS4 fleet-reconcile gives a ready-made env-drift check to reuse
- `src/bus/reconcile.ts` already emits `missing_env` drift for any key an agent declares in `required_env` (`config.json`) but is absent from its resolved env (`:185-196`, typed `src/types/index.ts:185`). **WS8's "is OpenRouter reachable before we rely on it as failover?" check is free: add `OPENROUTER_API_KEY` to the failover-capable agents' `required_env`** and WS4 flags it if it ever goes missing. No new probe needed for presence; the preflight script can add a live OpenRouter probe for validity (Design 3.3).

**Summary of what exists vs missing:**
- EXISTS: per-agent model selection honored by all 3 runtimes (2.1); depletion DETECTION (2.4); OpenRouter reachable at process env (2.5); env-drift reconcile to reuse (2.6); 2 agents already non-Anthropic (2.2).
- MISSING: any DEGRADE action on depletion (2.4); per-cron/per-task routing (2.3); a written routing rubric; any redistribution of bulk crons off Anthropic (2.2).

---

## 3. DESIGN (concrete, minimal, reuse infra)

Three layers, in strict priority order. **Layer A (failover) is the only must-ship per Josh's ruling.** B and C are documentation + a Josh-gated, opt-in redistribution — they change no behavior until Josh approves each agent.

### 3.0 Per-AGENT vs per-TASK — the decision (answers the spec's core question)

**Ship per-AGENT static routing now; defer per-TASK dynamic dispatch.** Rationale, grounded:
- Per-AGENT is **already the fleet's native model** (§2.1, §2.3) and needs **zero new spawn code** — a model change is a `config.json` edit + restart the daemon already supports. Per-TASK would require adding a `model`/`runtime` field to `CronEntry` + `spawn-worker` + a per-turn model-switch in three different PTY adapters — a large, cross-cutting change with exactly the conflict-bomb blast radius that killed the last batch.
- The creator's own fleet is **per-AGENT** (each of his 7 agents is pinned to one harness+model: Donna on Codex, OpenCode agent on GLM, Data on GPT-5.5). His *chain* is dynamic, but it is orchestrated by handing a task to a different pinned agent — not by one agent swapping its own model mid-task. That maps cleanly onto our per-agent model.
- **Failover is the ONE place a dynamic (env-driven) override is justified**, and it is still coarse (fleet-level, not per-task): a single env flag that the spawn path reads to substitute a cheap model. That is small and additive (Layer A).

**Decision: per-agent static routing (the rubric) + one fleet-level env failover override. Per-task/per-cron routing = explicitly deferred to a future WS (sketch in 3.4) — do not build it here.**

### 3.1 The routing RUBRIC (documentation artifact — task-type → harness, model, cost-tier)

Author `orgs/clearworksai/agents/larry/reference/model-routing-rubric.md` as the fleet's canonical routing doctrine, adapted from the creator's rubric to OUR harnesses. This is a **reference doc Josh and larry consult when placing an agent/cron** — it is NOT executable and changes nothing on its own.

**Tiers (cheapest → most capable), mapped to our real harnesses:**

| Tier | Use for | Harness · model | Vendor | Notes |
|---|---|---|---|---|
| **T0 bulk/mechanical** | heartbeats, log/health monitoring, status reads, comms-triage first-pass, scraping/research fetch | OpenCode · `z-ai/glm-4.7-flash` (~$0.46/M) or `openrouter/moonshotai/kimi-k2-thinking` (current) | OpenRouter | cheapest; tool-calling ✓ (openrouter brief) |
| **T1 grounded search / bulk impl** | web research, competitor scrape, bulk data extraction | OpenCode · Gemini (grounded search) / Deepseek V4 (cheap impl) via OpenRouter | OpenRouter/Google | creator's "Gemini = grounded search, Deepseek = cheap impl" |
| **T2 pre-planned implementation** | building an APPROVED, spec'd change (codexer's job today) | Codex · `gpt-5-codex` | OpenAI | already our impl harness; keep |
| **T3 default reasoning / synthesis** | comms judgment, briefs, synthesis, mid-complexity planning | Claude Code · `claude-sonnet-5` / `claude-sonnet-4-6` | Anthropic | frank2/muse/maven today |
| **T4 deep planning / long-horizon** | architecture, multi-workstream orchestration, adversarial review, long-running goal-oriented | Claude Code · `claude-opus-4-8` and/or `claude-fable-5` | Anthropic | larry today; Fable available to us |

**Anti-concentration rule (the doctrine line):** _no more than ~60% of active recurring crons may sit on a single vendor._ Today it is ~90% Anthropic; the redistribution (§3.2) brings it toward the rule.

**The creator's default CODING CHAIN, mapped onto OUR flow (this already largely exists — we name it, don't rebuild):**
Creator: OpenCode+Gemini research → Claude+Opus synthesis → Claude+Fable planning → parallel Codex+GPT-5.5 impl → Claude+Opus review-loop → Claude files PR.
Ours (grounded in `larry/CLAUDE.md` Codex-handoff workflow + WS12 + `SWARM-PROTOCOL.md`):
1. **research** → OpenCode/knox (T0/T1) — cheap, non-Anthropic.
2. **synthesis** → `architect` (Opus, T4) via larry — real file paths, not summaries (`larry/CLAUDE.md` PLANNING routing).
3. **planning** → larry (Opus, T4) or **Fable** for a long-horizon plan; produces OBF/M2C1 artifacts (the `gate-codexer-planning.sh` gate).
4. **parallel implementation** → codexer (Codex/`gpt-5-codex`, T2), sharded via WS12's parallel-shard rule + worktree isolation.
5. **adversarial review loop** → larry (Opus, T4), max 2 cycles (`larry/CLAUDE.md` Codex-handoff step 5).
6. **PR** → larry (Josh-gated merge).
**WS8's contribution to the chain: make step 1 cheap-tier by default (T0/T1 OpenCode), and add Fable as the named T4 long-horizon planner** — the chain shape itself is already the fleet's flow. This is a doctrine edit to the rubric + a one-line note in larry's routing, not new orchestration code.

### 3.2 Redistribution plan (Josh-gated, opt-in, NOT auto-applied)

The rubric applied to the current fleet, as a **menu of per-agent config edits Josh approves one at a time.** Each is a `config.json` `model`(+`runtime`) change + `cortextos restart <agent> --instance cortextos1`.

**MOVE to cheap/non-Anthropic (T0/T1) — candidates:**
- **A dedicated `monitor` role → OpenCode (T0).** The bulk mechanical crons — larry's `heartbeat`, `repo-health`, `uptime-check`, `staging-health`; muse's fleet-activity digest; trending-repos — are pure fetch/summarize/log. **Because crons can't be individually re-homed (§2.3), the clean move is to relocate these crons onto the existing `opencode` agent (already T0, already non-Anthropic)** rather than leave them on Opus/Sonnet. The `opencode` agent today has "NO defined job" (just a heartbeat) — **giving it the fleet's bulk-monitoring + research crons is its job.** This is the highest-leverage single move: it takes the most frequent, most mechanical crons off Anthropic in one shot.
- **Research/scraping** (knox-style external fetch, competitor scans, trending) → OpenCode T1 (Gemini grounded / kimi).

**KEEP on Anthropic (real reasoning — do NOT move):**
- **larry** — T4 Opus (orchestration, adversarial review, PR gate). Optionally add **Fable** as larry's long-horizon planner (see 3.5).
- **frank2** — T3 Sonnet-5 (comms judgment, briefs, meeting-commitment gates). Josh-facing judgment; keep.
- **muse** — T3 Sonnet-5 for the *writing/voice* work (the Humanizer rubric, Josh-voice copy) — but its *mechanical* fleet-activity + trending crons move to OpenCode (above).
- **codexer** — T2 `gpt-5-codex` (already non-Anthropic; the impl harness). Keep.

**Net effect:** the highest-frequency crons (4h heartbeats ×N agents, health checks, trending, fleet-activity) come off Anthropic → the fleet survives an Anthropic depletion because monitoring/research keep running on OpenCode, and only the *reasoning* agents (larry/frank2/muse-writing) are affected — and those degrade via Layer A rather than dying.

### 3.3 Layer A — FAILOVER (the must-ship: degrade, don't fail silently)

Tie the degrade to the preflight cron that already detects depletion (§2.4). **Env-flag failover, read by the existing spawn path — no per-turn model switching, no new runtime code.**

**Mechanism (coarse, fleet-level, additive):**
1. **Extend `credential-preflight.py`** so that on a debounced Anthropic `DEPLETED` **or** sustained `RATE_LIMITED` (`ALERT_FAIL`), in addition to the existing alert it:
   - writes a degrade marker: `state/fleet-degrade.json` `{ "anthropic": "DEPLETED", "since": <iso>, "cheap_model": "z-ai/glm-4.7-flash", "cheap_runtime": "opencode" }` (atomic write, mirrors the script's existing `write_state_atomic`, `:254`).
   - emits a NEW event `log-event preflight fleet_degraded warn --meta {...}` so R6/WS10 and the digest can see it (reuses the existing `run_bus_command` log-event path, `:296`).
   - the alert message becomes actionable: _"Anthropic DEPLETED — fleet degrading claude-code agents to <cheap_model> on OpenCode. Reasoning quality reduced until credits restored."_ (routes to larry per `feedback_railway_alerts_route_to_larry`; Josh sees the diagnosis, not raw).
2. **The daemon spawn path reads the marker.** In `agent-process.ts`, at the point it already reads `config.model` for the launch args (the `claude-code` branch feeding `agent-pty.ts:261`), add: **if `runtime === 'claude-code'` AND `state/fleet-degrade.json` shows Anthropic depleted, substitute `runtime=opencode` + `model=<cheap_model>` for this spawn.** This is the ONE new code path. It is read-only against the marker, per-spawn (so it self-heals: when preflight clears the marker on `ALERT_RECOVER`, `:397`, the next restart of each agent returns to its configured model).
   - **Guard:** only degrade agents that carry a `degrade_ok: true` flag (new optional `config.json` field) — larry/frank2/muse opt in; codexer/opencode are already non-Anthropic and irrelevant. This prevents blindly downgrading an agent whose whole job needs Opus. Default absent = do NOT degrade (conservative).
3. **Preflight adds a live OpenRouter probe** (a third registry entry: `POST openrouter.ai/api/v1/chat/completions`, tiny `glm-4.7-flash` ping, `Bearer OPENROUTER_API_KEY`). Reason: **do not fail OVER to a tier that is itself down.** If OpenRouter is also `DEPLETED/INVALID`, the degrade marker is NOT written and the alert says _"Anthropic depleted AND OpenRouter unavailable — no failover path, manual intervention needed"_ (hard-honest, certainty).
4. **Restart trigger:** the marker only takes effect on each agent's next spawn. On `fleet_degraded`, preflight (or larry acting on the alert) issues `cortextos restart <agent> --instance cortextos1` for each `degrade_ok` agent (single-agent restarts, never a daemon bounce — `reference_fleet_daemon_restart_guard`). Recovery is symmetric on `ALERT_RECOVER`.

**Why env-flag/marker, not per-task:** it reuses the "config re-read per spawn" fact (§2.1) and the existing preflight state-write + event infra. The entire behavior change is: *one marker file + one read in the spawn path + one guard flag.* Small, additive, reversible, testable.

### 3.4 Per-TASK / per-CRON routing — DEFERRED (sketch only, do not build)

For a future WS if Josh wants finer control: add optional `model?`/`runtime?` to `CronEntry` (`src/types/index.ts:245`) and to the `spawn-worker` IPC payload (`ipc-server.ts:665`), and have the daemon spawn that cron's turn under the override. This is the creator's finest granularity but is a cross-cutting change across the type, the cron scheduler, `spawn-worker`, and three PTY adapters — **explicitly out of WS8** to keep it conflict-bomb-free. Named here so it is not silently lost.

### 3.5 Fable as the named T4 long-horizon planner (optional, low-risk)

`claude-fable-5` is available to us. The creator uses Fable for "long-running goal-oriented / complex planning+impl." Concrete low-risk adoption: **make Fable an available model for larry's planning artifacts** (larry already invokes `architect`/plans; Fable becomes a selectable planner for multi-workstream orchestration), documented in the rubric T4 row. This is still Anthropic (does NOT help the concentration problem) — so it is a *capability* add, not a *failover* add, and is opt-in. Do not move larry wholesale to Fable in this WS.

---

## 4. STAGING / PROD-OPS (Josh-gated, staging-first)

- **Layer A code (preflight extension + spawn-path degrade read) is safe to build/test off-fleet**, but the degrade behavior touches how LIVE agents spawn. **Validate the degrade path without a real depletion:** add a `--simulate-degrade` dry-run to preflight that writes the marker to a temp path + a `CTX_FORCE_DEGRADE=1` test env the spawn path honors, run against ONE opted-in throwaway agent, confirm it launches on OpenCode/`glm-4.7-flash`, then confirm clearing the marker returns it to Anthropic. Prove the round-trip before enabling fleet-wide (`feedback_agents_claim_live_without_verifying_deploy` — verify the running artifact, not the diff).
- **Redistribution (§3.2) is Josh-gated per agent.** Each move is a live config edit + single-agent restart. Surface the specific diff (which crons move to opencode, which agents get `degrade_ok`) to Josh before applying. Never move an agent's model without his OK — this is a behavior change to a running agent.
- **The `opencode` agent taking on bulk crons** must be validated: fire each relocated cron once on opencode and confirm SILENT-OK / correct output before decommissioning it from the Anthropic host (`feedback_proactive_fix_dont_wait_for_josh_to_spot` — confirm each cron fires on its new home). Move crons one host at a time, not all at once.
- **No merge to main without Josh approval** (`larry/CLAUDE.md` hard rule). One cortextos PR for Layer A; redistribution is config-only and applied incrementally under Josh's eye, not in the code PR.
- **OpenRouter key:** confirm `OPENROUTER_API_KEY` is present in the daemon's process env before relying on it as failover; add it to the failover-capable agents' `required_env` so WS4 reconcile flags it if it ever disappears (§2.6). Do NOT hardcode the key anywhere; it stays env-only (`reference_opencode_openrouter_setup`).

---

## 5. FILES TO TOUCH (tight)

New:
- `orgs/clearworksai/agents/larry/reference/model-routing-rubric.md` — the rubric + chain doc (§3.1). Doctrine only, no behavior.
- `tests/unit/daemon/degrade-spawn.test.ts` — pins the Layer A spawn-path degrade logic (§6).

Edit (additive only):
- `orgs/clearworksai/agents/larry/scripts/credential-preflight.py` — add OpenRouter registry entry (§3.3.3), write/clear `fleet-degrade.json` on Anthropic ALERT_FAIL/ALERT_RECOVER, emit `fleet_degraded`/`fleet_recovered` events, `--simulate-degrade` dry-run.
- `orgs/clearworksai/agents/larry/scripts/test_credential_preflight.py` — cover the new degrade-marker + OpenRouter classification paths.
- `src/daemon/agent-process.ts` — in the `claude-code` launch-arg branch (feeding `agent-pty.ts:261`), read `state/fleet-degrade.json` + the agent's `degrade_ok` flag and substitute cheap runtime/model when degraded (§3.3.2). The single new code path.
- `src/types/index.ts` — add optional `degrade_ok?: boolean` to the agent config type (near `model?` at `:167`). Optional field, default-absent = no degrade.
- `orgs/clearworksai/agents/{larry,frank2,muse}/config.json` — add `"degrade_ok": true` + `OPENROUTER_API_KEY` to `required_env` (Josh-gated, applied incrementally in §3.2/§4, NOT in the code PR).

Explicitly OUT of scope (do not touch): `CronEntry` type / cron scheduler / `spawn-worker` (per-task routing is deferred, §3.4); the codex/opencode PTY adapters (they already honor `model`); WS4 `reconcile.ts` (it already handles `required_env`, we only add a key to a config); any fleet-wide model migration.

---

## 6. TEST PLAN

- **`tests/unit/daemon/degrade-spawn.test.ts` (new)** — the core Layer A guarantees, so they cannot silently regress:
  - marker absent → a `claude-code` agent launches with its configured `--model <claude-*>` (no change).
  - marker present + agent `degrade_ok:true` → launch args become the cheap OpenCode runtime + `glm-4.7-flash` (degraded).
  - marker present + agent has NO `degrade_ok` → NOT degraded (conservative default holds).
  - marker cleared → next spawn returns to the configured Anthropic model (self-heal round-trip).
- **`test_credential_preflight.py` (edit)** — pins the detector→degrade wiring:
  - Anthropic 2nd-consecutive `DEPLETED` → writes `fleet-degrade.json` + emits `fleet_degraded`; `ALERT_RECOVER` → clears it + emits `fleet_recovered`.
  - OpenRouter probe classifies OK / INVALID / DEPLETED correctly (mirrors the existing anthropic/openai `classify_probe` tests).
  - **"no failover path" branch:** Anthropic DEPLETED **and** OpenRouter DEPLETED → marker NOT written, alert says manual-intervention.
  - `--simulate-degrade` writes to a temp marker without touching live state (dry-run honesty).
- **Rubric doc** — no test; it is reference. A lightweight assertion that `model-routing-rubric.md` exists + names the 5 tiers can guard against accidental deletion, optional.
- **End-to-end proof (manual, staging-first per §4):** simulate degrade on one throwaway opted-in agent, confirm via a fresh (truncated) log read that it launched on OpenCode, clear, confirm it returns to Anthropic. Do NOT claim WS8 live off the diff (`feedback_agents_claim_live_without_verifying_deploy`, `feedback_verify_via_truncated_log_not_stale_tail`).
- **Gate:** `npm run build` clean + `npm test` green.

---

## 7. RISKS + OPEN QUESTIONS

**Risks:**
- **Degrading to a materially weaker model mid-mission could produce worse output than the agent's peers expect.** GLM-4.7-Flash is fine for heartbeats/monitoring but NOT for Opus-grade adversarial review. Mitigation: `degrade_ok` is opt-in and conservative-default; the alert explicitly says "reasoning quality reduced"; larry (the reviewer) should arguably NOT be `degrade_ok` at all — a depleted larry pausing may be safer than a GLM larry approving a PR. **Recommend: degrade_ok on frank2/muse (keep the fleet responsive to Josh) but NOT larry (never let a downgraded model approve a merge).** Confirm with Josh (Q1).
- **Failover to a tier that is also down.** Handled by the OpenRouter probe (§3.3.3) — but if BOTH are down the fleet still can't reason; WS8 makes that state *visible and honest*, it cannot conjure capacity.
- **The spawn-path edit touches the hot path (`agent-process.ts`).** A bug here affects every agent launch. Mitigation: the change is read-only + guarded by an absent-by-default marker + a per-agent opt-in flag, so the default path is byte-unchanged; the test suite pins the no-marker case as identical to today.
- **Relocating crons to the opencode agent changes their execution model** (a Sonnet-written fleet-activity digest may read differently written by kimi/GLM). Mitigation: move one cron at a time, validate output quality per §4, keep the *voice/writing* crons (muse) on Sonnet — only the *mechanical* ones move.
- **Conflict-bomb avoidance:** Layer A is one code path + one script + additive types/tests. It shares no files with WS9/WS5/WS10/WS2/WS12. It can ship as an isolated PR (per the `00-planning-synthesis` isolation discipline).

**Open questions for Josh:**
- **Q1 (which agents are `degrade_ok`?):** My recommendation — frank2 + muse YES (stay responsive on cheap tier during a depletion), larry NO (never let a downgraded model approve a merge or run adversarial review; a paused larry is safer than a GLM larry). codexer/opencode N/A (already non-Anthropic). Confirm.
- **Q2 (cheap failover model):** `z-ai/glm-4.7-flash` (~$0.46/M, cheapest, tool-calling ✓) vs the current `openrouter/moonshotai/kimi-k2-thinking` vs GLM-5.2 (1M ctx, pricier)? The openrouter brief flags "GLM-5.2 for reasoning or Flash for cost-cutting?" as an open Josh question. My read: Flash for the degrade tier (it's a survival mode, not a quality mode).
- **Q3 (redistribution appetite now?):** Josh ruled "failover-only for now." Ship Layer A alone, and treat §3.2 redistribution as a documented menu to pull from later? Or does he want the single high-leverage move (bulk crons → opencode agent) done now too, since it's the actual anti-concentration fix and would have prevented this morning's outage?
- **Q4 (Fable adoption):** add `claude-fable-5` as larry's long-horizon planner now (capability add, still Anthropic), or defer? It does not help concentration, so it's independent of the failover work.
- **Q5 (auto-restart on degrade):** should preflight itself issue the per-agent `cortextos restart` on `fleet_degraded`, or only alert larry and let larry restart (keeps a human-agent in the loop, but slower to recover)? Auto is faster; larry-mediated is safer.

---

## 8. EFFORT + PIPELINE

**Effort: S–M.** Layer A (the must-ship) is a **small, additive change**: one new spawn-path read (guarded, default-off), one preflight-script extension (marker + OpenRouter probe + events), one optional config field, plus tests — a single cohesive feature in the cortextos repo. That is **S** and routes as **`one-big-feature`** (single repo, single feature), which satisfies `gate-codexer-planning.sh`. The rubric doc (§3.1) is a larry-authored reference (no pipeline). The redistribution (§3.2) is **not a build** — it's Josh-gated config edits applied incrementally under §4. It rises to **M** only if Josh wants §3.2's crons-→-opencode relocation done in-scope now (each relocated cron needs a validate-on-new-host pass). **Does NOT need full M2C1** — no schema migration, no multi-repo, no net-new subsystem. The Josh-gated / staging-first steps are: the simulate-degrade validation, each `degrade_ok` config edit, and each cron relocation.

---

## AMENDMENT 2026-07-04 (Josh-confirmed) — supersedes single-cheap-model design

1. **Degrade by ROLE, not one `cheap_model`.** The `fleet-degrade.json` marker carries a role→model map, and each `degrade_ok` agent picks by the KIND of work it does:
   - frank2, muse (reasoning/judgment) → `openrouter/z-ai/glm-5.2` (reasoning tier)
   - mechanical crons → `openrouter/z-ai/glm-4.7-flash`
   - larry = NOT degrade_ok (never let a downgraded model approve a merge / run adversarial review)
   Marker shape: `{ "anthropic":"DEPLETED","since":<iso>,"degrade_map":{"reasoning":"openrouter/z-ai/glm-5.2","mechanical":"openrouter/z-ai/glm-4.7-flash"},"failover_runtime":"opencode" }`. Each `degrade_ok` agent config gains `degrade_tier: "reasoning" | "mechanical"` so the spawn path knows which map entry to use.
2. **opencode is a MULTI-MODEL harness — do not flatten to one model.** dynamic-pipeline.js stages pin per task-type (verified-real OpenRouter slugs 2026-07-04): research/grounded-search=`openrouter/google/gemini-3.5-flash`; cheap-impl=`openrouter/deepseek/deepseek-v4-flash`; mechanical=`openrouter/z-ai/glm-4.7-flash`; reasoning=`openrouter/z-ai/glm-5.2`. The opencode AGENT's own default `model` (its heartbeat/monitoring crons) = glm-4.7-flash.
3. **Do NOT physically relocate credential-coupled crons to opencode.** Confirmed daily-trending-repos needs frank2's BRIEFS_* env (absent from opencode). Failover = in-place model swap on the host agent (keeps its .env/scripts/memory), NOT a cron move. Only self-contained mechanical crons may relocate.
4. dynamic-pipeline.js net changes: ADD cheap non-Anthropic research stage (Gemini); implement stage Fable→Codex; merge stage Sonnet→Haiku 4.5; research→Gemini; cheap-impl→Deepseek.
