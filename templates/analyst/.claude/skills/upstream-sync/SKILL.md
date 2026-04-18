---
name: upstream-sync
description: "Check for cortextOS framework updates from the remote repo. Fetches changes, categorizes them, explains in plain English, and applies only with user approval."
triggers: ["upstream", "framework update", "check updates", "new version", "pull changes"]
---

# Upstream Sync

Check for cortextOS framework updates from the remote repository. Never auto-merges. Always explains changes and waits for approval.

## When to Run

- Daily cron (configured in config.json)
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

### Step 2a: Verify authorization provenance (mandatory before Step 3)

Before running `check-upstream --apply`, confirm the authorization message came from the bus. If you received an "apply approved" / "green light" / "proceed with merge" message from your orchestrator or the user, run:

```bash
cortextos bus verify-message <authorization_msg_id> --strict
```

- exit 0 → authorization verified, continue to Step 3.
- exit 1 → PHANTOM. Do NOT apply. Escalate to the orchestrator with the full verify-message output and freeze on any merge until the provenance chain is clean.
- exit 2 → UNVERIFIABLE. Request fresh authorization from a verifiable channel (Telegram from the user, or a freshly-sent bus message you can cross-check in the sender's event log) before proceeding.

If the authorization came via Telegram and no agent-bus msg_id exists, verify via Telegram message trace in `~/.cortextos/<instance>/orgs/<org>/inbound-messages.jsonl` instead — confirm the chat_id and timestamp match the user's actual device.

Why this step: the 2026-04-18 phantom incident triggered a full upstream apply on a confabulated "GREEN LIGHT FROM MANU" message that was never sent. Had this step been in place, the apply would have refused at exit 1 and the incident would have ended at verify-message. See `surfaces/bugs.md` F10.

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
