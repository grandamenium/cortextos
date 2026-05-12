# Phantom-Endpoint Vector-List Extension — DRAFT

**Filed by:** prospector
**Date:** 2026-05-11
**Status:** DRAFT — awaiting pentester curation on return from posture-hold
**Rationale for DRAFT-state filing:** Pentester is currently halt-holding. Per memory `feedback_peer_agent_posture_changes_need_user_consent`, posting directly into pentester's canonical audit ledger would auto-commission their review during posture-hold. Analyst approved DRAFT-in-prospector-deliverables routing (msg 1778517168198-analyst-0lhdy). On pentester return, they merge this into the canonical ledger with whatever curation pass they apply.

**Decomposition rule applied:** `feedback_audit_root_vs_vector_decomposition` — same ROOT (phantom endpoint: consumer trusts declared capability producer never delivers) with the `docs` vector already in the umbrella's 6-vector list. This is a vector-list extension on the existing 'docs' case, NOT a new umbrella entry.

---

## Case summary

**Phantom:** `mcp__semrush__*` MCP server (multiple tool aliases: `organic_research`, `keyword_research`, `overview_research`, `backlink_research`, `url_research`, `get_report_schema`)

**Vector:** `docs` — capability declared in agent skill documentation, never wired in any MCP config

**Trust position:** 11+ agent skill files across 6 GLV agents reference `Semrush MCP` or `mcp__semrush__*` tool names as if they are available capabilities. The downstream effect is that any agent following these skills attempts to invoke a tool that does not exist in any active `.mcp.json` configuration.

---

## Evidence trail

### Producer side (the declarations)

| # | File | Line | Reference |
|---|---|---|---|
| 1 | `orgs/glv/agents/boss/.claude/skills/onboard/cross-channel/SKILL.md` | 93 | "Use `mcp__semrush__organic_research` and `mcp__semrush__url_research`" |
| 2 | `orgs/glv/agents/boss/.claude/skills/onboard/cross-channel/SKILL.md` | 97 | "Run `mcp__semrush__organic_research` on the client's domain" |
| 3 | `orgs/glv/agents/boss/.claude/skills/onboard/ads/SKILL.md` | 92 | "Use Semrush MCP to pull competitor paid advertising data" |
| 4 | `orgs/glv/agents/boss/.claude/skills/onboard/ads/SKILL.md` | 95-97 | `mcp__semrush__organic_research`, `mcp__semrush__keyword_research`, `mcp__semrush__overview_research` |
| 5 | `orgs/glv/agents/boss/.claude/skills/onboard/ads/SKILL.md` | 108 | "Semrush: `mcp__semrush__overview_research` for their domains" |
| 6 | `orgs/glv/agents/boss/.claude/skills/onboard/analytics/SKILL.md` | — | "Semrush API (keyword_rankings table)" + "Semrush — Required — GLV subscription" |
| 7 | `orgs/glv/agents/boss/.claude/skills/onboard/roadmap/SKILL.md` | — | "Set up Semrush project — GLV — Week 3" + "Semrush — Included in retainer — GLV subscription" |
| 8 | `orgs/glv/agents/boss/.claude/skills/dashboard/SKILL.md` | 32 | "analytics_snapshots — GSC, GA4, Semrush MCPs — Weekly (Mondays)" |
| 9 | `orgs/glv/agents/ads/.claude/skills/campaign-workflow/SKILL.md` | 101 | "Tools used: Semrush MCP (`overview_research`, `keyword_research`, `organic_research`, `backlink_research`)" |
| 10 | `orgs/glv/agents/ads/.claude/skills/campaign-workflow/SKILL.md` | 1261 | "Semrush MCP — Keyword research, organic research, backlinks, site audit" |
| 11 | `orgs/glv/agents/ads/.claude/skills/campaign-workflow/SKILL.md` | 1271 | "Semrush MCP server active" — described as precondition |
| 12 | `orgs/glv/agents/content/skills/campaign-workflow/SKILL.md` | 100, 1260, 1270 | Mirror of ads campaign-workflow trio |
| 13 | `orgs/glv/agents/content/skills/proposal/SKILL.md` | 48, 68 | "Use Semrush MCP tools" |
| 14 | `orgs/glv/agents/seo/skills/chino/keyword-research/SKILL.md` | 157-159 | "Use Semrush MCP" + `mcp__semrush__keyword_research` + `mcp__semrush__get_report_schema` |
| 15 | `orgs/glv/agents/prospector/skills/prospecting/SKILL.md` | 101 | "Tools available: ... Semrush MCP (mcp__semrush__organic_research, mcp__semrush__keyword_research, mcp__semrush__overview_research)" |
| 16 | `orgs/glv/agents/prospector/.claude/skills/verify-claims/SKILL.md` | — | "verify via SEMrush MCP, note the date pulled" |

**Distinct agent skill files referencing semrush MCP:** 11+
**Distinct GLV agents:** 6 (boss, ads, content, seo, prospector, + dashboard surface)

### Consumer side (what actually breaks if you try to use it)

Any agent following the above skill instructions calls `mcp__semrush__*` and receives a tool-not-available / InputValidationError. No `.mcp.json` in the cortextos tree wires the semrush MCP server.

### Producer side (the missing delivery)

Searched `/home/aiden/cortextos` for `.mcp.json` files (excluding `node_modules` and `.claude/plugins/`):
- `find /home/aiden/cortextos -name ".mcp.json" -not -path "*/node_modules/*" -not -path "*/.claude/plugins/*"` → **zero results**
- No `mcp_servers` entry pointing at semrush in any cortextos-side config
- Outside the cortextos tree: only plugin-bundled `.mcp.json` files (firebase, telegram, asana, fakechat, serena) under `~/.claude/plugins/marketplaces/claude-plugins-official/` — none wire semrush

### Compound trust position

In addition to the MCP-server phantom, two skill files also reference a "GLV subscription" / "Included in retainer" for Semrush (boss onboard/analytics, boss onboard/roadmap). Whether GLV actually has an active Semrush subscription — and at which tier — is not verifiable from any agent's surface; it is asserted as fact in docs without a delivery surface (account credential file, dashboard link, last-billing-date attestation, or anything else that would prove the subscription is live).

This is a *secondary* phantom in the same root: declared subscription, no proof of delivery. Vector also `docs`.

---

## Classification per umbrella schema

| Field | Value |
|---|---|
| Root pattern | Phantom endpoint |
| Vector | `docs` |
| Trust-position-via | Skill / capability-list reference |
| Producer | Various agent skill authors (boss, ads, content, seo, prospector) |
| Consumer | Any agent following the skill |
| Failure mode | Tool-not-available at runtime; agent must fall back to manual research or surface gap to user |
| Detection difficulty | LOW — single `find .mcp.json + grep semrush` reveals the gap immediately |
| Blast radius | HIGH — 6 agents × multiple workflows depend on it; cold-outreach verification gate (Category 3+6) is currently degraded because of this exact gap |

---

## How this surfaced

Per cycle-18 batch-1 cold-outreach rebuild post-mortem (2026-05-11), the prospector's verify-claims gate cites "SEMrush MCP" as a verification tool. When the rebuild required city-wide competitor sweeps for Category 6 hooks (Beebe vs Clow Darling, Priest vs Perrotta's), the agent fell back to WebSearch + manual SERP observation because no semrush MCP was wired. Analyst (msg 1778517126521-analyst-hlrbc) flagged the documented-vs-wired delta as a phantom-endpoint instance, classifying it cleanly to the `docs` vector.

---

## Recommendations (for pentester curation)

### RECOMMENDED PRIMARY — Detection gate (long-tail control on whole phantom-endpoint pattern)

A simple CI rule — `if any agent skill references mcp__X__ and no .mcp.json wires server X, FAIL` — would prevent the docs-vector phantom class entirely across the fleet, not just resolve this single case. This is the highest-leverage prevent-future-phantom artifact in the recommendation set: it converts the failure class from "audit catches each instance reactively" to "CI blocks the class at write-time."

Implementation suggestions (for pentester→dev routing on pentester return):
- Community skill or pre-commit hook scanning all `*.md` files under `orgs/*/agents/*/skills/` and `.claude/skills/` for `mcp__([a-z_]+)__` patterns
- Cross-reference matched server prefixes against every `.mcp.json` `mcpServers` key in the repo
- Block any commit where a matched prefix has zero `.mcp.json` wiring
- Allowlist mechanism for skills that intentionally document future-state capabilities (e.g., explicit `<!-- phantom-allowlist: pending-acquisition -->` marker)

This single artifact retroactively prevents every instance of the docs-vector subclass. Strongly recommend pentester surfaces this to dev when off-hold.

### Supplementary — Audit ledger entry

Extend the existing `docs` vector case in the canonical audit ledger with this writeup. Cite trail (11+ references, 6 agents) is the strongest single-case evidence to date for the umbrella pattern. If no `docs` case exists yet, open one with this as the founding worked example.

### Tactical — Resolve this specific case via AM brief Item 9

Aiden's "current SEMrush tier?" answer (queued for AM brief 12:03Z May 12) resolves the path naturally:
- If SEMrush subscription is live + Business tier → wire `.mcp.json` properly. Closes gap for all 6 agents.
- If subscription is Pro/Guru or unconfirmed → escalates the secondary phantom (GLV-subscription-without-delivery-surface) as a separate credential-routing item per `feedback_credentials_routing` (dev→boss→pentester→user chain).
- If no subscription → strip every `mcp__semrush__*` reference from agent skills + replace with "use Semrush dashboard manually" caveats (throughput-degrading but immediate fix).

This tactical resolution is downstream of the AM brief gating question; no separate routing required.

---

## Cross-references

- Umbrella pattern: `~/.claude/projects/-home-aiden-cortextos/memory/project_phantom_endpoint_pattern.md`
- Root-vs-vector rule: `~/.claude/projects/-home-aiden-cortextos/memory/feedback_audit_root_vs_vector_decomposition.md`
- Peer-posture rule (why this is DRAFT not direct-to-canonical): `~/.claude/projects/-home-aiden-cortextos/memory/feedback_peer_agent_posture_changes_need_user_consent.md`
- Cycle-18 worked-example bundle: `deliverables/cycle-18/analyst-surface-package.md`
- Analyst routing approval: msg 1778517168198-analyst-0lhdy
- Surface dispatch: msg 1778517139988-prospector-5qcxd

---

*DRAFT. Awaiting pentester curation on return from posture-hold.*
