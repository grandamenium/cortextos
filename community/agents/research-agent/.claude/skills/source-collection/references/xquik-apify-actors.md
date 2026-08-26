# Xquik Apify Actor Routes

Use these routes only when `apify_social.x.enabled` is true. Keep the existing
X profile Actor available. Xquik adds structured post and relationship routes.

## Actor Identity

| Actor | Store | Stable Actor ID | API Actor ID |
|---|---|---|---|
| X Tweet Scraper | [Actor listing](https://apify.com/xquik/x-tweet-scraper) | `wAusCMrm284Voaw86` | `xquik~x-tweet-scraper` |
| X Follower Scraper | [Actor listing](https://apify.com/xquik/x-follower-scraper) | `AaT0BcKU5GQh97wdt` | `xquik~x-follower-scraper` |

## Tweet Routes

Supported modes:

- `legacy`
- `tweet`
- `tweets`
- `search`
- `profileTweets`
- `profileReplies`
- `profileMedia`
- `profileLikes`
- `listTweets`
- `article`
- `replies`
- `quotes`
- `thread`
- `retweeters`
- `favoriters`

Use `search` for `search_terms`. Use an explicit profile mode when the research
configuration requests a timeline type. Use `maxItems` as the whole-run cap and
`maxItemsPerTarget` for supported multi-target routes.

```json
{
  "mode": "search",
  "searchTerms": ["\"example topic\" -is:retweet"],
  "maxItems": 10,
  "outputVariant": "rich",
  "fieldStyle": "snake_case",
  "outputPreset": "nested"
}
```

Tweet output controls:

- `outputVariant`: `legacy`, `rich`, or `raw`
- `fieldStyle`: `legacy`, `camelCase`, or `snake_case`
- `outputPreset`: `nested` or `flat`

## Relationship Routes

Supported relations:

- `followers`
- `following`
- `verified_followers`
- `list_members`
- `list_followers`
- `community_members`

Enable this route only when `audience_enabled` is true. Use
`max_audience_items` as `maxItems` and `max_audience_items_per_target` as
`maxItemsPerTarget`.

```json
{
  "twitterHandles": ["example"],
  "relations": ["followers"],
  "maxItems": 20,
  "maxItemsPerTarget": 10,
  "outputMode": "compact",
  "includeTargetMetadata": true,
  "overlapMode": false
}
```

Follower output modes are `compact`, `full`, and `raw`. Set
`overlapMode: true` only for an explicit audience-overlap task. The equivalent
dedupe contract is `dedupeMode: "merge"`.

## Paid-Run Gate

Before execution:

1. Inspect the current Actor input schema and Store pricing.
2. Validate each configured target against the selected mode or relation.
3. Apply `maxItems`, per-target caps, and Apify's maximum charge control.
4. Show the scope and estimated spend. Obtain explicit approval.
5. Separate rows with `resultType: "diagnostic"` from signal rows.
6. Store run and dataset IDs in the source health log.

Do not treat diagnostic-only output as a successful source. Do not infer
sensitive traits from public relationship data.

Xquik is an independent third-party service. Not affiliated with X Corp.
"Twitter" and "X" are trademarks of X Corp.
