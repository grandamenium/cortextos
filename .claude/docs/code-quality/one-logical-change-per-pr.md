---
domain: [git, prs, code-review]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: should-know
---

# One logical change per PR, not just per commit

**Bundling an urgent hot-fix with a non-urgent refactor on one branch is a trap:** the urgent fix gets re-derived elsewhere, the refactor rots, landing requires per-commit triage.

## Pattern fix

For any open PR >7 days, check whether each commit's *content* was re-derived in main. Cherry-pick survivors onto a fresh branch and supersede the stale one.

When opening a new PR:
- One scope per branch.
- If you discover scope-mixing during work, split into two branches before opening (cherry-pick the second half elsewhere).
- Mixed-scope PRs can't be partially merged — all-or-nothing locks unrelated work behind unrelated review.

## Rule of thumb

If you can't summarize the PR's purpose in one sentence without "and also," you have two PRs. Split before opening.
