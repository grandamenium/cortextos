---
domain: [fleet-coordination, audits, refactor]
applies_to: [analyst, engineer, devops, fullstack, boss]
severity: blocker
---

# Auditor-misses-themselves: agent propagating a fleet-wide change overlooks their own templates

**A change that applies to "all agent / orchestrator / analyst templates" must include the *propagating* agent's own template — but the propagator's blind-spot is exactly where their attention isn't.**

## Pattern fix

Before declaring a fleet-wide template propagation complete, run an explicit mechanical audit step:

```bash
for role in agent orchestrator analyst <other roles>; do
  grep -L "<new content marker>" \
    templates/$role/CLAUDE.md \
    templates/$role/AGENTS.md \
    community/agents/$role/CLAUDE.md \
    community/agents/$role/AGENTS.md
done
```

Empty output means all four files for every role contain the marker; non-empty output names the gaps. **The propagator's own role MUST appear in the role-list.** Never trust subjective "I checked everything" when one of the things to check is the propagator's own template.

## Rule of thumb

Any fleet-wide change has a self-blindspot at exactly the role doing the change. Make the audit mechanical (grep -L over an explicit role list, including the propagator's own), not human.

## Source incident

Micro-retro 2026-05-08 — analyst (Banner) wired the new code-quality.md reference into agent + orchestrator templates (and their community mirrors) cleanly across two phases, then drafted a PR. pr-deep-evaluator caught two blockers: `templates/analyst/{CLAUDE.md,AGENTS.md}` and `community/agents/analyst/{CLAUDE.md,AGENTS.md}` were never updated. Pure self-blindspot.
