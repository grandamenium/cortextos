---
domain: [data-promotion, llm, ai-orchestration]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: blocker
---

# Never auto-create canonical objects from arbitrary text references

**Promotion to a canonical store (entity files, db rows, vault items) must be explicit (user action) or human-confirmed via a triage inbox.** Auto-extraction goes to a queue, not directly to the store.

## Pattern fix

Two-stage pattern:
1. **Extraction**: scan input, detect entity-like references, emit candidates to a triage queue with source-trace metadata.
2. **Promotion**: explicit user action OR human-reviewed triage flips a candidate to canonical.

Never collapse the two stages. The cost asymmetry is severe: a false-positive in extraction is queue noise; a false-positive in promotion is a polluted canonical store that takes manual cleanup.

## Rule of thumb

If your code path is "LLM said X exists → canonical store now has X," you've skipped the triage layer. Every canonical store needs a triage inbox between extraction and promotion.
