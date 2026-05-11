---
name: shared-knowledge
effort: low
description: "Capture cross-cutting findings, decisions, handoffs, and proposals into the org's shared Obsidian vault inbox so any agent can discover them later. Use when you learn something another agent would benefit from. Also: read protocol for checking the inbox before starting non-trivial work."
triggers: ["share knowledge", "vault inbox", "shared knowledge", "log finding", "cross-cutting", "another agent should know", "vault note", "00-inbox", "kb wiki", "knowledge wiki", "handoff note", "postmortem", "proposal note"]
---

# Shared Knowledge Skill

> The vault `00-inbox/` is the org's shared knowledge wiki. Every agent reads from it before non-trivial work and writes to it when they learn something cross-cutting. The daemon's daily `vault-kb-refresh` cron ingests it into the org KB so the same content is also semantically searchable.

---

## When to Write

Rule of thumb: **"Would another agent benefit from finding this in 3 days without me telling them?"** → yes = inbox; no = local `MEMORY.md`.

Write to `00-inbox/` when:
- A finding, decision, or handoff is relevant to ≥1 agent other than yourself.
- A root cause or runbook would save the next agent rediscovery time.
- An architectural proposal needs Sondre's review.
- You resolved a debug with a non-obvious cause (env, runtime, version, infra).
- You confirmed a system invariant (e.g. "Coliseum bots must read P&L from Supabase shadow ledger, never Alpaca balance").

Do **not** write to `00-inbox/` for:
- Per-agent tactical state (goes in `MEMORY.md`).
- Heartbeat updates or daily-memory entries.
- Ephemeral conversation context.
- Anything Sondre already authored — don't shadow his vault notes.
- Raw data dumps (ingest the source file to the KB instead).

---

## Where to Write

**Vault root** (sondre-hq): `/root/storage/Documents/Github/sondres-orchestrator/vault/`

**Path:** `<vault>/00-inbox/<slug>.md`

**Slug format:** `YYYYMMDD-<agent>-<kebab-topic>.md`

Examples:
- `20260506-analyst-coliseum-flock-race-fix.md`
- `20260506-analyst-kb-architecture-recommendation.md`
- `20260506-coliseum-elimination-blocker-handoff.md`
- `20260506-dev-is-sandbox-required-under-cron.md`

The date prefix sorts chronologically, makes promotion to `02-areas/` clean, and prevents cross-agent collisions. On collision: append `-2`, `-3`.

One concept per note. Don't bundle unrelated findings.

If a note on the same topic already exists, **update it** rather than duplicating. Sondre or commander periodically promote notes from `00-inbox/` to `01-projects/` / `02-areas/` / `03-resources/` — that's curation, not agent work. Don't move your own notes; never delete (only Sondre or commander).

---

## Required Frontmatter

```yaml
---
type: note | runbook | finding | handoff | proposal | postmortem | decision | spec
tags: [<area>, <project>, ...]      # required, ≥1 tag, kebab-case
created: 2026-05-06T11:00:00Z       # ISO-8601 UTC
updated: 2026-05-06T11:00:00Z       # ISO-8601 UTC, bumped on every write
status: active | draft | archived
agent: <your $CTX_AGENT_NAME>
session: 2026-05-06T10:45:00Z       # ISO-8601 UTC of your session start (traceability)
relates_to: [<slug>, ...]           # optional cross-refs to other inbox notes
---
```

| Field | Notes |
|-------|-------|
| `type` | `note` general capture · `finding` discovered something cross-cutting (root cause, anomaly, audit) · `handoff` active context for another agent · `proposal` architectural change for review · `postmortem` failure analysis · `runbook` step-by-step ops procedure · `decision` "we chose X over Y because Z" · `spec` contract/schema others must follow. |
| `tags` | At least one. Lowercase, kebab-case. Tag generously — this is how other agents grep. Examples: `coliseum`, `mcp`, `cortextos-upstream`, `infra`, `gotcha`, `invariant`, `incident`. |
| `created` / `updated` | ISO-8601 UTC. Bump `updated` on every write. |
| `status` | `draft` while figuring out · `active` once stable · `archived` if superseded (link to successor). |
| `agent` | Your `$CTX_AGENT_NAME`. So Sondre and other agents know who to ask. |
| `session` | ISO-8601 of your **session-start** time, even if you wrote the note hours later. Lets investigators tie the note back to a specific run for context. |
| `relates_to` | Slugs of related inbox notes. Use bare slug without `.md`. |

This extends the existing `vault/AGENTS.md` schema — the union of types is valid.

---

## How to Write

The vault is a local directory — write the markdown file directly. No Obsidian CLI dependency.

**New note:**

```bash
VAULT=/root/storage/Documents/Github/sondres-orchestrator/vault
DATE_SLUG=$(date -u +%Y%m%d)
TOPIC=is-sandbox-required-under-cron      # kebab-case topic
SLUG="${DATE_SLUG}-${CTX_AGENT_NAME}-${TOPIC}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
umask 022      # so the new file lands at 644 to match existing PARA notes

cat > "$VAULT/00-inbox/$SLUG.md" << EOF
---
type: finding
tags: [cortextos, claude-code, gotcha, cron]
created: $NOW
updated: $NOW
status: active
agent: $CTX_AGENT_NAME
session: $NOW
relates_to: []
---

# <Title — concise, descriptive>

## Context
What you were doing when this came up.

## Finding / Decision / Spec
Lead with the answer. Be specific.

## Why it matters
Who else is affected. What breaks if this is forgotten.

## Links
- [[related-note-slug]]
- External: <url-or-path>
EOF
```

**Update an existing note:**

```bash
NOTE="$VAULT/00-inbox/<existing-slug>.md"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Bump updated: in frontmatter
sed -i "s/^updated:.*/updated: $NOW/" "$NOTE"

# Append a dated section — keep history, don't rewrite silently
cat >> "$NOTE" << EOF

## Update — $NOW (by $CTX_AGENT_NAME)
<new info or correction>
EOF
```

**Concurrent writes:** if two agents write at the same time, prefer the framework's atomic-write helpers (`src/utils/atomic.ts`). For shell, write to a temp file and `mv` it into place.

**File permissions:** vault PARA notes are 644 by convention. Agents running as root often inherit a 077 umask, which produces 600 files. Run `umask 022` before writing (shown above) or `chmod 644 "$VAULT/00-inbox/$SLUG.md"` after, so the file is consistent with the rest of the vault and any future non-root tooling can still read it.

**KB ingestion:** the daemon's `vault-kb-refresh` cron handles this daily (03:00 Oslo). For immediate searchability:

```bash
cortextos bus kb-ingest "$NOTE" --org $CTX_ORG --scope shared
```

---

## Read Protocol

**Before starting non-trivial work, check the inbox.** Mandatory for tasks that touch shared systems (Coliseum, cortextOS framework, MCPs, infra).

```bash
VAULT=/root/storage/Documents/Github/sondres-orchestrator/vault
SESSION_START_MARKER=${CTX_ROOT}/state/${CTX_AGENT_NAME}/.last-session-end   # may not exist
```

### 1. Fresh-notes scan (session start)

```bash
# Notes added since your last session ended (preferred)
if [ -f "$SESSION_START_MARKER" ]; then
  find "$VAULT/00-inbox/" -name '*.md' -newer "$SESSION_START_MARKER"
else
  # 24h fallback
  find "$VAULT/00-inbox/" -name '*.md' -mtime -1
fi
```

Read the frontmatter (`type`, `tags`, `agent`, first paragraph) of each. Only deep-read what's relevant to your current goals.

### 2. Topic scan (before answering / before changing shared code)

```bash
# Recent activity
ls -lt "$VAULT/00-inbox/" | head -20

# Grep by tag or keyword
grep -rli "coliseum" "$VAULT/00-inbox/" "$VAULT/01-projects/" "$VAULT/02-areas/"
grep -rli "mcp\|saxo\|polymarket" "$VAULT/00-inbox/"
```

### 3. Semantic query (fuzzy matches across the whole vault)

```bash
cortextos bus kb-query "shadow ledger invariant" --org $CTX_ORG
```

KB gives semantic recall. File scan gives the freshest stuff that may not yet be ingested. Use both.

### 4. Handoff-tagged notes

If you receive an inbox message saying *"see vault/00-inbox/<slug>"* — read that note before replying or acting.

If you find a relevant note: follow it, link to it from your daily memory, and update it if you learn something more. If you find one that's wrong or stale: update or supersede it (don't silently rewrite — append a dated section).

---

## Worked Example — Today's Coliseum Incident Handoff

Analyst's investigation into a Coliseum behaviour incident produces findings other agents will need (e.g. shadow-ledger drift signature, agent crash pattern). That writeup is exactly what `00-inbox/` is for:

```yaml
---
type: finding
tags: [coliseum, shadow-ledger, incident, 2026-05-06]
created: 2026-05-06T08:30:00Z
updated: 2026-05-06T11:00:00Z
status: active
agent: analyst
session: 2026-05-06T08:00:00Z
relates_to: [coliseum-shadow-ledger-invariant, coliseum-trade-sync-gap]
---

# Coliseum incident 2026-05-06 — shadow-ledger drift

## Context
…

## Finding
…

## Why it matters
Any agent touching Coliseum's reconciliation or trading paths must read this before changing behaviour.
```

Without `00-inbox/`, this writeup lives only in agent inbox messages and disappears at the next compaction. With it, it's discoverable, taggable, KB-searchable, and survives forever.

---

## Checklist Before Writing

- [ ] Cross-cutting (would another agent benefit)?
- [ ] Existing note covers it? (If yes, update — don't duplicate.)
- [ ] Slug = `YYYYMMDD-<agent>-<kebab-topic>`?
- [ ] Frontmatter complete (type, tags, created, updated, status, agent, session)?
- [ ] At least one tag, kebab-case, descriptive enough that grep finds you?

---

## Maintenance

- Notes start as `draft` if you're still figuring it out. Promote to `active` once stable.
- When superseded, mark `status: archived` and add `relates_to: [<successor-slug>]` — don't delete.
- Sondre or commander may eventually promote mature notes to `01-projects/`, `02-areas/`, or `03-resources/`. That's the lifecycle working — don't preempt it. **Use `git mv` when promoting** so `git blame` survives the move.

---

## v1 Acceptance Criteria

- `vault/00-inbox/` exists ✓
- This skill file exists in every active agent (`.claude/skills/shared-knowledge/SKILL.md`) ✓
- At least one reference note seeded so the read protocol has something to find ✓
- Daily KB-ingest cron (`vault-kb-refresh`) registered (commander owns) ✓

---

## Future (v2+)

Bus helper: `cortextos bus shared-knowledge write --type finding --tags coliseum,recon --title "..."` — generates the slug, writes the frontmatter, opens for content. Skip for v1; agents can write the markdown directly.
