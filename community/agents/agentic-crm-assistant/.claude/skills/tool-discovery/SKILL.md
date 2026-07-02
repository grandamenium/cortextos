---
name: tool-discovery
description: "Discover, research, and CONNECT the tools a tool-agnostic personal assistant needs — email, calendar, contacts, meeting notes, messaging, CRM. CLI-first, research-driven, verified. Use during setup and whenever a workflow fails because a tool is missing or not authed."
---

# Tool Discovery + Connect Skill

Two jobs: (1) detect what is already installed and authed, and (2) for every
domain the user names a service for, **research the right CLI, walk the user
through connecting it, and verify it actually works** — in the Telegram
conversation, on the fly.

Preference order for every domain, always: **CLI > official connector / MCP >
browser automation.** A CLI is scriptable, auditable, and does not depend on a
live browser session. Only fall back when the tier above genuinely does not exist.

Never ask for secrets in chat. Hand the user the exact auth command to run
themselves (in-session with the `! <command>` prefix, or in their own terminal)
so the token lands in the tool's own secure store, not the transcript.

---

## Step 1 — Detect what is already here

```bash
for cmd in gog gh agent-browser peekaboo sqlite3 jq rg; do
  if command -v "$cmd" >/dev/null; then echo "$cmd: $(command -v "$cmd")"; fi
done
test -f .mcp.json && cat .mcp.json
env | grep -E 'GMAIL|GOOGLE|OUTLOOK|NOTION|ZOOM|FATHOM|FIREFLIES|GRANOLA|HUBSPOT|PIPEDRIVE|AIRTABLE|CRM' | sed 's/=.*/=<configured>/'
```

Anything already installed AND authed: record it and skip to verify. Everything
else goes through the connect loop below.

---

## Step 2 — The connect loop (run once per domain)

Domains the CRM assistant covers: **email, calendar, contacts, meeting notes,
messaging (e.g. iMessage), external CRM.** For each one the user says they use:

### 2a. Ask what service they use for this domain
"What do you use for meeting notes — Granola, Fathom, Fireflies, Zoom, something
else?" One domain at a time. Wait for the answer on Telegram.

### 2b. Identify the CLI (prefer CLI). Research it if you do not know it.
- If you already know the CLI (Google -> `gog`, GitHub -> `gh`), use it.
- If you do NOT know the CLI for the named service, **research it live** before
  asking the user to do anything:
  - WebSearch: "<service> official CLI", "<service> command line auth".
  - WebFetch the tool's install + auth docs.
  - Confirm the actual command and its auth subcommand (do not guess).
  - If the service is already installed locally, read its real help:
    `<cli> --help`, `<cli> auth --help`.
- Decide the tier: real CLI found -> CLI. No CLI but an MCP/connector exists ->
  connector. Neither -> browser automation (agent-browser / headed profile) as
  the last resort, and say so plainly.

### 2c. Walk the user through install + auth (in chat, on the fly)
Give exact, copy-pasteable steps grounded in what you just researched:
- Install: the real install command (e.g. `brew install ...`, `npm i -g ...`).
- Auth: the real auth command, run BY THE USER so no secret hits the chat. Tell
  them to type it in-session with the `!` prefix, e.g.:
  `! gog login you@example.com`
  (Google opens a browser consent, stores a refresh token locally.)
- If the flow needs an API key/token, tell them exactly where to create it and
  where it goes (tool config, `.env`, or org `secrets.env`) — never in chat.

### 2d. Verify with a REAL action (do not trust presence)
Prove the connection works before moving on, with the lightest real read:
- Email/Calendar (gog): `gog auth status`, then a 1-item read
  (list 1 recent email / today's events).
- Messaging (iMessage): a bounded read of the local Messages DB or the messaging
  CLI's status/list, scoped to a safe test.
- Meeting notes: list the most recent note/transcript.
- External CRM: fetch 1 record.
Report the result in Telegram ("Google connected — I can see your inbox and today's
calendar"). If verify fails, debug the auth with the user; do not mark it done.

### 2e. Record it, then loop
Append to `TOOLS.md` and move to the next domain.

---

## Worked examples

- **Google (email + calendar + drive):** CLI = `gog`. Install if missing, then
  `! gog login <email>`; verify `gog auth status` + list today's calendar.
- **iMessage (messaging):** macOS local. Prefer a messaging CLI / bounded reads of
  the local Messages SQLite DB; verify by reading the latest message safely. No
  outbound sends without the approval rule. If no clean CLI exists, say so and
  propose the connector/automation fallback.
- **Meeting notes:** ask which tool (Granola/Fathom/Fireflies/Zoom). Research that
  tool's CLI or export path live, walk the user through auth, verify by listing the
  latest transcript.

---

## Record Results

Append a `## Configured Tools` section to `TOOLS.md` with, per tool:

- domain + provider
- command or connector name (the tier used: CLI / connector / browser)
- account identifier, if safe
- read/write capability
- approval requirement
- **verified:** yes/no + how (the real action you ran)
- fallback path

Never write secrets to `TOOLS.md`.
