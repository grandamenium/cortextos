import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hubspotRequest, toolError } from "../services/hubspot.js";

type PipelineStage = {
  id: string;
  label: string;
  displayOrder?: number;
  metadata?: Record<string, string>;
};

type Pipeline = {
  id: string;
  label: string;
  displayOrder?: number;
  stages?: PipelineStage[];
};

type PipelinesResponse = {
  results: Pipeline[];
};

function formatPipelines(pipelines: Pipeline[], includeStages = false): string {
  if (pipelines.length === 0) return "No pipelines found.";
  const lines = [`# HubSpot Deal Pipelines (${pipelines.length})`, ""];
  for (const pipeline of pipelines) {
    lines.push(`- **${pipeline.label}** _(${pipeline.id})_`);
    if (includeStages && pipeline.stages?.length) {
      for (const stage of pipeline.stages) {
        lines.push(`  - ${stage.label} _(${stage.id})_`);
      }
    }
  }
  return lines.join("\n");
}

export function registerPipelineTools(server: McpServer) {
  server.registerTool(
    "hubspot_list_pipelines",
    {
      title: "List HubSpot Deal Pipelines",
      description: "List HubSpot deal pipelines.",
      inputSchema: {
        include_stages: z.boolean().default(false).describe("Include each pipeline's stages in the response"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const result = await hubspotRequest<PipelinesResponse>("/crm/v3/pipelines/deals");
        return { content: [{ type: "text" as const, text: formatPipelines(result.results, params.include_stages) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "hubspot_get_pipeline_stages",
    {
      title: "Get HubSpot Pipeline Stages",
      description: "Get stages for a HubSpot deal pipeline.",
      inputSchema: {
        pipeline_id: z.string().min(1).describe("HubSpot deal pipeline ID, for example 'default'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const pipeline = await hubspotRequest<Pipeline>(`/crm/v3/pipelines/deals/${encodeURIComponent(params.pipeline_id)}`);
        const stages = pipeline.stages ?? [];
        if (stages.length === 0) {
          return { content: [{ type: "text" as const, text: `No stages found for pipeline ${params.pipeline_id}.` }] };
        }
        const lines = [`# ${pipeline.label} stages`, ""];
        for (const stage of stages) {
          const probability = stage.metadata?.probability ? ` - probability ${stage.metadata.probability}` : "";
          lines.push(`- **${stage.label}** _(${stage.id})_${probability}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
