import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatList, formatObject, getObject, listObjects, toolError, updateObject } from "../services/hubspot.js";

const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  "city",
  "state",
  "country",
  "phone",
  "lifecyclestage",
  "hs_lead_status",
];

export function registerCompanyTools(server: McpServer) {
  server.registerTool(
    "hubspot_list_companies",
    {
      title: "List HubSpot Companies",
      description: "List HubSpot CRM companies with core identity and lifecycle properties.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum companies to return"),
        after: z.string().optional().describe("Paging cursor returned by HubSpot"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await listObjects("companies", COMPANY_PROPERTIES, params.limit, params.after);
        const text = formatList("HubSpot Companies", result.results, ["name", "domain", "industry", "lifecyclestage"]);
        const paging = result.paging?.next?.after ? `\n\nNext page after: \`${result.paging.next.after}\`` : "";
        return { content: [{ type: "text" as const, text: text + paging }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_get_company",
    {
      title: "Get HubSpot Company",
      description: "Get a HubSpot company by record ID.",
      inputSchema: {
        company_id: z.string().min(1).describe("HubSpot company record ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const company = await getObject("companies", params.company_id, COMPANY_PROPERTIES, ["contacts", "deals"]);
        return { content: [{ type: "text" as const, text: formatObject("HubSpot Company", company, COMPANY_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_update_company",
    {
      title: "Update HubSpot Company",
      description: "Update editable HubSpot company properties by record ID.",
      inputSchema: {
        company_id: z.string().min(1).describe("HubSpot company record ID"),
        name: z.string().optional(),
        domain: z.string().optional(),
        industry: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        country: z.string().optional(),
        phone: z.string().optional(),
        lifecyclestage: z.string().optional(),
        hs_lead_status: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ company_id, ...properties }) => {
      try {
        const company = await updateObject("companies", company_id, properties);
        return { content: [{ type: "text" as const, text: formatObject("Updated HubSpot Company", company, COMPANY_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
