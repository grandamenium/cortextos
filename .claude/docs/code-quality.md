# cortextOS code quality standards (P9 principal eng)

The core P9 principles are inline below — universal, always loaded, every coding-agent session. Specialized class-of-trap rules live as on-demand subfiles under `.claude/rules/code-quality/<slug>.md`, indexed at the bottom by domain. Read a subfile when its domain matches the work you're starting; don't load the whole rule library every session.

Adopted + adapted from `sb-claude-jarvis/.claude/rules/code-quality.md` 2026-05-08. Each rule names the *class of trap*, not a per-symptom fix. Trust the rules across language boundaries — most are TypeScript-as-much-as-Python.

---

## Core P9 principles (inline, always loaded)

These apply to every coding task. Re-read on session start; re-read at the start of any non-trivial coding task.

### File and function size

- **File size — soft 300, hard 500.** At 300, ask *should this split?* Cohesive single-purpose files (parsers, dispatch tables, state machines, zod/schema modules, type-definition files) can sit 300–500. Mixed-responsibility 300+ files must split. Hard rule at 500.
- **Functions under 40 lines.** Hard rule. Extract helpers if longer.
- **Module package over single file when complexity grows.** `src/foo.ts` → `src/foo/` directory once it grows beyond basic CRUD. Index via `src/foo/index.ts`.

### Single responsibility

- **Storage doesn't render. Views don't mutate. Commands are thin wrappers around library functions.** If a 300+ file mixes responsibilities, split — size is the symptom.
- **No incremental monoliths.** Before adding to a 300+ file, refactor first if you'd push past 500 OR add a new responsibility.

### Edge cases and error paths

- **Handle missing files, bad IDs, empty state.** Never crash on user input. Test failure paths, not happy paths — happy paths rarely hide bugs.
- **Root-cause, not band-aid.** Fix the actual problem. Ask "will this surprise us later?" before patching a symptom.

### Shipping

- **Wire features in the same commit as the primitive.** "Phase 1 = primitive only" is the failure mode. Split into smaller goals where each commit ships value to a real caller.
- **Verify upstream framework conventions before porting.** Copying validation/field/layout from another framework (Express, NestJS, langchain) requires fetching the *target* framework's docs first.
- **One code path for critical operations.** If session-start / restart / notify-send is called from CLI + watchdog + worker, extract a shared function. Inline copies diverge silently.

### Build/eval/fix/PR loop (per phase + per feature)

**Per phase:** implement → `code-evaluator` subagent → fix in separate commit → LGTM. LGTM is the gate to the next phase. Fix-commits land separately, never amend.

**Per feature:** push → PR → `pr-deep-evaluator` subagent → fix → `gh pr merge --merge --delete-branch`.

`pr-deep-evaluator` validates code-merge-readiness, NOT activation/deployment correctness; those are separate audits. PR descriptions that introduce daemon-side gates must call out the activation sequence explicitly.

### Hard git rules

- **`--merge`, not `--squash`.** Preserve commit history; squash collapses bisect-relevant phases.
- **Never `--no-verify`.** Pre-commit hooks exist for reasons. If a hook fails, fix the underlying issue, not the bypass.
- **Never `--amend` on pushed commits.** History rewrites force-push for everyone else; create a new commit.
- **Never force-push to main/master.** Warn the user if asked. Force-push to feature branches is acceptable when the branch is yours.
- **Always `--repo <fork-owner>/<fork-repo>` on a forked repo for every gh CLI call.** See `code-quality/gh-cli-fork-default.md`.

### After writing code

- **Re-read the diff before committing.** The unread diff is where regressions hide.
- **Run `npm run build` (TypeScript compile) and `npm test` (vitest).** Both must pass green before code-evaluator.

---

## Before writing code

1. Read `OVERVIEW.md` and `CLAUDE.md` at framework root for architecture context.
2. Search `git log --oneline` for past commits touching the area, and (when touching org-/agent-scoped code) `orgs/<org>/agents/<agent>/experiments/learnings.md` for past lessons captured by that agent's theta wave or autoresearch cycles.
3. Check target file line count — if 300+, ask whether your addition belongs here or needs a new module.
4. If unsure where code goes → it's a separate file under `src/<area>/`.
5. **Check the subfile index below** for any specialized class-of-trap rules in the domain you're touching (git, tests, llm, daemon, networking, etc.). Read the relevant subfile(s) before starting.

---

## Subfile index

Format: `- [domain] <slug>: one-line symptom (severity)`. Read the subfile when its domain matches your work.

### Git, PRs, multi-repo coordination

- [git, cli, prs] `gh-cli-fork-default`: gh CLI silently targets upstream parent on a fork unless `--repo` is explicit (blocker)
- [git, fleet-coordination, multi-agent] `same-repo-multi-agent-checkout-contamination`: branch checkout silently discards another agent's uncommitted work in a shared working tree (blocker)
- [fleet-coordination, git, multi-repo] `cross-fleet-contamination`: writes into another fleet's git tree may auto-commit onto active branches (blocker)
- [fleet-coordination, audits, refactor] `auditor-misses-themselves`: agent propagating fleet-wide change overlooks their own templates (blocker)
- [git, file-paths] `gitignored-write-trap`: `!subdir/` exception patterns don't re-include files when parent dir is excluded (should-know)
- [git, file-paths] `verify-git-tracking-state`: verify git-tracking before locking a path decision — submodules, worktrees, gitignored parents (should-know)
- [git, prs, code-review] `one-logical-change-per-pr`: bundling unrelated work in one PR makes both halves rot (should-know)

### Tests and integration

- [tests, integration, artifacts] `integration-artifact-tests`: tests must read what the production consumer reads, not just side-channel state (blocker)
- [tests, fixtures, side-effects] `tmp-path-conflates-trees`: tests conflating two production roots into single tmp dir hide tree-routing bugs; outbound side effects need bottom-of-stack gate (blocker)
- [tests, entry-points, modules] `green-tests-vs-cold-import`: green test suite doesn't prove the production entry point will import cleanly (blocker)
- [tests, llm, ai-orchestration] `tests-synthesizing-structured-emit-must-exercise-helpers`: tests synthesizing structured emit must also exercise the recommended-helper invocation (should-know)
- [tests, config, deployment] `configurability-tests`: configurable fields need tests that drive the consumer code path with non-default values (should-know)
- [refactor, tests, predicate-design] `helper-second-caller-predicate`: re-derive helper's predicate from first principles for new caller; locked-in tests don't validate (blocker)
- [llm, ai-orchestration, tests] `brief-coverage-vs-test-coverage`: LLM-worker self-evaluators only validate paths their tests cover; multi-caller briefs need per-caller tests (blocker)

### LLM / AI orchestration

- [llm, ai-orchestration] `llm-vague-triage-hallucinates`: vague triage/synthesis briefs produce convincing-looking false data (blocker)
- [data-promotion, llm, ai-orchestration] `never-auto-create-canonical-objects`: extraction emits to triage queue; only explicit user/human action promotes to canonical store (blocker)
- [llm, ai-orchestration, briefs] `brief-addendums-lost-in-planner`: planner reads brief body into task descriptions but doesn't propagate addendums after planning (should-know)
- [llm, context-management, compaction] `compact-instructions`: surgical `/compact` prompt library for task-boundary compaction (phase / feature / pre-hard-restart / mid-task emergency) — read when context-pct.json reports severity > green (should-know)
- [llm, context-management, agent-orchestration] `agent-side-compact-not-invokable`: `/compact` is a Claude Code slash command typed by an operator, not an agent-tool-call API; agent-side cooperative-compaction primitive is `cortextos bus hard-restart` (should-know)

### Daemon, supervisors, deployment

- [daemon, supervisors, deployment] `launchd-keepalive`: `KeepAlive: {SuccessfulExit: false}` doesn't restart on clean SIGTERM exit 0 — use plain `KeepAlive: true` (blocker)
- [daemon, supervisors, restarts, ipc] `restart-path-loses-resolved-args`: function forwards raw input arg instead of locally-resolved value; feature works on boot path, silently no-ops on restart/IPC path (blocker)
- [cortextos-config, daemon, deployment] `daemon-side-config-requires-daemon-restart`: daemon-side config fields need daemon-restart, not per-agent restart (blocker)
- [cortextos-config, time, daemon] `daemon-sgt-as-local-tz`: cortextOS daemon interprets cron expressions as SGT local while storage/display claim UTC (blocker)
- [cortextos-config, daemon] `time-anchored-cron-fire-on-add`: `add-cron` fires once on registration; `update-cron` does not (should-know)
- [cortextos-config, models] `opus-1m-config-rejection`: model variant IDs like `opus[1m]` are internal markers, not user-passable via config.json or `--model` (blocker)

### Reliability, monitoring, observability

- [reliability, observability] `filesystem-watch-misses-sub-cadence`: every-Nh watch is forensic-only on outages shorter than N; pair with continuous out-of-band probes (blocker)
- [reliability, monitoring, health-checks] `probe-vs-watchdog-detector`: probe and the recovery action it implies must share one detector function (blocker)
- [reliability, monitoring, observability] `liveness-probes-end-to-end`: structural "running with right name" doesn't prove liveness — add loopback probe with sentinel verification (blocker)
- [reliability, observability, heartbeats] `heartbeat-tick-on-cycle`: heartbeat fields must tick on every cycle, not only on activity (should-know)
- [reliability, restarts, supervisors] `watchdog-recoveries-preserve-state`: default to `--continue` / `resume=true`; restart-attempt cap prevents resume-loops (should-know)
- [observability, monitoring] `probe-error-rate-counts-unique`: count distinct failing specs, not raw event volume (should-know)
- [tests, reliability, monitoring] `probe-known-good-and-bad`: validate probe transitions ok→error AND error→ok before enabling (should-know)

### Networking and timeouts

- [networking, reliability, timeouts] `network-call-timeouts`: size timeouts to observed p99, not intuition; don't wrap deterministic-too-short in retry-once (should-know)
- [networking, reliability, timeouts] `long-poll-watchdogs`: library `timeout: N` covers connect + first-byte only; wrap loops in outer deadline (should-know)

### Subprocess and process detection

- [subprocess, daemon, supervisors] `subprocess-spawning-explicit-env`: don't wrap commands in `bash -c` in worker contexts; pass explicit env via structured spawn API (blocker)
- [subprocess, process-detection] `process-counting-argv0`: count argv[0], not substrings — wrappers (tmux, sudo, env) inflate substring matches (should-know)
- [subprocess, reliability, detection] `process-detector-validation`: validate process detectors against real running instances; argv formats drift across versions (should-know)

### State and concurrency

- [state, fleet-coordination, daemon] `session-restart-immunity`: state files keyed on `session_id` are load-bearing tech debt — use `(abs_path, wallclock_bucket)` or content hashes (blocker)
- [state, distributed-systems, refactor] `parallel-state-machines-cleanup`: when killing a resource, also update the OTHER state machine through its API (blocker)
- [external-mutators, retries, distributed-systems] `idempotency-at-call-site`: external mutators (Todoist, GitHub, GWS) need upstream idempotency check before re-entry (blocker)

### Refactor and primitives

- [refactor, feature-flags, primitives] `mode-bypassing-primitive`: when new mode opts out of a primitive, audit consumers reading the primitive's absent state (blocker)
- [data-translation, tests, type-safety] `dict-translation-spread-pattern`: translating object A → B with explicit field-list silently drops upstream-added fields (blocker)

### Validation and parsing

- [validation, json, types] `numeric-validation-three-traps`: `typeof x === 'number'` accepts NaN/Infinity/floats — predicate per case (counts/durations/percentages) (blocker)
- [error-handling, api-design] `partial-batch-helpers`: best-effort batch creators must be checked at call boundary; never silently leak partial state (should-know)
- [parsers, regex, text-processing] `markdown-parsers`: don't write ad-hoc markdown parsers with single-pass regex; use real CommonMark parser or strip fences first (blocker)

### File paths and indexing

- [file-paths, indexing] `filesystem-reindexers-respect-quarantine`: glob-based reindexers must check `INDEX_EXCLUDE_DIRS` per-component or re-include quarantined files (should-know)
- [file-paths, deployment, build-systems] `filesystem-moves-stale-paths`: `mv` leaves stale absolute paths in shebangs, venvs, lockfiles, sourcemaps — sweep with grep-replace, then drive both CLI and entry-point (should-know)

### Fleet coordination and comms

- [fleet-coordination, comms, audit-trail] `saurav-direct-fleet-policy-needs-relay-before-act`: Saurav-direct DMs to specialists touching fleet-wide policy must trigger `fleet_context_relay` before acting (blocker)
- [fleet-coordination, user-surfaces] `specialist-agent-role-doesnt-imply-no-direct-dm`: don't infer user-comm patterns from architecture role; confirm via usage data or explicit check-in (should-know)
- [comms, telegram, identifiers] `telegram-supergroup-upgrade-invalidates-chat-id`: Telegram auto-migration changes `-<id>` to `-100<id>`; outbound to old id fails while inbound still receives migration notices — silent broadcast loss (blocker)

### Auth, dashboard, deployment

- [auth, deployment, dashboard] `nextauth-secure-cookies-vs-tls`: `secure: NODE_ENV === 'production'` breaks local-HTTP sign-in; track TLS availability, not deployment mode (blocker)
- [auth, claude-config, multi-account, headless-agents] `claude-config-dir-is-keychain-partition-key`: `CLAUDE_CONFIG_DIR` partitions macOS keychain entries — two values that resolve to the same `.claude.json` file map to two different keychain entries; setting it to a never-logged-in value silently fails with "Not logged in" (blocker)
- [auth, claude-config, headless-agents, pty] `bypass-dialog-no-config-suppression`: Claude Code 2.1+ Bypass Permissions warning has no `settings.json` or CLI flag suppression — must be auto-accepted via PTY input (down-arrow + Enter) (blocker)
- [pty, automation, terminal, vendor-tuis] `pty-output-substring-heuristic-matches-multiple-dialogs`: auto-Enter on PTY-output substring backfires when a future vendor release adds a sibling dialog containing the same substring whose default is destructive (blocker)

### TUI / automation

- [tui, automation, terminal] `bracketed-paste-tui-enter`: `tmux send-keys "<text>" Enter` is absorbed by paste-mode in Claude Code v2.1+; split into two send_keys with delay (should-know)

### CLI and templates

- [cli, templates, documentation] `bus-cli-flag-source-of-truth`: templates accumulate flag references that drift from actual CLI; verify via `<command> --help` at template-author time (should-know)

---

## How these rules update

The structure is progressive-disclosure by design (BL-2026-05-08-002):

- **Inline core** above stays minimal — universal P9 principles only. Resist adding specialized rules here; they grow the always-loaded surface for every coding agent's every session.
- **Subfiles** under `code-quality/` carry the class-of-trap detail. Each subfile has frontmatter (`domain`, `applies_to`, `severity`), a body matching the rule + pattern fix + rule of thumb shape, and a source-incident reference where applicable.
- **New rules go in as new subfiles**, indexed above by domain. Title + dated incident + symptom + fix pattern + rule-of-thumb. Don't dilute structure. Don't merge rules that share a date but differ in class-of-trap. Reference the source `MEMORY.md` or `learnings.md` entry inline.
- **Promote a subfile to inline core** only if Saurav explicitly approves and the rule applies UNIVERSALLY (not domain-specific). The default is "extract to subfile."
