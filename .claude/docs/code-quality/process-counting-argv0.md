---
domain: [subprocess, process-detection]
applies_to: [engineer, devops]
severity: should-know
---

# Process counting matches argv[0], not substrings

**Parents preserve children's argv via wrappers (`tmux`, `bash -c`, `sudo`, `env`).** A substring grep over `ps` output picks up the wrapper's argv too, double-counting or hiding the real process.

## Pattern fix

Use a structured argv-aware matcher (`pgrep -af` with `--exact`, or programmatic `ps -A -o args`). Reserve substring grep for "any process whose argv mentions X" — different question.

## Rule of thumb

If your process counter says "3 instances running" when you expect 1, check whether wrappers are inflating the count. argv[0] is the canonical identity; substring is fuzzy.
