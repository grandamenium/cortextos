import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HubSpotObject, createObject, toolError } from "../services/hubspot.js";

const engagementTypeSchema = z.enum(["note", "email", "call", "meeting"]);

type EngagementType = z.infer<typeof engagementTypeSchema>;

function engagementObjectType(type: EngagementType): string {
  switch (type) {
    case "note":
      return "notes";
    case "email":
      return "emails";
    case "call":
      return "calls";
    case "meeting":
      return "meetings";
  }
}

function engagementProperties(params: {
  type: EngagementType;
  body: string;
  title?: string;
  timestamp?: string;
  status?: string;
  direction?: string;
  duration_ms?: number;
}): Record<string, unknown> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  if (params.type === "note") {
    return {
      hs_note_body: params.body,
      hs_timestamp: timestamp,
    };
  }
  if (params.type === "email") {
    return {
      hs_email_subject: params.title,
      hs_email_text: params.body,
      hs_timestamp: timestamp,
      hs_email_status: params.status,
      hs_email_direction: params.direction,
    };
  }
  if (params.type === "call") {
    return {
      hs_call_title: params.title,
      hs_call_body: params.body,
      hs_timestamp: timestamp,
      hs_call_status: params.status,
      hs_call_direction: params.direction,
      hs_call_duration: params.duration_ms,
    };
  }
  return {
    hs_meeting_title: params.title,
    hs_meeting_body: params.body,
    hs_timestamp: timestamp,
  };
}

function formatEngagement(type: EngagementType, object: HubSpotObject): string {
  return `Logged HubSpot ${type} engagement _(${object.id})_.`;
}

export function registerEngagementTools(server: McpServer) {
  server.registerTool(
    "hubspot_log_engagement",
    {
      title: "Log HubSpot Engagement",
      description:
        "Log a HubSpot CRM engagement object. Supports note, email, call, and meeting records. " +
        "Use hubspot_associate_contact_to_deal separately for contact-deal associations.",
      inputSchema: {
        type: engagementTypeSchema.describe("Engagement type to create"),
        body: z.string().min(1).describe("Engagement body or notes"),
        title: z.string().optional().describe("Subject/title for email, call, or meeting"),
        timestamp: z.string().optional().describe("ISO timestamp; defaults to now"),
        status: z.string().optional().describe("HubSpot status value for email/call if applicable"),
        direction: z.string().optional().describe("HubSpot direction value for email/call if applicable"),
        duration_ms: z.number().int().min(0).optional().describe("Call duration in milliseconds"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const objectType = engagementObjectType(params.type);
        const engagement = await createObject(objectType, engagementProperties(params));
        return { content: [{ type: "text" as const, text: formatEngagement(params.type, engagement) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
