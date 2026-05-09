# `CLAUDE_CONFIG_DIR` is a keychain partition key, not just a path resolver

**Setting `CLAUDE_CONFIG_DIR` to any value claude hasn't been `/login`-ed under produces a "Not logged in" failure even when the value resolves to a `.claude.json` file with a fully populated `oauthAccount` block.** The trap looks like a config-path bug; it's an auth-isolation bug.

## Symptom

You spawn an agent via node-pty / PM2 / any non-interactive parent with `CLAUDE_CONFIG_DIR` set. Claude reads `<CLAUDE_CONFIG_DIR>/.claude.json`, finds `oauthAccount.emailAddress` populated, the file looks healthy. Auth still fails:

```
⎿  Not logged in · Please run /login
```

Headless agents wedge here because there's no operator to type `/login`. Heartbeats stop. Dashboard shows "running" because the PTY is alive, but the agent can't make API calls.

## Why

On macOS, claude does NOT read OAuth tokens from `.claude.json`. The `oauthAccount` block in that file is only metadata (email, org UUID, billing-tier flag). The actual session token lives in the **macOS Keychain under service name `claude-code`**, with a per-`CLAUDE_CONFIG_DIR` partition key.

That means:

- Two `CLAUDE_CONFIG_DIR` values that resolve to the **same `.claude.json` file** still map to **two distinct keychain entries**.
- A `CLAUDE_CONFIG_DIR=$HOME` invocation is *not* equivalent to no-`CLAUDE_CONFIG_DIR` invocation, even though both read `$HOME/.claude.json`. The keychain partition key differs (one is "default-no-env-set", the other is the literal `$HOME` string).
- Logging in once via terminal `claude` (no env) populates ONLY the "default" partition. A subsequent agent spawn with `CLAUDE_CONFIG_DIR=$HOME` finds no matching keychain entry and falls into the "Not logged in" path with no useful error.

This is the same isolation mechanism that makes the user's working multi-account aliases function:

```bash
alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'
```

`claude` and `claude-work` each have their own keychain partition. The user logs in once per partition. Both work indefinitely. Adding a *third* `CLAUDE_CONFIG_DIR` value that has never been logged-in breaks silently.

## Pattern fix

**For the default account, leave `CLAUDE_CONFIG_DIR` UNSET.** Don't try to make it explicit by setting `CLAUDE_CONFIG_DIR=$HOME` "for clarity" — that's a different keychain partition.

**For each non-default account, the operator must run `claude` (or whatever wrapper sets that env) interactively at least once and complete `/login`** before any agent spawns under that profile. The login event is what populates the keychain partition. Until then, any spawn under that env will fail "Not logged in" and there is no way to programmatically recover — keychain writes require an interactive UI prompt for ACL approval.

A profile registry in cortextos (`orgs/<org>/profiles.json`) should encode this asymmetry by **letting the default profile have NO `config_dir`** (sentinel for "no override, use default keychain partition"), and only setting `config_dir` for non-default profiles whose alternate keychain partitions have already been logged-in interactively. Example:

```json
{
  "default_profile": "personal",
  "profiles": {
    "personal": {},
    "work": { "config_dir": "/Users/sauravb/.claude-work" }
  }
}
```

`Profile.config_dir` must be **optional** in TypeScript (`string | undefined`) and the spawn path must skip writing `CLAUDE_CONFIG_DIR` to env when undefined or empty.

`cortextos doctor` should fail-fast if any profile names a `config_dir` whose corresponding keychain partition has never been logged in. There is no clean programmatic test for "keychain entry exists" without prompting macOS, so the practical doctor probe is: **walk the profile registry, attempt a no-op `claude --print 'hi'` invocation under each profile's env, and surface any that return the "Not logged in" string.** Block fleet startup if any profile fails.

## Rule of thumb

If your env-var → directory mapping has TWO independent semantic effects (file path resolution AND auth partition selection), document both. Treating it purely as a path resolver and assuming "two paths that resolve to the same file are equivalent" is the trap. The auth partition is invisible from the filesystem but load-bearing at runtime.

A test for this trap class: set the env-var to a path that points to a fully populated config file you know was created by a different invocation context, and observe whether auth works. If it doesn't, you've found a partition key.

## Source incident

2026-05-08 fleet wedge cascading from BL-003 (multi-Claude-account profiles, commit `2dd35a6`). The first iteration set `personal.config_dir: /Users/sauravb/.claude` (a path inside claude's data subdir, wrong file resolution). The second iteration corrected the path to `/Users/sauravb` so claude would read `/Users/sauravb/.claude.json` (the real config with oauth). Agents got past the welcome wizard but immediately wedged on "Not logged in" — a different failure mode that looked like the same bug. ~90 minutes of patching the wrong layer (theme picker, bypass-permissions auto-accept, force-fresh markers) until the third iteration disabled the profile registry entirely; engineer immediately authenticated, confirming that `CLAUDE_CONFIG_DIR=/Users/sauravb` (same file as default) was a *different* keychain partition than no-env-set, despite reading the same file.

The user's pre-existing terminal aliases (`claude` + `claude-work=CLAUDE_CONFIG_DIR=~/.claude-work claude`) were the diagnostic — they showed the partition mechanic working correctly when each value had been independently logged-in, and showed how to encode it in a profile registry that doesn't recreate the trap.
