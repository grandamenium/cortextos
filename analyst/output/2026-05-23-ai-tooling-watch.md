# AI Tooling Watch - 2026-05-23

Scan window: 2026-05-22T16:03:38Z to 2026-05-23T16:03:38Z.
RGOS task: 945f065f.

## Summary

Actionable items found: 2.

Created RGOS follow-up tasks:

- task_1779552395884_39206245 - Triage Claude Code v2.1.149 bake-in impact
- task_1779552396628_03854827 - Review Claude CI workload identity federation commit

Local baselines observed:

- codex-cli 0.125.0
- Claude Code 2.1.145

## Findings

### Claude Code releases

Source hierarchy used:

1. GitHub Releases API: https://api.github.com/repos/anthropics/claude-code/releases?per_page=20
2. GitHub releases Atom feed: https://github.com/anthropics/claude-code/releases.atom
3. Watch-only feed/changelog: https://raw.githubusercontent.com/anthropics/claude-code/main/feed.xml and https://api.github.com/repos/anthropics/claude-code/commits?path=feed.xml&per_page=20

In-window releases by canonical GitHub release `published_at`:

- v2.1.150, published 2026-05-23T04:03:51Z
  - Source: https://github.com/anthropics/claude-code/releases/tag/v2.1.150
  - Notes: internal infrastructure improvements, no user-facing changes.
  - Bake-in applicability: no action for cortextos wrapper, hub.revopsglobal.com, team-brain wiki pipeline, recipe app, or charlie-holstine site.

- v2.1.149, published 2026-05-22T22:09:29Z
  - Source: https://github.com/anthropics/claude-code/releases/tag/v2.1.149
  - Notes: includes `/usage` per-category breakdown including skills/subagents/plugins/per-MCP-server cost, `/diff` keyboard scrolling, GFM task-list rendering, `allowAllClaudeAiMcps` managed setting, PowerShell permission/sandbox fixes, git worktree sandbox allowlist fix, Bash `find` crash fix, managed-settings terminal-freeze fix, and several terminal/session fixes.
  - Bake-in applicability:
    - cortextos wrapper: actionable. Permission/sandbox behavior, MCP cost reporting, terminal output, and worktree allowlist changes should be triaged before upgrade from local Claude Code 2.1.145.
    - hub.revopsglobal.com: possible indirect impact if it depends on Claude Code automation or managed settings.
    - team-brain wiki pipeline: possible indirect impact only if pipeline uses Claude Code automation/MCP usage reporting.
    - recipe app: no direct impact.
    - charlie-holstine site: no direct impact.
  - Action: created task_1779552395884_39206245.

Out-of-window by canonical GitHub release `published_at`:

- v2.1.148, published 2026-05-22T01:16:52Z, excluded from this window.

Watch-only feed/changelog:

- feed.xml updated 2026-05-23T04:03:45Z for v2.1.150 and 2026-05-22T22:09:22Z for v2.1.149. Treated only as feed seen/publication evidence, not canonical release_date.

### Anthropic blog/news

Source: https://www.anthropic.com/news

- Project Glasswing: An initial update, dated May 22, 2026
  - Source: https://www.anthropic.com/research/glasswing-initial-update
  - Timestamp note: official page presents date-only publication, so exact inclusion in the UTC 24h window is ambiguous.
  - Bake-in applicability: security posture/watch memo only. No direct Claude Code or wrapper-breaking behavior found. No RGOS task created.

### Claude Code / claude_agent_sdk commits

Requested source: https://api.github.com/repos/anthropics/claude-code/commits?since=2026-05-22T16:03:38Z&per_page=20

In-window commits:

- 39e853e, 2026-05-23T04:03:45Z, `chore: Update CHANGELOG.md and feed.xml`
  - Source: https://github.com/anthropics/claude-code/commit/39e853e4074d90f27afdfb7ea601e0fc378bd0c5
  - Bake-in applicability: monitor only.

- 5ef2f06, 2026-05-22T22:55:40Z, `Use workload identity federation for Claude auth in CI workflows (#61584)`
  - Source: https://github.com/anthropics/claude-code/commit/5ef2f06c6aa0d97531274bce62907721cde190ec
  - Bake-in applicability:
    - cortextos wrapper: actionable if RGOS uses Claude GitHub Actions or static `ANTHROPIC_API_KEY` in CI.
    - hub.revopsglobal.com: actionable if platform CI has Claude auth workflows.
    - team-brain wiki pipeline: no direct impact unless Claude CI automation is used.
    - recipe app: no direct impact unless repo CI invokes Claude workflows.
    - charlie-holstine site: no direct impact unless repo CI invokes Claude workflows.
  - Action: created task_1779552396628_03854827.

- 64e5382, 2026-05-22T22:09:22Z, `chore: Update CHANGELOG.md and feed.xml`
  - Source: https://github.com/anthropics/claude-code/commit/64e53823deb2b8e007c41cb6da5ac75264c3394d
  - Bake-in applicability: monitor only.

### OpenAI Codex changelog / releases

Official changelog source: https://developers.openai.com/codex/changelog

- No official OpenAI Codex changelog entries dated inside the scan window.
- Latest official Codex changelog entries found were dated 2026-05-21, including Codex CLI 0.133.0 and "Appshots, goal mode, and more", outside the requested window.

Supplemental GitHub release check:

- openai/codex had 0.134.0-alpha.1, 0.134.0-alpha.2, and 0.134.0-alpha.3 GitHub releases inside the window:
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.1
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.2
  - https://github.com/openai/codex/releases/tag/rust-v0.134.0-alpha.3
- Release bodies only say alpha release, with no detailed changelog. Treat as watch-only until the official Codex changelog or stable release notes publish details.
- Bake-in applicability:
  - cortextos wrapper: watch-only because local codex-cli is 0.125.0 and alpha tags may precede app-server/permission-profile changes.
  - hub.revopsglobal.com: no immediate action.
  - team-brain wiki pipeline: no immediate action.
  - recipe app: no immediate action.
  - charlie-holstine site: no immediate action.

### OpenAI cookbook commits

Requested source: https://api.github.com/repos/openai/openai-cookbook/commits?since=2026-05-22T16:03:38Z&per_page=20

- Result: no commits in the scan window.
- Bake-in applicability: no action for all tracked stacks.

### Relevant MCP server releases

Search source: web search for `MCP server release 2026`, last 24h, with primary-source verification preferred.

- No primary-source MCP server release was verified inside the scan window.
- MCP Toplist updated 2026-05-23T03:47:00Z and tracks MCP ecosystem activity, but it is an aggregator and not a release source: https://mcptoplist.com/
- Nearby out-of-window protocol item: MCP protocol release candidate dated May 21, 2026, with stateless core, MCP Apps, Tasks extension, OAuth/OIDC-aligned auth, and deprecation policy implications. Source: https://blog.modelcontextprotocol.io/tags/mcp/
  - Carry-forward applicability: high for cortextos wrapper, hub.revopsglobal.com, and team-brain wiki pipeline, but outside this 24h scan window. No new task created from this scan.

## Ingest decision

Because actionable items were found and RGOS tasks were created, ingest this memo to the shared RevOps Global KB.
