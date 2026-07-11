import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insightsClient, serviceBaseUrls } from "../internalClients.js";
import { ensureInsightsAccountProvisioned } from "../serviceProvisioning.js";
import { asMcpText, runWithAuthContext } from "./helpers.js";

type ToolContext = { accessToken: string };

const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date");

function requireInsightsConfigured(): void {
  if (!serviceBaseUrls.insights) throw new Error("Insights service is not configured");
}

async function runWithInsightsAccount<T>(ctx: ToolContext, operation: () => Promise<T>): Promise<T> {
  requireInsightsConfigured();
  return runWithAuthContext(ctx.accessToken, async (authContext) => {
    await ensureInsightsAccountProvisioned(authContext);
    return operation();
  });
}

export function registerInsightsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "insights.machines.list",
    {
      title: "List Insights Machines",
      description: "List capture machines registered for the authenticated user.",
      inputSchema: {}
    },
    async () => asMcpText(await runWithInsightsAccount(ctx, () => insightsClient.listMachines(ctx.accessToken)))
  );

  server.registerTool(
    "insights.activity.query",
    {
      title: "Query Insights Activity",
      description: "Get aggregated work logs across machines; this is the entry point for analysis routines.",
      inputSchema: {
        from: dateSchema,
        to: dateSchema,
        machineId: z.string().uuid().optional()
      }
    },
    async (query) => asMcpText(await runWithInsightsAccount(ctx, () => insightsClient.queryActivity(ctx.accessToken, query)))
  );

  server.registerTool(
    "insights.summaries.list",
    {
      title: "List Insights Summaries",
      description: "List daily capture summary metadata and metrics without loading Markdown bodies.",
      inputSchema: {
        machineId: z.string().uuid().optional(),
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().min(1).optional()
      }
    },
    async (query) => asMcpText(await runWithInsightsAccount(ctx, () => insightsClient.listSummaries(ctx.accessToken, query)))
  );

  server.registerTool(
    "insights.summaries.get",
    {
      title: "Get Insights Summary",
      description: "Get one daily capture summary including its Markdown body and metrics.",
      inputSchema: {
        machineId: z.string().uuid(),
        date: dateSchema
      }
    },
    async ({ machineId, date }) => asMcpText(await runWithInsightsAccount(
      ctx,
      () => insightsClient.getSummary(ctx.accessToken, machineId, date)
    ))
  );

  server.registerTool(
    "insights.derived.ingest",
    {
      title: "Ingest Derived Insight",
      description: "Explicitly store observation data derived locally by an agent from capture activity.",
      inputSchema: {
        machineId: z.string().uuid().optional(),
        observedDate: dateSchema,
        kind: z.string().min(1).max(100),
        title: z.string().min(1).max(500),
        contentMarkdown: z.string(),
        payloadJson: z.record(z.unknown()).optional()
      }
    },
    async (payload) => asMcpText(await runWithInsightsAccount(ctx, () => insightsClient.createDerived(ctx.accessToken, payload)))
  );

  server.registerTool(
    "insights.derived.list",
    {
      title: "List Derived Insights",
      description: "List stored agent-derived observations for review and follow-up analysis.",
      inputSchema: {
        from: dateSchema.optional(),
        to: dateSchema.optional(),
        kind: z.string().min(1).optional(),
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().min(1).optional()
      }
    },
    async (query) => asMcpText(await runWithInsightsAccount(ctx, () => insightsClient.listDerived(ctx.accessToken, query)))
  );
}
