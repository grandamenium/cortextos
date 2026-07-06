# Spec 01 — Rewrite dynamic-pipeline.js for the Workflow sandbox

**Repo:** /Users/joshweiss/code/cortextos
**File:** `.claude/workflows/dynamic-pipeline.js` (single file)
**Owner (build):** codexer · **Reviewer:** larry → PR (Josh approves)

## Intent
The pipeline workflow must actually run in the Workflow runtime. Today it uses Node APIs, fs, child_process, and dynamic `import()` — all unavailable there. Rewrite it to the sandbox contract: only the workflow hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`) + standard JS. All external/CLI/git work happens INSIDE subagents, never the orchestrator.

## Hard requirements
1. **Zero** of: `import(...)`, `require(...)`, `node:*`, `execFileSync`, `child_process`, `fs`/`mkdirSync`/`rmSync`/`existsSync`, `path`/`join`, `os`/`homedir`. (Verify with grep in your report.)
2. Stage routing = inline map `DEFAULT_ROUTES` (stage → `{ model?, agentType?, effort? }`), overridable via `args.routes`. Anthropic stages: `agent(prompt, { model, effort, schema, label, phase })`. External-CLI stages (Implement via Codex): `agent(prompt, { agentType: 'codex-rescue', schema, label, phase, isolation: 'worktree' })`.
3. Implement stage isolation is native: `isolation: 'worktree'` on the `agent()` call — remove `prepareImplementWorktree`/`runGit`/`slugifyBranch`.
4. Merge + PR stages remain `agent()` calls whose PROMPT tells the agent to run git/gh (it has Bash). Orchestrator itself runs no git.
5. Fable-at-Plan opt-in reads from `args.confirmFable` (true/'true'/'yes').
6. Preserve structure + all six schemas + the review loop (`maxReviewLoops`, default 2) + the Lessons stage. Keep `meta` (update phase details if a route changed).

## Done =
Runs end-to-end in the Workflow runtime on a trivial `args.task` with no runtime error; opens a PR; grep confirms none of the banned tokens remain. Diff + grep-proof to larry. Do NOT commit/push.
