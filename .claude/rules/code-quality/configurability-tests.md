---
domain: [tests, config, deployment]
applies_to: [engineer, devops, fullstack]
severity: should-know
---

# Configurability requirements need explicit consumer-wiring tests

**A brief that names a config file (TOML/JSON/env) MUST have a regression test asserting (a) the file is loaded by a real production code path, AND (b) a non-default value flows through to the documented behavior.**

## Pattern fix

For every config requirement in a brief, add a test that:
1. Writes a config file with a non-default value.
2. Drives the consumer code path (the function/CLI/handler that the brief says reads the config).
3. Asserts the consumer's behavior changed because of (1).

A test that just opens the file and parses it doesn't satisfy this — you've validated the parser, not the wiring.

## Rule of thumb

If the brief says "configurable in `<path>`," grep your code for `<path>` or the config-loader API BEFORE shipping. If neither appears, the config file is decoration, not configuration.
