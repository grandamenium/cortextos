import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createObject, formatList, formatObject, getObject, listObjects, toolError, updateObject } from "../services/hubspot.js";

const CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "jobtitle",
  "company",
  "lifecyclestage",
  "hs_lead_status",
];

export function registerContactTools(server: McpServer) {
  server.registerTool(
    "hubspot_list_contacts",
    {
      title: "List HubSpot Contacts",
      description: "List HubSpot CRM contacts with core identity, company, and lifecycle properties.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(25),
        after: z.string().optional().describe("Paging cursor returned by HubSpot"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await listObjects("contacts", CONTACT_PROPERTIES, params.limit, params.after);
        const text = formatList("HubSpot Contacts", result.results, ["email", "firstname", "lastname", "company"]);
        const paging = result.paging?.next?.after ? `\n\nNext page after: \`${result.paging.next.after}\`` : "";
        return { content: [{ type: "text" as const, text: text + paging }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_get_contact",
    {
      title: "Get HubSpot Contact",
      description: "Get a HubSpot contact by record ID.",
      inputSchema: {
        contact_id: z.string().min(1).describe("HubSpot contact record ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const contact = await getObject("contacts", params.contact_id, CONTACT_PROPERTIES, ["companies", "deals"]);
        return { content: [{ type: "text" as const, text: formatObject("HubSpot Contact", contact, CONTACT_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_create_contact",
    {
      title: "Create HubSpot Contact",
      description: "Create a HubSpot contact record.",
      inputSchema: {
        email: z.string().email().describe("Contact email"),
        firstname: z.string().optional(),
        lastname: z.string().optional(),
        phone: z.string().optional(),
        mobilephone: z.string().optional(),
        jobtitle: z.string().optional(),
        company: z.string().optional(),
        lifecyclestage: z.string().optional(),
        hs_lead_status: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (properties) => {
      try {
        const contact = await createObject("contacts", properties);
        return { content: [{ type: "text" as const, text: formatObject("Created HubSpot Contact", contact, CONTACT_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_update_contact",
    {
      title: "Update HubSpot Contact",
      description: "Update editable HubSpot contact properties by record ID.",
      inputSchema: {
        contact_id: z.string().min(1).describe("HubSpot contact record ID"),
        email: z.string().email().optional(),
        firstname: z.string().optional(),
        lastname: z.string().optional(),
        phone: z.string().optional(),
        mobilephone: z.string().optional(),
        jobtitle: z.string().optional(),
        company: z.string().optional(),
        lifecyclestage: z.string().optional(),
        hs_lead_status: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ contact_id, ...properties }) => {
      try {
        const contact = await updateObject("contacts", contact_id, properties);
        return { content: [{ type: "text" as const, text: formatObject("Updated HubSpot Contact", contact, CONTACT_PROPERTIES) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
