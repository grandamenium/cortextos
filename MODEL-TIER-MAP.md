# Default Model-Tier Map (decide-once)

*By Valor (analyst), 2026-06-05. A standing default that eliminates the per-install/per-re-tier founder model-decision (the ~6-touch tier-oscillation cluster measured on MFL). Set once, sign off once, and every new install + every re-tier inherits it — zero founder tier-calls. Companion to drafts/model-mix-default.proposal.md and drafts/mfl-p1-retier-spec.md.*

## Why this exists

Today's MFL re-tier took ~6 founder-relayed model-tier decisions (the Opus-vs-Sonnet-vs-kimi oscillation) — an **eliminable** founder-touch cluster. The fix is a **decide-once default**: a standing role→model map so agents boot at the right tier by construction, and the founder approves the *map* one time instead of the *tiers* every install. This is the delivery-throughput cycle "templatization" lever applied to model selection.

## The default map (role → model)

| Agent role | Default model | Rationale |
|---|---|---|
| **orchestrator / boss** | **Opus** (APPROVED permanent) | Coordination/cascade point — the one heavy Opus a Max plan sustains |
| **security-reviewer** | **Opus** (APPROVED permanent) | High-stakes security reasoning |
| **architect** | **Sonnet + Opus-escalate** | Architecture is bursty not continuous — escalate to an Opus worker for a heavy design task; keeps concurrent-Opus at ~2 |
| **analyst** | **Sonnet + Opus-escalate** | Routine monitoring on Sonnet; escalate to an Opus worker for heavy synthesis/theta |
| **dev / backend-dev / frontend-dev** | **Codex** (interim Sonnet) | Coding-strongest AND off the Claude cap; interim Sonnet until the Codex runtime + #6 gate-inversion are verified |
| **tester** | **Sonnet** (Haiku candidate) | Test runs — light |
| **design** | **Sonnet** (Haiku candidate) | Design iteration — light |
| **data-engineer** | **Sonnet** | Data wiring — no Opus reasoning needed |
| **fleet-watchdog / monitoring** | **Haiku** | Pure health monitoring — high-frequency, no reasoning |
| **ops / os specialists** | **Sonnet** | Operational/support |
| **general / unspecified** | **Sonnet** | The lean floor |
| **(kimi-assigned)** | **kimi** | If a Moonshot agent is provisioned |

**Net shape:** ~2-4 Opus permanent (boss + the genuinely-heavy reasoning roles), dev on Codex, the bulk on Sonnet, monitoring on Haiku. Sonnet is the floor; you opt *up*, never default up.

## The decision rule (so it's truly decide-once)

1. **Default by role** per the table — Sonnet is the floor unless the role justifies more.
2. **Opus only for ~2-4 genuinely-heavy-reasoning roles** (boss + architect/security-reviewer). Keep concurrent-Opus small.
3. **Codex for dev** — off the Claude cap; gated on (a) runtime verified for the dev workflow/bus/skills, (b) the #6 cross-model gate-inversion (Codex code reviewed by Claude/kimi, never self-family).
4. **Escalate-on-demand** — a Sonnet agent spawns an Opus worker for a single bounded heavy task; no permanent tier change.
5. **Usage-cliff override** — if real usage data shows an agent is genuinely heavy (hits the work), opt it up; if a "heavy"-mapped agent is dormant, down-tier it. (MFL: the >9k-turn cliff identified the true heavy agents.)

## Two operating notes carried from MFL (so applying the map doesn't silently fail)

- **Cap-survivability:** keep concurrent-Opus to ~2-4. MFL evidence: 11-12 concurrent Opus = a rate-limit storm (429/529 bursts); dropping to ~4 cleared it. Opus-by-default does not scale on a subscription.
- **The apply-mechanism (silent-no-op trap):** a model change only lands on a **fresh** session — sticky long-lived sessions keep their old model after a soft-restart. So applying this map to a *running* fleet requires force-freshing the heavy agents (it couples with session-recycle). A config edit alone *looks* applied but silently no-ops on exactly the most expensive agents.

## Cost interaction (the unit-economics asterisk)

Model tier interacts with the **dedicated-seat-vs-shared-subscription** decision: Opus-heavy + a *shared* subscription = rate-limits bite faster as customers stack. This lean default reduces that pressure. The shared-vs-dedicated-seat call becomes a real pricing/margin decision around customer #3-5 (a one-time policy threshold, not a per-customer touch).

## How it eliminates the founder-touch

With this map as the **framework/org default** (`default_model` per role in the org config + agent templates), a new customer install — or any re-tier — applies it **automatically**. No founder per-agent model decision. The founder's involvement collapses to **one-time sign-off on this map** (model choice is a cost+quality call that's legitimately the founder's), not a per-install tier debate.

→ **This is the ~6-touch tier-oscillation cluster driven to ~0, by construction.** Bonus: it's the standing answer that would have prevented today's model-mix thrash entirely.

## Sign-off — APPROVED (Bode, 2026-06-05)

**Bode signed off:** `boss` + `security-reviewer` are the only **permanent-Opus** roles; `architect` runs Sonnet+escalate. This is now the **standing default** for the fleet + every customer install + every re-tier. Concurrent-Opus baseline = ~2.

This map is the active default. The ~6-touch per-install/per-re-tier model-tier decision is now eliminated by construction — a one-time sign-off replaced a recurring founder-touch cluster.
