---
domain: [git, cli, prs]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# gh CLI defaults to upstream parent on a fork; ALWAYS pass --repo explicitly

**`gh pr create`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh pr merge`, AND any subagent / hook / script that shells out to `gh` will silently target the upstream parent (the original repo, not the fork) unless `--repo` is explicit.**

Two distinct symptoms during one PR cycle:
- `gh pr create` opens against upstream main, surfacing the PR on the wrong repo.
- `pr-deep-evaluator` subagent reading PR body via `gh pr view N` returns upstream's #N (an unrelated PR), and flags the body as "doesn't match changes" — confident-but-wrong CHANGES REQUIRED on what should have been an APPROVE.

## Pattern fix

Every gh invocation on a forked repo gets `--repo <fork-owner>/<fork-repo>` explicitly. Or set `GH_REPO=<fork-owner>/<fork-repo>` env var for shell scripts.

Subagent prompts that brief a tool on gh CLI use must include the explicit `--repo` flag in the example commands the agent will copy.

## Rule of thumb

The moment your `gh remote -v` shows BOTH `origin` and `upstream`, gh's defaults stop being safe. Treat `--repo` like `cd` — you specify it explicitly because the working-directory-equivalent is ambiguous.

## Source incident

Micro-retro 2026-05-08 — analyst hit (a) opening PR #363 against grandamenium/cortextos during the code-quality-rules PR (intended saurav-yirifi/sb-cortextos-fork#2), then (b) a re-spawned pr-deep-evaluator hit the same trap on `gh pr view`. Two distinct symptoms, one root cause; both caught pre-merge.
