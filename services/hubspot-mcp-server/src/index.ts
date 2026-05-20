#!/usr/bin/env node
/**
 * HubSpot MCP Server - stdio MCP integration for HubSpot CRM.
 *
 * Transport: stdio
 * Auth: HUBSPOT_PRIVATE_APP_TOKEN
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAssociationTools } from "./tools/associations.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDealTools } from "./tools/deals.js";
import { registerEngagementTools } from "./tools/engagements.js";
import { registerPipelineTools } from "./tools/pipelines.js";

const server = new McpServer({
  name: "hubspot-mcp-server",
  version: "1.0.0",
});

registerCompanyTools(server);
registerContactTools(server);
registerDealTools(server);
registerPipelineTools(server);
registerEngagementTools(server);
registerAssociationTools(server);

async function main() {
  if (!process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
    console.error("ERROR: Missing required environment variable: HUBSPOT_PRIVATE_APP_TOKEN");
    console.error("Create a HubSpot private app token and set HUBSPOT_PRIVATE_APP_TOKEN before starting this MCP server.");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HubSpot MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
