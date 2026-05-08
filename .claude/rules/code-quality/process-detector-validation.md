---
domain: [subprocess, reliability, detection]
applies_to: [engineer, devops]
severity: should-know
---

# Process detectors must be validated against a real running instance

**Argv formats drift across versions/wrappers** (bun's `exec` strips path; Node's `--inspect` rewrites argv). A detector that worked on yesterday's build silently breaks on today's.

## Pattern fix

Run the detector once against `ps -A` output and verify count = reality:

```bash
expected=$(actually_count_processes_some_other_way)
detected=$(your_detector)
[[ "$expected" == "$detected" ]] || fail "detector miscount"
```

If identity is in cwd / env / fds rather than argv, detect on that instead — those are more stable than argv across version bumps.

## Rule of thumb

A process detector is a runtime contract with the OS's argv format. That contract is not stable across versions. Validate against reality at install time AND in CI.
