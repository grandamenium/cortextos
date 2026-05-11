---
domain: [cli, templates, documentation]
applies_to: [engineer, devops, fullstack, analyst, boss]
severity: should-know
---

# Bus CLI flag set is the source of truth, not template prose

**Templates accumulate flag references that drift from the actual CLI.** cortextOS HEARTBEAT.md template referenced `kb-ingest --collection <name>` — that flag does not exist; the actual flags are `--org`, `--agent`, `--scope shared|private`, `--force`. Same trap on `list-tasks --project <name>` — `--project` doesn't exist; the actual filters are `--agent`, `--status`, `--assignee`.

## Pattern fix

Every template that mentions a flag must be regression-tested against `<command> --help` at template-author time AND when the CLI changes. Run the command with `--help` first and copy the flag verbatim from the output, never from memory or another template.

## Rule of thumb

Templates are source-of-truth-shaped but they're stale-shaped too. If you're writing prose that names a CLI flag, run the command with `--help` first. Templates inherit this trap by copy-paste.

## Source incident

Micro-retro 2026-05-05 — both flag references caught during analyst onboarding when commands errored out; engineer + analyst both lost ~5 min each before identifying the templates were wrong.
