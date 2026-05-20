import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hubspotRequest, toolError } from "../services/hubspot.js";

export function registerAssociationTools(server: McpServer) {
  server.registerTool(
    "hubspot_associate_contact_to_deal",
    {
      title: "Associate HubSpot Contact To Deal",
      description: "Associate a HubSpot contact record to a HubSpot deal record using the default contact-to-deal association type.",
      inputSchema: {
        contact_id: z.string().min(1).describe("HubSpot contact record ID"),
        deal_id: z.string().min(1).describe("HubSpot deal record ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        await hubspotRequest(
          `/crm/v4/objects/contacts/${encodeURIComponent(params.contact_id)}/associations/default/deals/${encodeURIComponent(params.deal_id)}`,
          { method: "PUT" },
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Associated HubSpot contact \`${params.contact_id}\` to deal \`${params.deal_id}\`.`,
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
