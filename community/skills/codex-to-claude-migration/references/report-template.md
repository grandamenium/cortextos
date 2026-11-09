# Migration Report: <source> (codex-app-server) -> <target> (claude-code)

Mode: DRY-RUN | APPLIED          Date: <iso>

## END STATE (lead with the ONE line matching convert.py's `end_state`)
- disabled: **Ready — <source> is untouched; run `cortextos enable <target> --org <org>` when you're happy.**
- live:     **<target> is live on its own bot; <source> is still running untouched.**

## Summary
- Model:        <codex model> -> <claude id> (from `cortextos bus list-models claude-code`)
- Skills:       N bundled (free from skeleton) · M custom copied · K needs-human
- Crons:        N carried (UNION config + registry) · disabled-state preserved
- MCP:          N servers -> .mcp.json (refs only) · skipped: <name (reason)>
- Bot:          BOT_TOKEN not carried (source keeps the bot) | NEW bot token written
- Verify:       Tier 1 <n/n> · Tier 2 boot probe <pass|fail|not-run>

## HARD STOPS (none = good)
- <e.g. source runtime is not codex-app-server>

## SECURITY FINDINGS
- Inline secret in ~/.codex/config.toml at <location> — NOT copied. Consider moving it
  to an env var on the codex side as well.

## NEEDS HUMAN (target stays DISABLED until resolved)
- Env vars to set in orgs/<org>/secrets.env: <VAR (secret|config, from <location>, defined?)>
- Codex wording in instruction files: <file: lines> — edit for Claude.
- Custom skill "<x>" has codex behavioral leakage <tokens> — not copied; rewrite.
- Bundled skill "<x>" differs from the codex template — stock claude copy used; port by hand.
- Not carried: <item (reason: >100 MB / virtualenv)> — copy or recreate if needed.
- Stale .claude/skills residue in source: <names> — not carried.
- Once-crons carried as records: <name (fire_at)> — confirm still wanted.

## GAINED (no action)
- Claude hooks from the skeleton: plan-mode, AskUserQuestion and PreCompact Telegram
  hooks (absent on codex), plus idle/context/crash hooks.

## Transformed
- config.json, AGENTS.md (skill paths), CLAUDE.md (@AGENTS.md), skills -> .claude/skills,
  crons, .mcp.json, .env (no BOT_TOKEN), state (.onboarded carried, .force-fresh).

## Carried 1:1
- IDENTITY/SOUL/GUARDRAILS/HEARTBEAT/USER/SYSTEM/MEMORY/GOALS/TOOLS/ONBOARDING, goals.json,
  memory/, workspaces, <port_verbatim list>; large/binary items listed for review.

## How to finish
    # after resolving needs-human items and setting env vars:
    cortextos enable <target> --org <org>
    # the codex source keeps running; disable it only when you choose to:
    #   cortextos disable <source> --org <org>
