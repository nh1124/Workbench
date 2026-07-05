import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  aggregateMaintenanceQueue,
  MAINTENANCE_QUEUE_KINDS,
  MAINTENANCE_QUEUE_REASONS
} from "../maintenanceQueue.js";
import { asMcpText, runWithAuth } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

const queueKindSchema = z.enum(MAINTENANCE_QUEUE_KINDS);
const queueReasonSchema = z.enum(MAINTENANCE_QUEUE_REASONS);

export function registerMaintenanceTools(server: McpServer, ctx: ToolContext): void;
export function registerMaintenanceTools(server: McpServer): void;
export function registerMaintenanceTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }

  server.registerTool(
    "maintenance.queue.list",
    {
      title: "List Maintenance Queue",
      description: "Read the owner-scoped maintenance queue across Projects and Notes.",
      inputSchema: {
        kind: queueKindSchema.optional(),
        reason: queueReasonSchema.optional(),
        projectId: z.string().min(1).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async (options) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () => aggregateMaintenanceQueue(ctx.accessToken, options))
      )
  );
}
