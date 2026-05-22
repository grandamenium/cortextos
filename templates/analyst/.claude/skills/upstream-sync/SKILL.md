---
name: upstream-sync
description: "Check for cortextOS framework updates from the remote repo. Fetches changes, categorizes them, explains in plain English, and applies only with user approval."
triggers: ["upstream", "framework update", "check updates", "new version", "pull changes"]
---

# Upstream Sync

Check for cortextOS framework updates from the remote repository. Never auto-merges. Always explains changes and waits for approval.

## When to Run

- Daily cron (configured via `cortextos bus add-cron`)
- When user asks about updates
- After hearing about new cortextOS features

## Workflow

### Step 1: Check for updates

```bash
RESULT=$(cortextos bus check-upstream)
```

The script fetches from upstream and returns a JSON summary categorizing changes by type (bus scripts, templates, skills, dashboard, etc.).

### Step 2: If updates available

1. Read the JSON output to understand what changed
2. If `catalog_additions` array is present, note those new community items separately — surface them to user after the framework update conversation
3. Read the actual diff: `git diff HEAD..upstream/main`
4. Explain EVERY change in plain English to the user via Telegram
5. Categorize: security fix, new feature, template change, breaking change
6. Recommend: "safe to apply" or "review needed because..."
7. Wait for explicit "yes" from the user

### Step 3: Apply (only after approval)

```bash
cortextos bus check-upstream --apply
```

### Step 4: Security audit gate

After the merge applies, run the security gate BEFORE verifying build/tests:

```bash
npm install
npm audit --audit-level=moderate
```

If `npm audit` reports any moderate+ vulnerability:
- **BLOCK** — do not proceed to build/test
- Record advisory IDs, affected packages, and severity
- Report to orchestrator: "Upstream merge blocked by npm audit: [details]. Manual resolution required."

This catches upstream merges that silently downgrade a dependency that was previously security-patched.

### Step 5: Post-apply verification

- Run `npm run build` and `npm test` — both must pass
- Verify the merge was clean
- Check if any agent bootstrap files need updating (template changes)
- Report results to orchestrator

## Config

Requires `ecosystem.upstream_sync.enabled: true` in config.json.

## Safety

- NEVER auto-merges
- NEVER applies without explicit user approval
- NEVER applies during night mode — check day_mode_start/day_mode_end from config.json before proceeding
- Always explains changes before applying
- Warns about breaking changes or template modifications
