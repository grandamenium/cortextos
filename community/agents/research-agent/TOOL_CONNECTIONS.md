# Tool Connections

This template is tool-agnostic. Configure only the tools you need.

## Local Tools

- `sqlite3` for inspecting `research/db/signals.db`
- `rg` for searching generated output
- `git` / `gh` for GitHub sources when available

## Optional Credentials

Put credentials in `.env`, org secrets, connector configuration, or the relevant provider's auth flow. Never paste secrets into chat.

| Credential | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub search and higher rate limits |
| `APIFY_TOKEN` | Optional social discovery and transcript enrichment |
| `CTX_TELEGRAM_CHAT_ID` | Existing cortextOS Telegram destination used by `cortextos bus send-telegram` |
| `SLACK_WEBHOOK_URL` | Slack delivery |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Optional Reddit OAuth |

External delivery requires approval unless setup explicitly configures autonomous delivery.
