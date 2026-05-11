---
domain: [git, file-paths]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: should-know
---

# Gitignore exception patterns don't re-include files when parent dir is excluded

**Patterns like `!.claude/rules/file.md` DON'T re-include files when the parent (`.claude/`) is itself excluded — git stops descending into excluded dirs entirely, so filename-level negation never gets evaluated.**

Symptom: `.gitignore` has `.claude/` then `!.claude/rules/` later; you create `.claude/rules/code-quality.md`; `git check-ignore -v` shows `.claude/` winning, the file stays untracked-and-ignored.

## Pattern fix

When adding a `!subdir/` exception under a parent that's still excluded, use `git add -f <file>` for the first commit. Document in the commit message that the negation patterns are intent-documenting, not enforcement. Once the file is tracked, gitignore stops applying — the cache wins.

Test: after `git add -f` and commit, `git check-ignore --no-index <file>` may STILL list the file as ignored (the negation truly doesn't work); plain `git check-ignore <file>` returns nothing on tracked files (default skips tracked). The two forms answer different questions.

## Rule of thumb

Gitignore exceptions are NOT a parent-exclude bypass. To verify whether sibling exempted dirs are tracked-via-negation OR tracked-via-historical-force-add, run `git log --diff-filter=A --follow .claude/<file>` — usually the answer is force-add.

## Source incident

Micro-retro 2026-05-08 — analyst hit this when creating `.claude/rules/code-quality.md` on cortextOS-fork; the existing `!.claude/commands/` pattern was assumed to work the same way, but `.claude/commands/onboarding.md` was force-added historically and the negation pattern is decorative. Same trap recurs whenever an agent assumes existing gitignore exceptions are enforcing.
