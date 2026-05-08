---
domain: [git, file-paths]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: should-know
---

# Verify git-tracking state before locking a path decision

**If a design says "repo-canonical" / "versioned" / "git-diffable", run `git check-ignore <path>` first.** Same trap with submodules, worktrees, separately-init'd inner repos.

## Pattern fix

Before committing to "this file lives at path X and is tracked," verify:
1. `git check-ignore -v <path>` — ensures path isn't gitignored.
2. `git ls-files --error-unmatch <path>` — ensures path is actually tracked (not just present in working tree).
3. `git rev-parse --show-toplevel` — ensures you're in the repo you think you are (not a submodule, not a separate inner repo).

## Rule of thumb

"Git-versioned" is a claim, not an assumption. Three things can break it: gitignored parents, submodule isolation, force-add-only history. Verify before designing around it.
