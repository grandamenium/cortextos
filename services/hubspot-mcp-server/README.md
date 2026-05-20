# HubSpot MCP Server

MCP (Model Context Protocol) server for HubSpot CRM. It runs locally over stdio and exposes a focused initial toolset for companies, contacts, deals, pipelines, engagements, and contact-to-deal associations.

## Tools

### Companies
- `hubspot_list_companies`
- `hubspot_get_company`
- `hubspot_update_company`

### Contacts
- `hubspot_list_contacts`
- `hubspot_get_contact`
- `hubspot_create_contact`
- `hubspot_update_contact`

### Deals
- `hubspot_list_deals`
- `hubspot_get_deal`
- `hubspot_create_deal`
- `hubspot_update_deal`
- `hubspot_search_deals`

### Pipelines
- `hubspot_list_pipelines`
- `hubspot_get_pipeline_stages`

### Engagements And Associations
- `hubspot_log_engagement` for note, email, call, or meeting records
- `hubspot_associate_contact_to_deal`

## Setup

### 1. Build

```bash
cd services/hubspot-mcp-server
npm install
npm run build
```

### 2. Environment

Set the private app token before starting the server:

```bash
export HUBSPOT_PRIVATE_APP_TOKEN='pat-...'
```

For cortextOS deployments, add this as an org-level shared secret:

```bash
HUBSPOT_PRIVATE_APP_TOKEN=pat-...
```

The scoped build found `HUBSPOT_HUMANPOINT_PAT` in `orgs/revops-global/secrets.env`, but did not find the canonical `HUBSPOT_PRIVATE_APP_TOKEN` name requested for this server. Add the canonical key or explicitly confirm an alias before using the MCP live.

### 3. Configure An MCP Client

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "node",
      "args": ["/absolute/path/to/cortextos/services/hubspot-mcp-server/dist/index.js"],
      "env": {
        "HUBSPOT_PRIVATE_APP_TOKEN": "pat-..."
      }
    }
  }
}
```

## Development

```bash
npm run dev
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## Architecture

```text
hubspot-mcp-server/
|-- src/
|   |-- index.ts              # stdio MCP entrypoint
|   |-- services/
|   |   `-- hubspot.ts        # HubSpot API client and formatters
|   `-- tools/
|       |-- associations.ts
|       |-- companies.ts
|       |-- contacts.ts
|       |-- deals.ts
|       |-- engagements.ts
|       `-- pipelines.ts
|-- package.json
`-- tsconfig.json
```

## API Notes

- CRM object CRUD uses HubSpot CRM v3 object endpoints.
- Deal pipelines use HubSpot CRM v3 pipeline endpoints.
- Default contact-to-deal association uses HubSpot CRM v4 association endpoints.
- Engagement logging creates HubSpot CRM objects for notes, emails, calls, and meetings.

## Security

- Keep `HUBSPOT_PRIVATE_APP_TOKEN` secret and out of git.
- The server runs over stdio and does not expose an HTTP listener.
- Mutating tools update live HubSpot CRM records; use private app scopes that match the intended deployment surface.
