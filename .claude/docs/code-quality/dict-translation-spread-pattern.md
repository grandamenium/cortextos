---
domain: [data-translation, tests, type-safety]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Translating object A → B with explicit field-list silently drops fields the upstream adds later

**When you write `out = { id: t.id, title: t.title, ... }`, the test that checks each named field passes forever, but the moment upstream `t` gains a new field that callers downstream depend on, your translation drops it without a peep.**

## Pattern fix

**Spread first, override only what differs:**

```ts
// BAD — silently drops new fields
out = { id: t.id, title: t.title, status: t.status };

// GOOD — pass-through with explicit overrides
out = {
  ...source,
  ...overrides_for_renamed_fields,
  derivedField: computeDerived(source),
};
```

**Test fix:** at every translation boundary, add at least one positive round-trip assertion: `expect(out.description).toBe(source.description)`, not just `expect(out.id).toBe(t.id)`.

## Rule of thumb

Field-list translations are version-controlled assumptions about which upstream fields exist. Every upstream schema change is a silent translation regression. Spread + override is the only translation pattern that survives upstream growth.
