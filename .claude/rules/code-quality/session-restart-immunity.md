---
domain: [state, fleet-coordination, daemon]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Session-restart immunity for state files

**State files keyed on `session_id` are load-bearing tech debt — sessions die and resume.** Use `(abs_path, wallclock_bucket)` or content hashes as join keys. `session_id` may appear as a forensic tag, never as a lookup key.

## Pattern fix

When designing on-disk state that must survive across session restarts:
- Key on stable identifiers: file paths, content hashes, wallclock buckets, agent names, org names.
- `session_id` is volatile by design — every restart mints a new one. Lookup tables keyed on it become orphaned silently.
- If you need to correlate "what session wrote this," store `session_id` as a metadata field, not as the primary key.

## Rule of thumb

If a state file's join column changes value every time the agent reboots, you've built session-restart-fragile state. Sessions die; lookups must not.
