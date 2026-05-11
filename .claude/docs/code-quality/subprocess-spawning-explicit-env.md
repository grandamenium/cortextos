---
domain: [subprocess, daemon, supervisors]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Subprocess spawning — explicit env, not bash -c

**Don't wrap commands in `bash -c` in worker contexts.** Bash inherits a minimal PATH (especially under launchd or systemd), so commands that worked from your interactive shell fail silently from the spawned process.

## Pattern fix

- Pass an explicit env dict with PATH prepended to the runtime's structured spawn API.
- Node: `child_process.spawn(cmd, args, { env: { ...process.env, PATH: '...' } })`.
- Python: `subprocess.run(args, env={...})` with explicit PATH.
- node-pty: `pty.spawn(cmd, args, { env: ptyEnv })` — pass env natively, don't shell-out.

## Rule of thumb

If your subprocess command needs aliases, functions, or shell features to resolve, you're using the wrong spawn API. Aliases die at the shell boundary; structured spawn bypasses the shell entirely. Want PATH-resolution behavior? Build the env dict yourself.
