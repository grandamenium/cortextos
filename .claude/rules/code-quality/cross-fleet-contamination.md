---
domain: [fleet-coordination, git, multi-repo]
applies_to: [analyst, engineer, devops, fullstack, boss]
severity: blocker
---

# Cross-fleet branch contamination: writes into another fleet's git tree may auto-commit onto active branches

**When an agent in repo A writes files into repo B's working tree, repo B's agents may auto-commit those onto whatever branch is currently checked out.** Result: scope-mixed PRs.

## Pattern fix

When writing across repos, do one of three things explicitly:
1. Write to a directory the target repo gitignores.
2. Commit the files yourself immediately to a dedicated branch.
3. Coordinate with the target repo's agents before writing.

Implicit "leave for them to review" loses to whatever auto-cleanup pattern the target fleet uses.

## Rule of thumb

The moment your write tool touches a path inside another fleet's git tree, you've made an implicit commitment to that fleet's auto-commit norms. Make the commitment explicit.

## Source incident

Micro-retro 2026-05-08 14:43-16:48 UTC — cortextOS analyst drafted Protocol B + Protocol A retrofit specs into `sb-claude-jarvis/docs/roadmap/v0.4-cortexos-retrofit/` per a "NOT committed, NOT PR'd" directive. A jarvis-internal agent (separate fleet, independent boss + builder) saw the new files in the working tree of the active branch (engineer's `feat/v0.4-protocol-d2-fleet-context-relay`) and committed them as chore-style cleanup. The D2 PR's diff now contained doc files for two unrelated protocols — scope mix that complicated review. Engineer reset path required to clean up.
