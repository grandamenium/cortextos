# Agent Starter Kit — Packaging Skeleton

Draft v0.2 — 2026-07-27. Source: 427 entries in `orgs/atlasos/LESSONS.md`, plus the
cortextOS incident record. Every control below traces to a real failure, not a guess.

## Decisions locked (Jennifer, 2026-07-27)

1. **Target customer:** works for both, but assume **mostly solo operators**. Team support
   should degrade gracefully, not drive the design.
2. **Ships as one agent at Level 0**, earning its way up. Growth to a fleet is a **return
   engagement**, not part of v1.
3. **v1 non-negotiable controls — the irreducible four:** outbound gate, clock, task ledger,
   readiness-not-liveness. The other six are documented but deferred to v2.
4. **Runs on the customer's own machine. No hosting choice at v1.** Hosted/always-on is a
   growth-engagement upsell. The choice customers *do* get is **model tier** (cheap model
   for routine work, strong model for thinking) — same architecture, directly answers the
   cost fear, one config value instead of a second product. See Part 6.

These three decisions simplify the product substantially. Most of the cortextOS pain came
from many agents acting at once — a single Level-0 agent cannot produce the fleet-scale
failure modes (cross-agent relay laundering, boot-message storms across 8 agents, two
pollers deadlocking one credential). Shipping one agent removes those by construction
rather than by control.

---

## Part 0 — Where guardrails live (architecture decision)

**Jennifer's proposal:** all fundamental guardrails live centrally, and only the ones
that pertain to a specific agent roll down to it.

**Verdict: right instinct, wrong axis.** The useful split is not central-vs-local.
It is **enforced vs. advisory**.

The evidence: "do not message Jennifer before reading GUARDRAILS.md" was written down,
then violated 12 more times across at least 8 agents. Tis violated it, a lesson was
written, Tis violated it again the next day. A guardrail that an agent must *read and
honor* fails no matter which directory it lives in. Moving it to the orchestrator and
rolling it down is still an instruction-distribution model.

So, three tiers:

| Tier | What it is | Where it lives | Agent can violate it? |
|---|---|---|---|
| **0 — Enforced** | Outbound sends, destructive writes, credential use, spend | Runtime/daemon, *not* in any agent's context | No. Structurally impossible. |
| **1 — Universal** | ~10 short fundamentals, identical for every agent | One canonical file, injected verbatim | Yes — so keep it short |
| **2 — Specific** | Role rules (Ledger's close process, Timber's property scope) | Agent directory | Yes |

**Two corrections to the roll-down model:**

1. **Default-on, explicit exemption.** Do not roll fundamentals down "where they
   pertain" — someone has to judge relevance, and that judgment is where gaps appear.
   The boot-message rule hit 8 agents; a relevance filter would have missed some of
   them. Fundamentals apply to every agent unless a written exemption exists.

2. **No local editable copies.** cortextOS already shows the drift failure mode twice:
   skill-file proliferation, and `list-crons` reading a different path than the daemon
   (so CLI edits silently didn't apply). The canonical fundamentals file is read-only
   to agents and hash-checked at boot. If the hash doesn't match, the agent does not start.

**Design rule for the course:** if a fundamental can only be expressed as an instruction,
it is not a fundamental yet. Push it down to Tier 0 or accept that it will be violated.

---

## Part 1 — The ten Tier-0 controls

Each: the failure it prevents → where it is enforced → what ships.

**v1 ships 1, 3, 5, 10 (marked ✅). Controls 2, 4, 6, 7, 8, 9 are v2 (marked ⏸).**

Why these four are the right cut for a solo operator with one agent: each prevents a
failure that is either *invisible* (task ledger, readiness) or *irreversible* (outbound
gate, clock-driven mistakes). The deferred six mostly prevent failures that are visible
and recoverable, or that need a fleet to occur at all.

*If you ever want a fifth, make it **#6 source discipline**. It is the one deferred control
that gets **more** relevant with a single agent, not less: with no second agent to launder
a claim through, the remaining failure is the agent citing its own stale note back to the
user as fact — and a solo operator has nobody else to catch it.*

**1. Outbound gate.** ✅ **v1**
Prevents: sending email/text/DM without authorization (~45 lessons — the largest category).
Enforced: runtime mediates every send; the agent has no direct transport credential.
Ships: approval queue + a deny-by-default policy file.
*Note: an approval store the agent can write to is forgeable. The gate must be held by
a process the agent cannot reach.*
*Solo note: this is also the control that makes the product safe to sell. A customer's
first agent sending something embarrassing on their behalf is a refund and a bad review.*

**2. Boot lifecycle lock.** ⏸ v2
Prevents: acting before rules are loaded (12 recurrences).
Enforced: transport disabled until the guardrail hash check passes.
Ships: boot sequence with a hard "no outbound during bootstrap" phase.
*Deferred because with the outbound gate (#1) in place and a single agent starting at
Level 0, a premature boot message has nowhere to go. Revisit when agents reach Level 3+.*

**3. Clock tool.** ✅ **v1**
Prevents: inferred time, UTC-read-as-local, day-of-week guessed from a cron name (~29).
Enforced: the injected session timestamp is a photograph, not a clock — it is correct at
session start and silently wrong hours later. Agents must call a clock tool.
Ships: `get_time` tool + cron-timezone documentation.

**4. Destination map.** ⏸ v2
Prevents: filing to the wrong Drive, sending from the wrong address.
Enforced: pre-write destination check against a declared map.
Ships: `FILING-MAP.md` generated during intake.
*Cheap partial win for v1: intake already collects the map (Part 2), so ship the file even
without the enforcement check. A solo operator usually has one Drive and one sending
address, which is why this drops out of the v1 four.*

**5. Task ledger.** ✅ **v1**
Prevents: dropped commitments (the $300 transfer that never resurfaced).
Enforced: capture every "I need to X"; agents may never auto-complete; a fired-and-acked
reminder is explicitly *not* a completed task.
Ships: task store + stale-task sweep.

**6. Source discipline.** ⏸ v2 — *the one I'd promote first*
Prevents: an agent's own notes cited as evidence (~24) — memory relayed as
primary-verified, "confirmed" in a memo manufacturing authority, circular relay.
Enforced: claims carry a source type; agent-authored artifacts cannot be marked Verified.
Ships: source-tagging convention + a Verified label with rules.
*Cross-agent laundering disappears with one agent, but self-laundering does not — and a
solo operator has no second pair of eyes. This is the strongest candidate for a fifth v1
control if scope allows.*

**7. Consumer propagation.** ⏸ v2
Prevents: a corrected value leaving subtotals, prose, and boot files wrong (~30 — nearly
the biggest category, and the one most often missed).
Enforced: correcting a value requires grepping its consumers; a rebuild regenerates errors
unless the correction lives upstream.
Ships: correction checklist + consumer-scan helper.

**8. Human-artifact write protection.** ⏸ v2
Prevents: overwriting hand-entered work; accidental live-sheet edits; two writers in one
active artifact.
Enforced: human-edited ranges are declared and read-only; single-writer lock.
Ships: protected-range registry.
*The "two writers" half is moot with one agent. The "overwrote hand-entered work" half is
not — keep it on the v2 shortlist.*

**9. Cost governor with safety carve-out.** ⏸ v2
Prevents: cap burn (cron sprawl was the real driver, ~90 enabled) **and** the second-order
failure where a usage-conserve pause silenced the alerting crons.
Enforced: cron budget + a protected set that pausing can never disable.
Ships: cron inventory report + carve-out list.
*One agent with a handful of crons cannot reproduce ~90-cron sprawl. But customers pay
their own model bills, so ship a visible usage readout in v1 even without the governor —
a surprise bill is a churn event.*

**10. Readiness, not liveness.** ✅ **v1**
Prevents: mechanisms that can only report success (~13). Live example: `status` reported
forge "running" while its Telegram poller was dead; autostart failed with no trace.
Enforced: health checks assert the critical subsystem, not the process; every scheduled
job writes a verdict (SUCCESS/FAILED/BAILED) with a reason.
Ships: health-check pattern + run-log convention.
*Solo note: this is commercially load-bearing, not just technical. With one agent there is
no fleet to mask an outage — if their agent dies quietly, the product is simply "broken"
and they churn without filing a bug. A customer must be able to tell working from dead at
a glance.*

*Adjacent, cheap, worth including even in v1:* never compose message bodies through shell
strings (dollar-signs ate dollar amounts; a nonexistent `--stdin` flag shipped a garbled
message). The two-consumers-on-one-credential failure (one bot token, two pollers =
permanent deadlock, live outage 2026-07-26) is a fleet problem and can wait for v2 — but
note it now, because it reappears the moment a customer returns for growth.

---

## Part 2 — The onboarding agent (structured intake)

The front door, and the thing that made ChatGPT feel like it understood her. The insight:
**intake is not a conversation, it is a form that writes config.** Every answer lands in a
specific artifact the runtime reads. Unstructured intake is why it took months to surface.

**Solo-operator shaping:** blocks marked **core** run for everyone. Blocks marked *team*
are asked only if the user says they have people — a solo operator should never be walked
through a team roster to get started. Note that solo does **not** mean single-entity: the
"which hat" confusion is a solo failure mode too (a side business, an LLC, a personal
account), so entities stays core, just short.

| Intake block | Captures | Writes to |
|---|---|---|
| Identity & entities **(core)** | Businesses, which hat owns what, entity names that look alike | `ENTITIES.md` |
| People *(team)* | Team, roles, who may be contacted, who must never be | `PEOPLE.md` |
| Channels & authority **(core)** | Which address sends what, to whom, under which approval | `COMMS-POLICY.md` |
| Goals **(core)** | Time-boxed outcomes, current priorities | `GOALS.md` |
| Core values & decision rules **(core)** | What to optimize, what to refuse | `VALUES.md` |
| Working style **(core)** | CliftonStrengths, energy curve, focus/context-switch tolerance | `WORKING-STYLE.md` |
| Calendar architecture **(core)** | Briefing slot, deep-work blocks, meeting windows, sleep, buffers | `CALENDAR-POLICY.md` |
| Family & boundaries **(core)** | Do-not-disturb, non-negotiable commitments, priorities | `BOUNDARIES.md` |
| Data map **(core)** | Where things live, where new things go | `FILING-MAP.md` |
| Risk thresholds **(core)** | Dollar limits, external-comms rules, what always needs a human | `APPROVALS.md` |

**Design notes**
- Ask in passes, not one sitting. Pass 1 is the minimum to be useful; later passes deepen.
- Every answer gets a confidence and a date. Preferences drift; stale preference read as
  current fact is the same failure class as a stale number.
- The agent must be able to say "I don't know that about you yet" rather than infer.
  Inferring the principal's intent from thin evidence is exactly the overclaim pattern.
- CliftonStrengths is a good spine for *tendencies*, but habits are observed, not declared —
  track them and reflect them back rather than trusting the intake answer forever.

---

## Part 3 — Capability ladder (progressive trust)

Directly implements "read emails, graduate to writing and sending them."

| Level | Can do | Gate to advance |
|---|---|---|
| **0** | Read email, read calendar, summarize | Clean summaries; no fabricated detail |
| **1** | Draft — creates drafts, never sends | N drafts accepted with light edits |
| **2** | Send to the principal only | No misroutes at L1 |
| **3** | Send external, per-message approval | Sustained accuracy; correct address selection |
| **4** | Send external within standing policy | Explicit written promotion — never automatic |

Rules: promotion is a human decision; demotion is automatic on a violation; the ladder is
per-capability (an agent can be L4 for calendar and L1 for email).

**Ships at Level 0, always.** No customer's agent starts with send rights, regardless of
how confident they are during setup. The ladder is the product's safety story *and* its
engagement loop — earning L1 is the first win, and it happens in week one.

**Growth is a return engagement.** When one agent is no longer enough, that is a second
sale, not a v1 feature. Signals a customer is ready: sustained Level 3+, more than a few
crons, or asking for two roles that need different standing permissions. Everything
deferred to v2 above (source discipline, consumer propagation, cost governor, credential
separation) is what the growth engagement installs — the fleet-scale failures are exactly
the ones a second agent reintroduces.

---

## Part 4 — Documents and brand

- Brand kit captured at intake (colors, type, logo, tone) → `BRAND.md` + templates.
- **Render-QA before showing the principal** — check the artifact as rendered, not as
  generated. Three agents once trusted a clean process return on a visual result nobody
  had looked at. A clean API response is not a clean document.
- Templates ship for: one-pager, proposal, meeting brief, invoice/summary.

---

## Part 5 — What actually ships (v1)

1. Runtime enforcing **the four v1 controls**: outbound gate, clock, task ledger,
   readiness-not-liveness.
2. Onboarding agent + the intake schema (Part 2), core blocks only for solo users.
3. One short universal fundamentals file (Tier 1) — target ~10 items, not 427.
4. Capability ladder config, **starting at Level 0**, per-capability.
5. Template pack (documents, calendar policy, filing map).
6. A visible usage/cost readout (not the full governor — just enough that a bill is never
   a surprise).
7. The lesson corpus as **course narrative**, not as agent instructions.

**Explicitly not in v1:** multi-agent anything, boot lifecycle lock, destination
enforcement, source tagging, consumer propagation, write protection, cost governor.
All documented above; all part of the growth engagement.

**The packaging caution:** 427 lessons is the differentiator *and* a trap. The fleet already
proves a large rules file gets skimmed — the 12 repeat violations are what skimming looks
like. Ship ~10 mechanical controls; use the incidents as the stories that sell each one.

---

## Part 6 — Deployment, and the always-on gap

**Decision: local-first.** Three reasons, in priority order:

1. **Only architecture with a knowable monthly ceiling.** A flat-rate subscription on the
   customer's own machine answers "what if it runs away with my money" definitively.
   Hosting means either eating variable cost or billing variably — which reintroduces the
   exact anxiety the product sells against.
2. **No custody of customer credentials or data.** Hosting means holding their email OAuth
   tokens, business structure, and family details. Unacceptable liability for a small
   business, and unnecessary.
3. **Supportability.** You can only support the stack you actually run.

### The always-on gap — a first-class design requirement, not a caveat

A local agent is dead whenever the machine is off, asleep, or logged out. This is not
hypothetical: on 2026-07-26 a shutdown killed the entire cortextOS fleet, the autostart
task failed silently (exit `0xC000013A`, battery policy), and the outage was only found
because someone asked. **Customers will hit this, and they will not diagnose it.**
Expect it to be support ticket #1.

Requirements:

- **R1 — Survive shutdown.** Autostart must be verified end-to-end, not assumed. Port the
  hardened `start-atlasos.ps1` pattern: no battery-policy blocking, retries, a real
  SUCCESS/FAILED/BAILED verdict in a log, and a refusal to restart an already-healthy
  instance. This is existing, tested IP — reuse it.
- **R2 — Catch up on wake, don't silently skip.** Missed schedules while asleep must
  reconcile on resume and say what they missed.
- **R3 — Glanceable health.** The customer must be able to tell working from dead in one
  look. Ties directly to control #10; with no fleet to mask an outage, a quiet death reads
  as "the product is broken" and they churn without filing a bug.
- **R4 — Honest expectation-setting.** Sell it as "your assistant works when your computer
  is on." That fits a solo operator. Overpromising always-on and under-delivering is worse
  than scoping it.

### Known risk

**The installer is the hardest engineering problem in this product — harder than the
agent.** Node, pm2, permissions, and platform traps (a script that parses in PowerShell 7
died silently in 5.1 over file encoding, 2026-07-26). Budget accordingly; see Part 7.

---

## Part 7 — Who helps them get set up

The bootstrap constraint that decides this: **an agent cannot guide its own installation,
because it does not exist yet.** The highest-churn moment — the first sixty minutes — is
precisely when no agent is available to help. This inverts the intuition: agents can do
the part that feels most human, and cannot do the part that is most mechanical.

| Onboarding step | Agent can do it? | Who/what handles it |
|---|---|---|
| Install runtime | **No** — nothing is running yet | Packaged installer (primary), human (bridge) |
| Connect Google/Microsoft OAuth | Partly | Installer opens browser + catches callback |
| Grant permissions | Partly | Guided by installer, customer clicks |
| **Intake conversation** | **Yes — agent-native** | The onboarding agent (Part 2) |
| Troubleshooting while running | Mostly | Self-diagnosis via control #10 |
| Troubleshooting while dead | **No** — it cannot report its own death | Health surface + human fallback |

**Recommendation: invest in packaging, not headcount.**

- A real double-click installer collapses the whole pre-agent phase. This is the difference
  between shipping a product and shipping a repo, and it is where engineering effort pays
  compounding returns.
- **VA cost scales linearly with customers; installer cost is paid once.** For a course sold
  at volume, that math decides it.
- Use a human as a **bridge and as instrumentation** for early cohorts — to learn exactly
  where people get stuck — then engineer those failure points away. A VA that becomes
  permanent staffing is a margin problem disguised as a support strategy.
- For a course specifically, a **live group onboarding call** (one session, many customers,
  screenshared install, recorded) is far cheaper per head than 1:1 VA time and doubles as
  course content.
- **Hard rule:** no helper — VA or otherwise — ever touches customer credentials or their
  agent. They guide a screenshare; the customer types their own passwords. Otherwise the
  custody liability avoided by going local comes straight back in through support.
- Never staff a human against work control #10 should be doing. Routine babysitting is a
  bug, not a job description.

---

## Next questions (v0.2)

Resolved in v0.2: target customer, one-agent-at-L0, the irreducible four, local-first
hosting, and onboarding-by-packaging. Open now:

1. **Does the customer bring their own Claude subscription, or do you resell/bundle it?**
   Local-first settles *where it runs*; this settles *who pays the model bill*. Bring-your-own
   keeps the flat-rate ceiling intact and keeps you out of billing — but adds a signup step
   before they can start, and their plan limits become your support surface.
2. **How does intake actually happen** — a conversation the agent drives, a form, or a
   worksheet they fill before setup? Part 2 says "a form that writes config," but the
   *feel* you described was ChatGPT-style conversational. Those can be reconciled
   (conversation on the surface, schema underneath) but it should be a deliberate choice.
3. **What is the promotion criterion from L0 → L1?** "N drafts accepted" is a placeholder.
   This is the customer's first win, so it deserves a real definition.
4. **Which email/calendar stack do you support at launch?** Google-only is a much smaller
   build than Google + Microsoft, and it decides half the connector work.
5. **Windows only, or Windows + Mac?** Doubles installer work — which Part 7 identifies as
   the hardest problem in the product. Your own experience is Windows.
