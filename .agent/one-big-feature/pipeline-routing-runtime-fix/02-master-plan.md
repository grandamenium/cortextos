# OBF Master Plan — Pipeline Routing Runtime Fix

**Slug:** pipeline-routing-runtime-fix
**Repo:** /Users/joshweiss/code/cortextos
**Framework:** one-big-feature (single file rewrite, one repo)
**Author:** larry · 2026-07-05

## Problem (verified in source)
`.claude/workflows/dynamic-pipeline.js` cannot run in the Workflow sandbox. The runtime provides plain JS + the workflow hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`) and standard JS built-ins ONLY — **no Node.js API, no filesystem, no `child_process`, no module imports.** The current script violates all of that:
- lines 15-19: `await import('./lib/runtime-bridge.js')`, `await import('./lib/routing-policy.js')`, `await import('node:child_process')`, `await import('node:fs')`, `await import('node:path')` — dynamic module import is unavailable.
- `sendWork(...)` (the runtime bridge) shells out via `execFileSync` — illegal in-orchestrator.
- `runGit()` / `prepareImplementWorktree()` (lines 79-105) call `execFileSync('git', ...)` and `mkdirSync`/`rmSync` — illegal in-orchestrator.
- `loadRoutingConfig()` reads `routing-config.json` from disk — no fs.

## Fix — subagent-per-stage; external work happens INSIDE subagents, never the orchestrator
1. Delete every `await import(...)` and all `node:*` usage. No `execFileSync`, `mkdirSync`, `rmSync`, `existsSync`, `join`, `homedir`.
2. Replace `sendWork` provider-routing with `agent()` opts. A stage maps to `{ model?, agentType?, effort? }`. Anthropic models run via `agent(prompt, { model, effort, schema })`. A stage needing an EXTERNAL CLI (Codex implement) routes to a subagent: `agent(prompt, { agentType: 'codex-rescue', schema, ... })` — that subagent runs Codex with its own Bash; the orchestrator does not shell out.
3. Delete `runGit`/`prepareImplementWorktree`/`slugifyBranch`. Worktree isolation is native: `agent(prompt, { isolation: 'worktree', schema })`. The Merge and PR stages already instruct their agent to run `git`/`gh` — keep that (the subagent has Bash); ensure the orchestrator body runs no git itself.
4. Replace `loadRoutingConfig`/`routing-config.json` with an inline `DEFAULT_ROUTES` object, overridable via `args.routes`. No file reads.
5. Preserve the pipeline shape and all schemas: Explore(parallel, read-only) → Plan(single) → Implement(worktree-isolated, parallel) → Merge → Review(loop back up to maxReviewLoops) → PR → Lessons. Keep the Fable opt-in gate at Plan via `args.confirmFable` (no hook input plumbing needed — read from args).

## Scope boundary
- codexer rewrites `.claude/workflows/dynamic-pipeline.js` (it is `.js` → codexer domain).
- The `./lib/runtime-bridge.js` + `./lib/routing-policy.js` + `routing-config.json` become unused by this workflow; leave them in place (other callers may use the seam) but this script must not import them.

## Done =
The workflow parses and runs end-to-end in the Workflow runtime with a trivial task (e.g. a one-line doc fix) without any Node/fs/child_process/import error; produces a PR. Return the diff + a note confirming zero `import`/`node:`/`execFileSync`/`fs` references remain in the script. Diff to larry → PR (Josh approves).
