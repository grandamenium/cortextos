---
name: reddit-fetch
description: Read Reddit via the official OAuth API. Subreddit search, post + comment trees, user-history queries. 100 req/min authed, polite cadence.
allowed_tools: [Bash, Read]
---

# reddit-fetch

Reddit data via the official OAuth API. Used by the research-team for community sentiment, primary-source discussions, niche-topic surveying.

## Auth

Reddit requires OAuth for any production-volume access (unauthed JSON endpoints are rate-limited to ~1 req/sec). HARPAL uses **script-type** OAuth (machine-to-machine; no user redirect dance).

Setup (one-time, by Hari):
1. https://www.reddit.com/prefs/apps → "create another app..."
2. Type: **script**
3. Name: `harpal-research`
4. Redirect URI: `http://localhost:8080` (unused for script-type, but required)
5. Get `client_id` (under the app name) and `client_secret` (the "secret" line)

Wire credentials into `~/.cortextos/default/secrets.env` (or per-instance equivalent):

```
REDDIT_CLIENT_ID=<from-reddit-prefs-apps>
REDDIT_CLIENT_SECRET=<from-reddit-prefs-apps>
REDDIT_USER_AGENT="harpal-research/0.1 by <hari-username>"
REDDIT_USERNAME=<hari-reddit-username>
REDDIT_PASSWORD=<hari-reddit-password-or-app-password>
```

Reddit's script-type OAuth requires the user's password (not great, but it's the API). For safer ops use a dedicated bot account.

## Capabilities

| Tool | Purpose |
|---|---|
| `bin/reddit.sh search <query> [--sub <name>]` | Search Reddit (across or within subreddit) |
| `bin/reddit.sh top <subreddit> [--time hour|day|week|month|year|all]` | Top N posts in subreddit |
| `bin/reddit.sh hot <subreddit> [--limit N]` | Hot N posts |
| `bin/reddit.sh post <subreddit> <post-id>` | Full post + comment tree (depth-limited) |
| `bin/reddit.sh user <username>` | User profile + recent posts/comments |
| `bin/reddit.sh subreddit-about <name>` | Subreddit metadata (subscriber count, description, rules) |

All commands emit structured JSON.

## Rate limits

Reddit's official policy: 100 requests per OAuth client per 10 minutes (script-type). reddit-fetch enforces this with a sleep-between-calls fallback when bursty patterns are detected. For deep-recursion comment trees, expect natural pauses.

## When to use

- Find community discussion around a topic (e.g. "what does r/MachineLearning think about transformer X?")
- Surveying a niche subreddit for sentiment / experience reports
- User-history check (a researcher cited by someone? what else have they posted?)
- Triangulating with HN: same topic on r/programming vs Hacker News → different community lenses

## Not for

- Posting / commenting / voting — read-only by design (no write scopes requested)
- Real-time monitoring — Reddit isn't built for it; use Pushshift mirror or a separate streaming client
- Image/video downloads — use yt-dlp for those (which supports Reddit hosted media)

## Output format

```json
{
  "verdict": "ok",
  "endpoint": "search",
  "n_results": 25,
  "items": [
    {
      "subreddit": "...",
      "title": "...",
      "author": "...",
      "score": 1234,
      "num_comments": 56,
      "url": "https://reddit.com/r/.../comments/...",
      "permalink": "/r/.../comments/...",
      "created_utc": 1234567890,
      "selftext": "(first 500 chars)",
      "is_self": true|false
    },
    ...
  ]
}
```

## Limits + cautions

- **ToS**: read-only API access via OAuth is fully permitted. Don't scrape HTML; use the API.
- **Anti-bot signals**: be a citizen — User-Agent must identify you as a bot (`REDDIT_USER_AGENT` env), don't burst, respect rate limits.
- **Subreddit privacy**: private subreddits return 403 even with valid auth unless your user account is a member.
- **NSFW filter**: defaults on (no `include_over_18` flag). Add `--nsfw` to opt in if researching content that requires it.
