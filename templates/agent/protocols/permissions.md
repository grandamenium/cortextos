# Permissions Contract

> **MODE: dry-run** (Phase 2 v1). The permission-enforcement hook (separate Phase 2.2 patch) will *log* what it *would* block but not enforce. Switch to `enforce` after 7 days of clean dry-run logs.
>
> **This file alone does nothing in v1.** It defines intent. The episodic JSONL hook (Phase 2 v1) reads `hook_patterns.json` for importance scoring, not this file. The actual blocking comes in Phase 2.2.

## Always Allowed (no log unless flagged)
- Read, Glob, Grep, NotebookRead
- KB queries (kb-query, kb-collections, recall-facts)
- Internal cortextos bus commands: log-event, update-task, list-*, check-inbox, ack-inbox, update-heartbeat
- File writes scoped to: memory/, research-output/, .claude/skills/, telegram-images/

## Requires Approval
- External communications (send-telegram to chats other than known agents)
- File writes outside the agent workspace (anywhere not in the "Always Allowed" scope above)
- Network calls to non-whitelisted domains (HTTP allow-list below)
- create-approval / update-approval (the approval workflow itself)

## Never Allowed (mechanical block in enforce mode)
- `rm -rf`, `rm -r /`
- `git reset --hard`
- `git push --force` (without explicit approval ID in args)
- `git push --no-verify` (without explicit approval)
- Modification of `protocols/permissions.md` or `protocols/tool_schemas/*` (lock the lock)
- Modification of `.onboarded` marker
- DROP TABLE, TRUNCATE on any database

## HTTP Domain Allow-list
- api.github.com
- api.anthropic.com
- generativelanguage.googleapis.com
- api.openai.com (if configured)
- pypi.org / pypi.python.org / files.pythonhosted.org
- registry.npmjs.org / npmjs.com
- github.com (clone/raw fetches)
- raw.githubusercontent.com

## How to extend
1. Add entries above (this file is the *intent*, human-readable source of truth)
2. Update `tool_schemas/*.schema.json` for the *machine-checkable* form
3. Test in dry-run for 24h
4. Promote to enforce
