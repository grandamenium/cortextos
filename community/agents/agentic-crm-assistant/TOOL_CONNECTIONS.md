# Tool Connections

This template is bring-your-own-tools. Preference order for every domain, always:
**CLI > official connector / MCP > browser automation.** A CLI is scriptable,
auditable, and does not depend on a live browser session. Use browser automation
only when neither a CLI nor a connector exists.

Connecting a tool is not the same as detecting one. For each domain, the assistant
researches the right CLI for the service the user names, walks the user through
install + auth on the fly, and **verifies with a real read** before moving on. Full
procedure in `tool-discovery/SKILL.md`.

## Setup Order

1. Detect installed CLIs and MCP servers with `tool-discovery`.
2. Ask the user which service they use for each domain.
3. For each named service: prefer a CLI. If the CLI is unknown, research it live
   (its install + auth flow) before instructing the user. Fall back to
   connector/MCP, then browser, only if no CLI exists.
4. Walk the user through auth in-conversation. Hand them the exact command to run
   themselves so secrets land in the tool's own store, `.env`, or org
   `secrets.env` — never in chat.
5. Verify the connection with a real action and report it. Record configured +
   verified tools in `TOOLS.md`.
6. Keep local CRM files as the relationship audit trail unless the user chooses a
   different source of truth.

## Domains

| Domain | Examples | Required? | Notes |
|---|---|---:|---|
| Email | Gmail, Outlook, IMAP, provider CLI, MCP | Optional | Needed for inbox triage and relationship interaction extraction. |
| Calendar | Google Calendar, Outlook Calendar, CalDAV, MCP | Optional | Needed for meeting prep and daily schedule reviews. |
| Meeting Notes | Granola, Fathom, Fireflies, Zoom transcripts, local files | Optional | Needed for automated meeting-note processing. |
| Messaging | iMessage (local Messages DB), other messenger CLIs | Optional | Reads for relationship interactions; outbound sends always gated by approval rules. |
| Contacts | Google Contacts, phone contacts export, external CRM, CSV | Optional | Can seed `crm/contacts.json`. |
| CRM | HubSpot, Pipedrive, Airtable, Notion, Salesforce, local files | Optional | Local files remain default if no CRM is connected. |
| Browser | agent-browser, Playwright profile, headed browser | Optional | Use for sites without API access. |

## Environment Placeholder File

Copy `.env.example` to `.env` only for non-secret labels and local settings.
Secrets should stay in the secure secret store used by the deployment.
