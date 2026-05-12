# Community Vetting Registry

Fleet-wide register of which community-sourced skills each agent has vetted and accepted into its `.claude/skills/` directory. Maintained as the durable record of supply-chain trust decisions for community content.

## Why this exists

Community skills (from `awesome-codex-skills`, individual GitHub repos, third-party catalogs) carry supply-chain risk: prompt injection, tool-misuse encouragement, hidden data exfiltration patterns. Each agent that adopts a community skill must vet it (typically via security-vp adversarial review once Forge ships the probe library). The registry below is the source of truth for "which agent has vetted which skill at which version".

This is the fleet-side counterpart to Forge's per-agent `.claude/skills/<name>/.version` markers (when those ship at Day-6+). Forge's per-agent markers track *what is installed*; this registry tracks *what has been formally vetted*.

## Schema (registry.json)

```json
{
  "version": 1,
  "updated_at": "ISO-8601 UTC",
  "vettings": [
    {
      "agent": "<agent-name>",
      "skill_name": "<skill-name>",
      "skill_version": "<SemVer>",
      "skill_sha256": "<sha256 of SKILL.md + bundled resources>",
      "skill_source": "<repo URL or catalog ID>",
      "vetted_at": "ISO-8601 UTC",
      "vetted_by": "<agent-name, typically security-vp>",
      "verdict": "PASS | FAIL | CONDITIONAL_PASS",
      "notes": "<short rationale; cite probe results if available>"
    }
  ]
}
```

## Conventions

- **One entry per (agent, skill_name, skill_version) triple.** Re-vetting after a version bump = new entry, not in-place update.
- **`vetted_by` should be `security-vp` once it reaches binding mode.** Until then, vetting is advisory and `vetted_by` may be `chief + dev + Hari` (manual review pattern, mirrors security-vp's own bootstrap).
- **PASS** = approved for deployment to that agent's `.claude/skills/`. **FAIL** = rejected; do not deploy. **CONDITIONAL_PASS** = approved with caveats (specified in `notes`); deploy with the constraints documented.
- **`skill_sha256`** is the canonical drift detector. If the deployed copy's SHA differs from the registry SHA, the skill has been mutated post-vetting and is no longer covered by this verdict.
- **No silent updates.** Every vetting decision goes through the bus: `cortextos bus log-event action skill_vetted info --meta '{...}'` before the registry is updated. Audit trail is the activity log + this file.

## Operative status

As of 2026-05-12 UTC (2026-05-11 ET): registry is empty. No community skills have been vetted yet. First entries expected once Forge ships its T0 seed bundle (Day-6+) and security-vp begins formal community-skill review on a candidate from `awesome-codex-skills` or similar.

## How agents should query

```bash
# Has agent X vetted skill Y at version Z?
jq '.vettings[] | select(.agent == "redteam" and .skill_name == "promptfoo-probes" and .skill_version == "1.2.0")' \
  community-vetting/registry.json
```

Forge's `skill-deploy` will check this registry as a pre-flight gate before deploying any community-sourced skill (Day-6+ integration; not yet wired).

## Related files

- `outputs/forge-agent-spec-2026-05-11.md` — Forge's role in skill deployment + registry interaction.
- `outputs/security-agent-design-2026-05-11.md` §3 — security-vp's adversarial review surface for skills.
- `outputs/forge-agent-research-2026-05-11.md` §Q3 — versioning + registry conventions (Skill Provenance dual-key pattern, SQLite WAL backing for Forge's own skills-registry.db; the simpler JSON in this dir is for community-vetting state specifically).
