---
name: community-publish
description: "Package a local skill, agent, or org template for community sharing. Strips PII, scans for secrets, prepares a clean submission, and opens a PR to the community catalog."
triggers: ["publish skill", "share skill", "community submit", "package for sharing", "contribute"]
---

# Community Publish

Package a local skill, agent template, or org template for sharing with the cortextOS community. Strips all personal data and opens a PR.

## When to Run

- When user asks to share a skill
- When the analyst identifies a well-built custom skill worth sharing
- Suggest proactively for skills that have been stable and useful

## Workflow

### Step 1: Prepare the submission

```bash
# Dry run - shows what would be packaged and any PII found
cortextos bus prepare-submission <type> <source-path> <item-name> --dry-run
```

Types: skill, agent, org

Example:
```bash
cortextos bus prepare-submission skill ./skills/morning-review morning-review --dry-run
```

### Step 2: Review PII scan results

The script scans for:
- Email addresses
- Phone numbers
- API keys and tokens
- Telegram chat IDs
- User names (from USER.md)
- Company names (from context.json)
- Deployment URLs

If PII is found, manually clean the staged files before submitting.

### Step 3: Get user approval

Send via Telegram:
- What is being shared
- Files included
- Any PII warnings
- Ask for explicit "yes" to submit

### Step 4: Submit to community

```bash
# Local submission only (adds to local catalog, no PR)
cortextos bus submit-community-item <item-name> <type> "<description>" --author "<your-name>"

# Full contribution (branch + push to origin + open PR against upstream)
cortextos bus submit-community-item <item-name> <type> "<description>" --author "<your-name>" --contribute
```

The `--contribute` flag:
1. Creates a git branch `community/<item-name>`
2. Copies clean files to community/ directory
3. Adds entry to catalog.json
4. Commits and pushes branch to `origin` (your fork)
5. Opens a PR against `upstream` (canonical cortextOS repo) via `gh` CLI

### Step 5: Report

Tell the user the PR URL and that it is awaiting community review.

## Config

Requires `ecosystem.community_publish.enabled: true` in config.json.

## Prerequisites

- User must have a fork of the cortextOS repo configured as `origin`
- `upstream` remote must point to the canonical cortextOS repo (set during install)
- `gh` CLI must be authenticated (`gh auth login`)

## Safety

- NEVER submits without explicit user approval
- ALWAYS runs PII scan first
- ALWAYS shows dry-run results before real submission
- User reviews every file before it leaves their machine


## Skill Notes

<!-- Standing rule (Greg, 2026-05-21): every skill invocation that produces a deliverable MUST append a dated entry here. Pattern mirrors revops-global-brand. -->

### What Works Well

<!-- Dated entries: **YYYY-MM-DD — <one-line context>** followed by what worked + why. Keep additive; don't delete prior entries unless they were proven wrong. -->

### Calibrations

<!-- Subtle preferences Greg consistently nudges — pre-apply these next time. -->

### Lessons Learned

<!-- What went wrong and what to do instead. Anchor each to a concrete incident with date. -->
