---
domain: [daemon, supervisors, restarts, ipc]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Restart paths must forward locally-resolved values, not raw input args

**A function that resolves a value from `arg ?? lookup(arg) ?? fallback` MUST forward the resolved value to every downstream callee — not the raw `arg`.** When the function has multiple call sites (boot path with full args + restart/IPC path with sparse args), forwarding the raw arg silently no-ops every dependent feature on the restart path.

## Symptom

The feature works on the boot path (where the caller happens to pass a non-undefined arg) and silently dies on the restart/IPC path (where the caller passes nothing). Logs are clean — no error, no warning, no exit-trace. The downstream helper hits its `if (!arg) return;` guard and bails.

User-visible: "Approve buttons / inline callbacks / heartbeats / whatever-this-poller-drives go dead after every restart, only come back on full daemon reboot."

## Pattern fix

If you have:

```ts
async startThing(name: string, ..., org?: string): Promise<void> {
  const resolvedOrg = this.resolveOrg(name, org);  // arg → registry → fs scan → fallback

  // ... use resolvedOrg for path resolution, env, …

  await this.maybeStartSidecarPoller(name, org, …);  // BUG: forwarded raw `org`, not resolvedOrg
}

private async maybeStartSidecarPoller(name: string, org: string | undefined, …) {
  if (!org) return;  // silent no-op when called from restart path
  // …
}
```

Forward the resolved value, not the input:

```ts
await this.maybeStartSidecarPoller(name, resolvedOrg, …);
```

**Audit rule:** when a function has BOTH `arg` (the parameter) and `resolvedArg` (the locally-computed canonical value) in scope, every downstream call must use `resolvedArg`. Grep the function body for `${arg}` references and prove each one is intentional or replace with `resolvedArg`.

**Test rule:** for any feature that depends on a resolver, write at least one regression test that drives the call site WITHOUT the explicit arg (mimics the restart/IPC call shape). Boot-path tests that pre-populate the arg pass forever, while the restart path silently breaks.

## Rule of thumb

A resolver exists because the input is sometimes missing. Every consumer of the resolver's output must use the resolver's output, not the original input — otherwise half your call sites get the post-resolve value and half get the pre-resolve value, and the difference only surfaces when something restarts. The smell is: "feature works on boot, breaks on restart, comes back after a daemon reboot."

## Source incident

cortextOS daemon agent-manager.ts:473 (devops fleet, 2026-05-10) — `startAgent` resolved `org` via `resolveAgentOrg(name, org)` into `resolvedOrg`, then forwarded raw `org` to `maybeStartActivityChannelPoller`. The `cortextos start <orchestrator>` IPC path passes `org=undefined`; the helper's `if (!org) return;` guard fired silently. Activity-channel TelegramPoller never started → Approve/Deny inline buttons in the org's activity channel were dead on every CLI restart, only worked after a full daemon boot (which goes through `discoverAndStart` where org IS attached per BUG-043). Same shape recurs anywhere a restart-path passes sparse args into code originally written for a fully-populated boot path.

Adjacent rules:

- `code-quality/daemon-side-config-requires-daemon-restart.md` — daemon-side gates need daemon restart, not per-agent. The trap here is the inverse: per-agent restart silently DOES exercise the daemon-side path, but with degraded args.
- `code-quality/helper-second-caller-predicate.md` — when a helper acquires a second caller, re-derive its predicate. The activity-channel poller helper had two callers (boot via `discoverAndStart` + restart via `startAgent`); the predicate `if (!org) return;` was correct for both, but only one caller was passing a non-undefined org.
