# linkedin-poster-selfhost

Self-hosted LinkedIn engagement service running on the Linux server. Uses Playwright persistent browser contexts (one per LinkedIn user) — no external browser-as-a-service needed.

## Architecture

- **HTTP server** (default port 3100) exposes 4 action endpoints + `/health`
- **BrowserManager** owns a single `chromium.launchPersistentContext` per process instance
- **inFlight guard** prevents concurrent LinkedIn actions; 30 s minimum gap between actions
- **Heartbeat loop** (60 s) POSTs browser health + status to `poster_heartbeats` Supabase table

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_KEY` | yes | — | Supabase service-role key |
| `PROFILE_DIR` | no | `/var/lib/linkedin-poster/profiles/default` | Chromium profile directory |
| `USER_ID` | no | `default` | Logical user identifier (used in heartbeat agent_name) |
| `SENDER_NAME` | no | `LinkedIn Poster` | Display name for logs |
| `SENDER_LINKEDIN_ID` | no | `` | LinkedIn member ID (for reference) |
| `PORT` | no | `3100` | HTTP listen port |

## Running

```bash
npm install
npm run build

# Per-user instance
SUPABASE_URL=... SUPABASE_KEY=... \
PROFILE_DIR=/var/lib/linkedin-poster/profiles/greg \
USER_ID=greg \
SENDER_NAME="Greg Harned" \
npm start
```

## Seeding a Login Profile (P2 — login CLI)

Run on **Greg's Mac** to seed a fresh profile, validate it, and rsync to the server.

```bash
# First run (one-time): create the base directory on the server
ssh cortextos@100.84.86.6 "sudo mkdir -p /var/lib/linkedin-poster/profiles && sudo chown cortextos:cortextos /var/lib/linkedin-poster"

# Seed / refresh a user profile
npm run login -- --user greg --server cortextos@100.84.86.6

# Custom remote base (optional)
npm run login -- --user greg --server user@host --remote-base /custom/path
```

What the CLI does:
1. Creates a fresh temp profile at `/tmp/poster-login-<user>/` (never touches the existing rgos-linkedin-poster Chrome profile)
2. Launches **headed** Chromium — you log in to LinkedIn in the window, including 2FA
3. Waits up to 5 minutes for auth to complete
4. Validates the session by visiting the feed and checking for an authed DOM element
5. **Only rsyncs** after validation passes — bad profiles never reach the server
6. Cleans up temp dir

The remote profile lands at `/var/lib/linkedin-poster/profiles/<user>/`.

## Endpoints

### GET /health
Returns `{ ok: boolean, userId: string }`. HTTP 200 if session is valid, 503 if not.

### POST /comment
```json
{ "postUrl": "https://www.linkedin.com/feed/update/...", "commentText": "Great post!" }
```

### POST /connect
```json
{ "profileUrl": "https://www.linkedin.com/in/someone/", "noteText": "Optional note" }
```

### POST /dm
```json
{ "profileUrl": "https://www.linkedin.com/in/someone/", "messageText": "Hey!" }
```

### POST /post
```json
{ "postText": "My update...", "imagePaths": ["/tmp/img1.jpg"] }
```
`imagePaths` is optional.

## Roadmap

- **P1 (done)**: Scaffold + Playwright actions (postComment, connect, DM, publishPost)
- **P2**: Mac-side login CLI — launch persistent context on Mac, rsync profile to server
- **P3**: Daemon/queue consumer integration, per-user process management, RGOS task routing
