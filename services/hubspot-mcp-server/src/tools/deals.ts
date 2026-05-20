import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createObject, formatList, formatObject, getObject, listObjects, searchObjects, toolError, updateObject } from "../services/hubspot.js";

const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "pipeline",
  "closedate",
  "dealtype",
  "hubspot_owner_id",
  "description",
];

export function registerDealTools(server: McpServer) {
  server.registerTool(
    "hubspot_list_deals",
    {
      title: "List HubSpot Deals",
      description: "List HubSpot CRM deals with amount, stage, pipeline, close date, and owner properties.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(25),
        after: z.string().optional().describe("Paging cursor returned by HubSpot"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await listObjects("deals", DEAL_PROPERTIES, params.limit, params.after);
        const text = formatList("HubSpot Deals", result.results, ["dealname", "amount", "dealstage", "closedate"]);
        const paging = result.paging?.next?.after ? `\n\nNext page after: \`${result.paging.next.after}\`` : "";
        return { content: [{ type: "text" as const, text: text + paging }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_get_deal",
    {
      title: "Get HubSpot Deal",
      description: "Get a HubSpot deal by record ID.",
      inputSchema: {
        deal_id: z.string().min(1).describe("HubSpot deal record ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const deal = await getObject("deals", params.deal_id, DEAL_PROPERTIES, ["contacts", "companies"]);
        return { content: [{ type: "text" as const, text: formatObject("HubSpot Deal", deal, DEAL_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_create_deal",
    {
      title: "Create HubSpot Deal",
      description: "Create a HubSpot deal record.",
      inputSchema: {
        dealname: z.string().min(1).describe("Deal name"),
        amount: z.number().optional().describe("Deal amount"),
        dealstage: z.string().min(1).describe("HubSpot deal stage ID"),
        pipeline: z.string().default("default").describe("HubSpot pipeline ID"),
        closedate: z.string().optional().describe("Close date, preferably ISO timestamp or YYYY-MM-DD"),
        dealtype: z.string().optional(),
        hubspot_owner_id: z.string().optional(),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (properties) => {
      try {
        const deal = await createObject("deals", properties);
        return { content: [{ type: "text" as const, text: formatObject("Created HubSpot Deal", deal, DEAL_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_update_deal",
    {
      title: "Update HubSpot Deal",
      description: "Update editable HubSpot deal properties by record ID.",
      inputSchema: {
        deal_id: z.string().min(1).describe("HubSpot deal record ID"),
        dealname: z.string().optional(),
        amount: z.number().optional(),
        dealstage: z.string().optional(),
        pipeline: z.string().optional(),
        closedate: z.string().optional(),
        dealtype: z.string().optional(),
        hubspot_owner_id: z.string().optional(),
        description: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ deal_id, ...properties }) => {
      try {
        const deal = await updateObject("deals", deal_id, properties);
        return { content: [{ type: "text" as const, text: formatObject("Updated HubSpot Deal", deal, DEAL_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_search_deals",
    {
      title: "Search HubSpot Deals",
      description: "Search HubSpot deals by free-text query and optional property filters.",
      inputSchema: {
        query: z.string().optional().describe("Free text query over searchable deal fields"),
        pipeline: z.string().optional().describe("Filter by pipeline ID"),
        dealstage: z.string().optional().describe("Filter by deal stage ID"),
        min_amount: z.number().optional().describe("Filter deals whose amount is >= this value"),
        limit: z.number().int().min(1).max(100).default(25),
        after: z.string().optional().describe("Paging cursor returned by HubSpot"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const filters = [];
        if (params.pipeline) filters.push({ propertyName: "pipeline", operator: "EQ", value: params.pipeline });
        if (params.dealstage) filters.push({ propertyName: "dealstage", operator: "EQ", value: params.dealstage });
        if (params.min_amount !== undefined) filters.push({ propertyName: "amount", operator: "GTE", value: String(params.min_amount) });
        const result = await searchObjects("deals", {
          query: params.query,
          filterGroups: filters.length ? [{ filters }] : undefined,
          properties: DEAL_PROPERTIES,
          limit: params.limit,
          after: params.after,
        });
        const text = formatList("HubSpot Deal Search Results", result.results, ["dealname", "amount", "dealstage", "closedate"]);
        const paging = result.paging?.next?.after ? `\n\nNext page after: \`${result.paging.next.after}\`` : "";
        return { content: [{ type: "text" as const, text: text + paging }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
