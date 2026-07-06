# System Audit — instructions / skills / automations / prompting (2026-07-04)

_Requested by Josh (/btw). Grounded in: 289 feedback + 55 project + 76 reference + 9 incident memory files, global+project CLAUDE.md/PRIME, ~150 skills, 82 live crons, the hooks, and the WS8/WS5 build session. Ran on Opus (fork side-thread couldn't spawn Fable); a parallel Fable pass is in flight and any distinct findings will be folded in._

## Grades

**1. Instructions — C+.** Hook-enforced rules (PRIME: staging-marker, no-direct-main, tasks-before-code) actually hold. But 289 feedback memories is scar-tissue, not a knowledge base. Rules live as prose, followed inconsistently; contradictions exist (global CLAUDE.md says "claude-3-5-sonnet primary" while fleet runs Sonnet-5/Opus-4.8; "Never write to Downloads" sits at equal weight to 40 client rules). Signal drowns → agent re-violates → rule #290.

**2. Skills — C.** ~150 registered, THREE competing frameworks live at once (m2c1 "spine", gstack toolkit, gsd "legacy" but 40+ `gsd:*` still loaded). Heavy overlap: `code-review`/`review`/`simplify`/`design-review`/`plan-*-review`; multiple `visual-explainer:*`; `security`/`security-ops`/`security-review`/`cso`/`agent-security-audit`. Vague triggers → model guesses. All of it is per-session context load.

**3. Automations — C−.** 82 live crons, fragile in the ways this session exposed: silent-fail (WS5's whole reason — ingest exits 0 on total failure), duplicate crons (`daily-wiki-prep` on frank2 AND larry racing one state file; `morning-digest` on muse AND scout; `theta-wave` on frank2 AND sage), config-vs-live drift (CLI reads one cron path, daemon writes another — can't manage live crons via CLI). Volume outrunning observability.

**4. How Josh prompts / designs — C.** Instinct is elite (capture every correction as a durable file). Mechanism doesn't scale: fixes INSTANCES with memory rules instead of CLASSES with structure. Proof — same class, reworded, each a separate file: `agents_claim_live_without_verifying_deploy`, `blocked_on_us_verify_before_flag`, `verify_git_state_before_claiming`, `verify_links_before_sending`, `dont_overclaim_single_signal_diagnosis`, `check_sent_before_flagging_commitments`, `check_crm_before_surfacing_contact`. Seven files, one missing gate.

## Top 5 fixes (impact ÷ effort)

1. **Turn top correction-CLASSES into hooks, then delete the rules they replace.** "Verify-before-claim" is ~7 memory files → one PreToolUse/Stop gate that blocks a "live/shipped/done" claim without a fresh check in the same turn. Highest leverage in the system.
2. **Fix the CLI↔daemon cron path** (our own open bug). Until fixed, every automation edit is blind — can't trust `list-crons` or safely `add-cron`. Prerequisite for trusting layer 3.
3. **Kill duplicate crons + add "one owner per cron-name" lint.** De-dup `daily-wiki-prep`/`morning-digest`/`theta-wave`; reconcile check so a dup can't reappear.
4. **Collapse 3 frameworks → 1, prune skills ~150→~60.** Retire `gsd:*` from loaded set, dedupe review/design/security clusters. Shrinks context, stops guessing.
5. **Add a MEMORY.md weight tier.** 289 flat rules can't be honored → ~15 "always-enforced" (ideally hooks) vs long-tail "recall-on-relevance." Already at the 408-line/45KB warning.

## Prompt-design diagnosis — 3 systemic patterns

- **Correction-as-memory instead of correction-as-structure.** Before: failure → `feedback_X.md` → recurs reworded → `feedback_X2.md`. After: failure → "instance or class?" → class → hook/gate/schema, instance → memory. Policy: **"the 2nd occurrence of a class is a code/hook fix, not a 3rd memory file."** (Promote `feedback_fix_once_dont_narrate_recurring_bugs` from advice to policy.)
- **Prose rules where a schema/default would enforce.** Half the CRM/routing corrections (`crm_agent_owns_crm`, Marcos-to-hunter ×3, `check_crm_before_surfacing`) want a DATA CONSTRAINT: `crm_authoritative` default (WS9-A) + owner field make the wrong action impossible, not discouraged. Before: "remember not to route Marcos to hunter." After: hunter's intake rejects CRM-owned contacts.
- **Live-state assertions without a live read.** Most expensive pattern — agents narrate "live/fixed/deployed" off the diff or a stale tail. Before: "restarted, it's on the new model." After (what this session did): restart → `status` shows PID+uptime+model → confirm fresh log → then claim. Make the sequence the gate, not the habit.

## If you change only ONE thing

**Stop growing MEMORY.md as the enforcement layer.** Every rule that's really an invariant (verify-before-claim, one-owner-per-cron, no-physical-move-of-credential-coupled-work, tasks-before-code) becomes a hook or schema default; the corresponding feedback files get deleted. Trade 289 hope-they-read-it rules for ~15 can't-violate-them gates — and the correction count stops climbing, which is the real measure of whether the system is getting more reliable or just more documented.

---

## → CONVERTED INTO ROADMAP (Wave 5: audit-driven structural fixes)
- **WS-A1 verify-before-claim hook** — PreToolUse/Stop gate blocking "live/shipped/done/deployed" claims without a same-turn fresh check. Retire ~7 feedback_*verify* files on land.
- **WS-A2 cron-path fix** — reconcile CLI reader path with daemon writer path (the open WS7 follow-up bug). Unblocks all cron management.
- **WS-A3 one-owner-per-cron lint + de-dup** — remove duplicate daily-wiki-prep (WS5 does this) / morning-digest / theta-wave; add reconcile guard.
- **WS-A4 framework+skill prune** — retire gsd:* from loaded set, dedupe review/design/security skill clusters (~150→~60).
- **WS-A5 MEMORY.md weight tiering** — split always-enforced (→hooks) vs recall-on-relevance; enforce the "2nd occurrence of a class = code fix" policy.

---

# FABLE PASS (authoritative — the real Fable-5 run; supersedes the Opus stand-in above where they differ)

## Grades: Instructions C- · Skills D+ · Automations C- · Prompting B-

## Sharpest evidence (that the Opus pass missed)
- **larry/CLAUDE.md self-contradiction:** lines 100-109 (SCOPE_VALIDATION "always-ask, wait for confirmation before dispatch") vs lines 26-31 same file ("ONLY real gates… do NOT need Josh between steps") + `feedback_dispatch_dont_ask`. Told to always-ask AND never-ask, 70 lines apart.
- **Stale facts in highest-priority files:** larry/CLAUDE.md:9 "Model: claude-sonnet-4-6" (handoff says Opus); line 153 "Cron Summary (8 active)" — live has 17; global CLAUDE.md "claude-3-5-sonnet, OpenAI embeddings" — fleet is Sonnet-5/Opus + Gemini embeddings.
- **The inert-cron bug is still wired into boot:** frank2/CLAUDE.md step 6 + muse/CLAUDE.md step 4 say "Restore crons from config.json" — the exact instruction `feedback_cortextos_config_cron_inert` proves killed the wiki cron 3×. larry's AGENTS.md was fixed; frank2/muse still boot with it.
- **Divergent cron stores live NOW:** frank2 has 24 crons in `cortextos1` vs 30 in `default`. Whichever the daemon isn't reading is a graveyard that still looks configured (silent-fail surface).
- **frank2 cron bloat:** 24 crons; 5 overlapping scanners (comms-check 15m, check-approvals 2h, meeting-commitments 2h, transcript-scanner 2h, human-tasks-check 4h) — the reworded-dupe 3-pings/33min incident is the direct product of a 15m LLM re-summarizer with no durable state.
- **Skills D+:** ~222 entries; 60 gsd:* loaded despite "GSD is legacy, do not start"; 4 codebase-memory-* skills each demanding "ALWAYS invoke instead of Grep" (colliding triggers).

## Fable's 4 systemic patterns → structural fix
1. **Corrections stored where violators can't read them.** Marcos 3×, Tima 15 days, config-crons 3×: corrections go to feedback_*.md but violations come from ephemeral Haiku workers + cron prompts that never load memory. → A correction isn't closed until it names its ENFORCEMENT POINT (skill-file line / hook / denylist / code). Memory = changelog only. Weekly cron flags any feedback file with no enforcement artifact.
2. **Claims without artifacts.** → Promote WS2 send-guard (554fc87, warn-only) to BLOCKING: any outbound with live/fixed/shipped/deployed or a URL requires an evidence check (curl 200 / dist mtime>source / PR merged) at the send chokepoint.
3. **Session context used as durable state.** (human-tasks double-send, restart-clears-inbox). → add-cron lint: any cron that sends to Josh must declare a file-based dedup/state key or be silent-log-only.
4. **Fixes applied at the wrong layer.** (byte-hash dedup vs message-id; substring alerts on TUI scrollback; sync-board over CRM). → adversarial-review standing question: "what is the identity-bearing unit, and does the fix key on it at the source of truth?"

## Fable "change ONE thing": make outbound Telegram a BLOCKING evidence-checking gate.
Every failure Josh feels (triple pings, dead links, false "live," list re-dumps) exits through `cortextos bus send-telegram`. One deterministic gate at that one path converts the whole "worker discipline" problem into a systems property. WS2 warn-only is already merged — finishing it is days.

## RECONCILED verdict (both passes agree)
Enforce invariants at CODE CHOKEPOINTS, not prose. Opus: stop using MEMORY.md as enforcement. Fable: the send-chokepoint is THE chokepoint. Same conclusion, Fable's is the most actionable next step.
