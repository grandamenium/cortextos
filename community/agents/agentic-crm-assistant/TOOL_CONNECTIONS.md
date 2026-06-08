# Tool Connections

This template is bring-your-own-tools. Prefer official connectors, MCP servers,
or provider CLIs when available. Use browser automation only when a supported API
or connector is unavailable.

## Setup Order

1. Discover installed CLIs and MCP servers with `tool-discovery`.
2. Ask the user which tools are authoritative for each domain.
3. Store credentials only in connector configuration, provider auth, `.env`, or
   org `secrets.env`.
4. Record configured tools in `TOOLS.md`.
5. Keep local CRM files as the relationship audit trail unless the user chooses a
   different source of truth.

## Domains

| Domain | Examples | Required? | Notes |
|---|---|---:|---|
| Email | Gmail, Outlook, IMAP, provider CLI, MCP | Optional | Needed for inbox triage and relationship interaction extraction. |
| Calendar | Google Calendar, Outlook Calendar, CalDAV, MCP | Optional | Needed for meeting prep and daily schedule reviews. |
| Meeting Notes | Granola, Fathom, Fireflies, Zoom transcripts, local files | Optional | Needed for automated meeting-note processing. |
| Contacts | Google Contacts, phone contacts export, external CRM, CSV | Optional | Can seed `crm/contacts.json`. |
| CRM | HubSpot, Pipedrive, Airtable, Notion, Salesforce, local files | Optional | Local files remain default if no CRM is connected. |
| Browser | agent-browser, Playwright profile, headed browser | Optional | Use for sites without API access. |

## Environment Placeholder File

Copy `.env.example` to `.env` only for non-secret labels and local settings.
Secrets should stay in the secure secret store used by the deployment.
