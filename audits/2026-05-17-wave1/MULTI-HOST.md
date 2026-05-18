# Multi-host conformance

cortextOS runs on multiple machines that share `orgs/` via git (MacBook + Mac mini at minimum). Code paths that assume a single user, home dir, or hostname break the moment they deploy to host #2 — usually after merging, in a way that's invisible until someone tries to use it.

The 2026-05-17 Wave-1 deploy caught two such bugs in supposedly-tested code:

## Bug class 1 — Incomplete config-string rename
`src/daemon/agent-process.ts` kept a `runtime === 'codex'` check after the rest of the codebase + every test had been renamed to `'codex-app-server'`. Result: every new codex agent silently routed to the wrong PTY class on the Mac mini and crashed at stop with exit 129.

**Rule:** when renaming a config string, grep BOTH `src/` AND `tests/` for the OLD value. The asymmetry is the giveaway: tests use the new name (so they pass against any branch that updated them), but the daemon still recognizes the old name (so production agents take a different code path).

## Bug class 2 — Hardcoded user paths in fallbacks
`src/cli/scope-plugins.ts` fell back to a hardcoded `/Users/hari/cortextos` string when `CTX_FRAMEWORK_ROOT` wasn't set. The shell-invoked CLI on Mac mini doesn't inherit the PM2 daemon's env, so the fallback fired and the command bailed out with `Could not load agents.yaml from /Users/hari/cortextos` — a path that only exists on MacBook.

**Rule:** fallbacks must use `path.join(homedir(), 'cortextos')`, never a literal absolute path. The runtime resolves HOME per host correctly.

## How the rules are enforced

`tests/unit/multi-host-conformance.test.ts` fails loudly when either pattern is re-introduced. Three independent checks:

- **(a) No hardcoded `/Users/<user>/` paths in `src/`.** Comments are stripped before scanning; string literals are not. Catches the exact scope-plugins-style fallback.
- **(b) No `runtime === 'codex'` / `runtime: 'codex'` checks anywhere in `src/`.** Only `'codex-app-server'` is allowed. Bare uses of the literal `'codex'` (e.g. the binary name passed to `spawnFn('codex', [...])`) are explicitly permitted via pattern scoping.
- **(c) Every `homedir()` call in `src/cli/` that derives the framework checkout (`homedir(), 'cortextos'`) must be paired with `CTX_FRAMEWORK_ROOT`.** Catches the specific scope-plugins regression while allowing `homedir()` for state dirs (`~/.cortextos/<instance>`), macOS-specific paths (`~/Library`, `~/.cloudflared`), and similar non-multi-host concerns.

Run locally with `npx vitest run tests/unit/multi-host-conformance.test.ts`. The grep targets are intentionally simple — a future regression is impossible to merge without flipping a red test.

## Operator checks before claiming substrate is done

A substrate change isn't "done" until it's run end-to-end on host #2 (Mac mini):
1. `git pull && npm run build` on host #2
2. `cortextos status --instance default` on host #2 reports the correct host id, agents, and HMAC fingerprint
3. `cortextos scope-plugins --dry-run` resolves the right framework root on host #2
4. The bus-signing-key sha256 (shown in `cortextos status`) matches between hosts

`cortextos status` is the canonical one-shot health view that lights up everything the post-merge operator needs to verify: host id, daemon state, agent status + role, inbox/error depth per agent, breaker cooldowns, HMAC key fingerprint + grace expiry, manifest drift, and recent crashes. Pipe to `jq` with `--json` for machine-readable output.

If a code path is conditional on the host, document why in code AND add a test that exercises both hosts' identity strings.
