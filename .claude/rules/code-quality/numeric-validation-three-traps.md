---
domain: [validation, json, types]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Numeric validation from JSON/TOML has multiple traps in one line

**TypeScript: `typeof x === 'number'` is true for `NaN`, `Infinity`, `-Infinity`, and integers AND floats.** Naive validators that accept these values leak through into business logic.

## Pattern fix

Explicit predicate per case:
- **Counts:** `Number.isFinite(x) && Number.isInteger(x) && x >= 0`
- **Positive durations:** `Number.isFinite(x) && x > 0`
- **Percentages:** `Number.isFinite(x) && x >= 0 && x <= 100`
- **Python equivalent:** `isinstance(x, int) and not isinstance(x, bool)` (because `bool` is a subclass of `int` in Python).

## Rule of thumb

`typeof x === 'number'` is a type guard, not a value guard. Every numeric-input boundary needs a predicate that's tighter than the type system's primitive name. Write the predicate, not the typeof.
