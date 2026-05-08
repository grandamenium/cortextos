# Contributing to cortextOS

Thank you for contributing a skill or agent template to the cortextOS community catalog. This guide covers everything you need to submit a contribution.

## What Can Be Contributed

| Type | Description |
|------|-------------|
| `skill` | A reusable capability for any agent (`.claude/skills/<name>/SKILL.md`) |
| `agent` | A full agent template with identity, config, and skills |
| `org` | An org-level template for a specific use case or industry |

---

## Skill Structure

Every skill lives in its own directory with a single `SKILL.md` file.

```
community/skills/<skill-name>/
└── SKILL.md
```

### SKILL.md Format

```markdown
---
name: <skill-name>
description: "<one sentence — used by the agent to decide when to load this skill>"
triggers: ["keyword", "another phrase", "what user might say to invoke this"]
external_calls: []  # List any external APIs, services, or URLs this skill contacts. Empty array = none.
---

# Skill Title

Short description of what this skill does.

## When to Use

...

## Workflow

### Step 1: ...

```bash
# example commands
```

### Step 2: ...

## Notes / Edge Cases

...
```

### Required Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphenated. Must match directory name. |
| `description` | Yes | One sentence. This is what the agent sees when deciding whether to load the skill. Make it precise. |
| `triggers` | Yes | Array of strings. Natural-language phrases that should cause the skill to activate. Include synonyms. |
| `external_calls` | Yes | Array of strings listing every external API, service, or URL the skill contacts. Use `[]` if the skill makes no external calls. Examples: `["api.github.com", "openweathermap.org"]`. This field is used by the community reviewer to assess the skill's network footprint — omitting it is grounds to reject the PR. |

### SKILL.md Guidelines

- Write for the agent, not a human developer. The agent reads this at runtime.
- Use concrete bash commands with real `cortextos bus` CLI usage, not pseudocode.
- Keep each step actionable. Avoid vague instructions like "handle errors appropriately."
- Do not include secrets, API keys, hardcoded usernames, or personal data.
- Do not use `rm -rf`, `curl | sh`, or other destructive/untrusted patterns.

---

## Agent Template Structure

```
community/agents/<agent-name>/
├── IDENTITY.md      # Required: Name, Role, Personality
├── SOUL.md          # Required: Values, decision-making principles
├── GUARDRAILS.md    # Required: What the agent must never do
├── GOALS.md         # Recommended: Default goals
├── HEARTBEAT.md     # Recommended: Heartbeat loop instructions
├── TOOLS.md         # Recommended: Available commands reference
├── config.json      # Required: model, crons, startup config
└── .claude/
    └── skills/      # Any skills bundled with this agent
```

---

## Review Checklist

Before opening a PR, verify:

- [ ] Directory name matches `name` in frontmatter
- [ ] `description` is one sentence and specific (not "a useful skill")
- [ ] `triggers` array has at least 3 phrases
- [ ] `external_calls` field is present — `[]` if the skill makes no external network calls
- [ ] Every `curl`, `fetch`, or HTTP call in the skill body is listed in `external_calls`
- [ ] All bash commands use `cortextos bus` CLI (not direct file manipulation)
- [ ] No hardcoded file paths that only work on one machine
- [ ] No secrets, tokens, API keys, or personal data
- [ ] No `rm -rf`, `curl | sh`, or shell injection patterns
- [ ] Skill tested on at least one real agent
- [ ] For agent templates: all required files present (IDENTITY.md, SOUL.md, GUARDRAILS.md, config.json)

---

## How to Submit

### 1. Fork and clone

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
git checkout -b feat/skill-<your-skill-name>
```

### 2. Add your files

Place your skill or template in the correct community directory:

```bash
# For a skill:
mkdir -p community/skills/<skill-name>
# Add SKILL.md

# For an agent template:
mkdir -p community/agents/<agent-name>
# Add all required files
```

### 3. Register in the catalog

Add an entry to `community/catalog.json`:

```json
{
  "name": "<skill-name>",
  "type": "skill",
  "version": "1.0.0",
  "description": "One-line description shown in the catalog UI",
  "author": "your-github-username",
  "tags": ["tag1", "tag2"],
  "review_status": "pending",
  "install_path": "community/skills/<skill-name>"
}
```

Set `review_status` to `"pending"` — the maintainers will update it after review.

### 4. Open a pull request

```bash
git add community/
git commit -m "feat: add <skill-name> skill to community catalog"
git push origin feat/skill-<your-skill-name>
```

Open a PR against `main`. Use the title format:

```
feat: add <skill-name> [skill|agent|org] to community catalog
```

In the PR description, include:
- What the skill does and when it activates
- Which agent(s) you tested it on
- Any dependencies (external APIs, env vars required)

---

## After Submission

A maintainer or community reviewer will check your PR against the review checklist. You may be asked to:

- Clarify the `description` or `triggers`
- Remove or replace any flagged bash patterns
- Add missing required files (for agent templates)

Once approved, `review_status` will be set to `"approved"` and the item will appear in the public catalog.

---

## Agent Awareness Standard

cortextOS agents discover features through their CLAUDE.md template. A feature that exists in code but isn't mentioned in the agent template is invisible — no agent will ever use it.

**Before merging any feature PR**, verify:

- [ ] **Does this feature add a new bus command, CLI command, or API endpoint?** If yes, add it to `templates/agent/CLAUDE.md` (and `templates/orchestrator/CLAUDE.md`, `templates/analyst/CLAUDE.md`, `templates/security/CLAUDE.md` if applicable) with a usage example.
- [ ] **Does this feature change agent behavior or add a new hook?** If yes, update the relevant template's session-start or workflow section.
- [ ] **Does this feature add or modify a skill?** If yes, ensure the skill's `SKILL.md` has a current `description` and `triggers` list so agents know when to load it.

A feature without a template update ships dark. If you're unsure whether a template update is needed, it is.

---

## Questions

Open a GitHub issue or message the cortextOS community channel.
