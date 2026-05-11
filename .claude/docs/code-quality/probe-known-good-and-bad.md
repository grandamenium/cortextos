---
domain: [tests, reliability, monitoring]
applies_to: [engineer, devops, analyst]
severity: should-know
---

# Before enabling a probe, run it against BOTH known-good AND known-bad state

**`enabled=true` in a test only proves config, not that the probe flips ok→error correctly.** Two failure modes hide here:
- Probe structurally incapable of detecting its target (false-negative-only probe).
- Probe flags healthy state as broken (false-positive-only probe).

## Pattern fix

Ritual on every new probe:
1. Run it live against a known-good system → expect `ok`.
2. Introduce the failure the probe is supposed to detect → expect `error`.
3. Restore the system → expect `ok` again.

Three states proven, not one.

## Rule of thumb

A probe that always returns `ok` proves nothing; a probe that always returns `error` is noise. The probe's value is in the transition. Validate the transition both ways before shipping.
