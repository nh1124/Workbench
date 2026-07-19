import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  flagMaintenanceTarget,
  MAINTENANCE_FLAG_REASONS,
  MAINTENANCE_FLAG_TARGET_TYPES
} from "../maintenanceActions.js";
import {
  aggregateMaintenanceQueue,
  MAINTENANCE_QUEUE_KINDS,
  MAINTENANCE_QUEUE_REASONS
} from "../maintenanceQueue.js";
import {
  commitSyncChangesCursor,
  initializeSyncChangesConsumer,
  pullSyncChanges,
  SYNC_CHANGES_DOMAINS
} from "../syncChanges.js";
import { summarizeUsage } from "../usageEventsStore.js";
import { asMcpText, runWithAuth, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

const queueKindSchema = z.enum(MAINTENANCE_QUEUE_KINDS);
const queueReasonSchema = z.enum(MAINTENANCE_QUEUE_REASONS);
const flagTargetTypeSchema = z.enum(MAINTENANCE_FLAG_TARGET_TYPES);
const flagReasonSchema = z.enum(MAINTENANCE_FLAG_REASONS);
const syncChangesDomainSchema = z.enum(SYNC_CHANGES_DOMAINS);
const syncChangesConsumerSchema = z.string().trim().min(1).max(100);

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

  server.registerTool(
    "maintenance.flag",
    {
      title: "Flag Maintenance Target",
      description: "Set only the review_reason on a memory or note for later maintenance review; this cannot promote, confirm, snooze, or clear an item.",
      inputSchema: {
        target: z.object({
          type: flagTargetTypeSchema,
          id: z.string().min(1)
        }),
        reason: flagReasonSchema,
        note: z.string().optional()
      }
    },
    async (input) =>
      asMcpText(
        await runWithAuthContext(ctx.accessToken, ({ userId }) =>
          flagMaintenanceTarget({
            accessToken: ctx.accessToken,
            userId,
            source: "core-mcp"
          }, input)
        )
      )
  );

  server.registerTool(
    "maintenance.usage.summary",
    {
      title: "Summarize Maintenance Usage",
      description: "Read usage signals for maintenance planning: context truncations, zero-hit searches, and frequently read resources.",
      inputSchema: {
        since: z.string().datetime().optional(),
        until: z.string().datetime().optional()
      }
    },
    async (input) =>
      asMcpText(
        await runWithAuthContext(ctx.accessToken, ({ userId }) =>
          summarizeUsage(userId, input.since, input.until)
        )
      )
  );

  server.registerTool(
    "sync.changes.consumer.initialize",
    {
      title: "Initialize Sync Changes Consumer",
      description: "Create a NEW consumer starting at the CURRENT head of the owner's change stream, with no historical events. This operation is idempotent, never resets an existing consumer, and can optionally bind a permanent scope; re-initializing with a conflicting scope returns an error.",
      inputSchema: {
        consumer: syncChangesConsumerSchema,
        startAt: z.literal("current").optional(),
        scope: z.object({
          projectId: z.string().min(1).optional(),
          pathPrefix: z.string().min(1).optional(),
          domains: z.array(syncChangesDomainSchema).optional(),
          resourceTypes: z.array(z.string().min(1)).optional(),
          actions: z.array(z.enum(["create", "update", "delete", "upsert"])).optional()
        }).optional()
      }
    },
    async (input) =>
      asMcpText(
        await runWithAuthContext(ctx.accessToken, ({ userId }) =>
          initializeSyncChangesConsumer(userId, input)
        )
      )
  );

  server.registerTool(
    "sync.changes.pull",
    {
      title: "Pull Sync Changes",
      description: "Read owner-scoped sync changes for a consumer with optional server-side filters. The cursor advances through the global stream even when a page has no matching events, so commit nextCursor with sync.changes.commit after processing. A consumer initialized with a bound scope rejects conflicting filters. Set includeContent:false to strip note bodies and return contentLength instead; set includePatch:false to strip patch payloads. This is an at-least-once contract.",
      inputSchema: {
        consumer: syncChangesConsumerSchema.optional(),
        cursor: z.string().trim().min(1).optional(),
        domains: z.array(syncChangesDomainSchema).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        projectId: z.string().min(1).optional(),
        pathPrefix: z.string().min(1).optional(),
        resourceTypes: z.array(z.string().min(1)).optional(),
        actions: z.array(z.enum(["create", "update", "delete", "upsert"])).optional(),
        includeContent: z.boolean().optional(),
        includePatch: z.boolean().optional()
      }
    },
    async (input) =>
      asMcpText(
        await runWithAuthContext(ctx.accessToken, ({ userId }) =>
          pullSyncChanges(userId, input)
        )
      )
  );

  server.registerTool(
    "sync.changes.commit",
    {
      title: "Commit Sync Changes Cursor",
      description: "Persist only the consumer cursor after completed sync change processing.",
      inputSchema: {
        consumer: syncChangesConsumerSchema.optional(),
        cursor: z.string().trim().min(1)
      }
    },
    async (input) =>
      asMcpText(
        await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
          const committed = await commitSyncChangesCursor(userId, input);
          return {
            consumer: committed.consumerId,
            cursor: committed.cursor,
            updatedAt: committed.updatedAt
          };
        })
      )
  );
}
