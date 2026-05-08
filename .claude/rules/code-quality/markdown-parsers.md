---
domain: [parsers, regex, text-processing]
applies_to: [engineer, devops, fullstack]
severity: blocker
---

# Don't write ad-hoc markdown parsers with single-pass regex

**Markdown looks string-shaped but is structural:** `#` is a header at line start outside code fences, shell syntax inside ```` ``` ```` blocks, and a literal char in `` `inline` ``. A regex that "finds the next header" will pass the trivial test, ship, and then fail every time worker output uses a slightly different — but valid — markdown shape.

## Pattern fix

Either:
1. **Use a real CommonMark parser** (`marked`, `markdown-it`, `remark` for Node; `markdown-it-py`, `commonmark` for Python).
2. **Strip fenced regions and inline code first**, THEN run a structural pass on what remains.

If you must regex, the test list MUST include:
- Nested sub-headers
- Fenced code with `#` lines
- Fenced code with `~~~` markers
- Indented code blocks
- Inline-code with backticks
- Blockquoted headers

Cover the *class*, not the surface case.

## Rule of thumb

Per-symptom rules don't generalize. Write rules that name the *class of trap* you fell into. Markdown parsing is structural — single-pass regex is a class-of-trap, not a per-bug fix.

## Source incident

Cortextos has hit this trap; jarvis hit it three times in one session.
