import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { wbsClient } from "../internalClients.js";
import {
  cleanupDeletedWbsBestEffort,
  listArtifactProjectIdsBestEffort,
  maintainWbsIndexBestEffort,
  rebuildProjectWbsIndex,
  reconcileWbsMutationBestEffort,
  saveWbsExportArtifact,
  WBS_TARGET_RESOURCE_TYPE,
  wbsProjectIdsBestEffort
} from "../projectContext.js";
import {
  wbsArtifactSaveFields,
  wbsDependencyCreateFields,
  wbsExportFormatSchema,
  wbsItemCreateFields,
  wbsItemMoveFields,
  wbsItemUpdateFields,
  wbsPlanCreateFields,
  wbsPlanUpdateFields
} from "../schemas/wbs.js";
import { recordProjectContextInvalidationsBestEffort } from "../projectContextSync.js";
import { ensureWbsAccountProvisioned } from "../serviceProvisioning.js";
import { markIndexEntryReadBestEffort } from "../indexReadTracking.js";
import { asMcpText, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

type AuthRunContext = {
  userId: string;
  username: string;
};


function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function objectId(value: unknown): string | undefined {
  const id = asRecord(value).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function planIdFromItem(value: unknown): string | undefined {
  const planId = asRecord(value).planId;
  return typeof planId === "string" && planId.trim() ? planId.trim() : undefined;
}

async function invalidateWbsIndexFromMcp(
  userId: string,
  projectIds: Array<string | undefined>,
  planId: string,
  action: "update" | "delete" = "update"
): Promise<void> {
  await recordProjectContextInvalidationsBestEffort(userId, projectIds, {
    changed: ["index"],
    entityType: "index",
    entityId: planId,
    source: "core-mcp",
    action
  });
}

async function invalidateArtifactIndexFromMcp(
  userId: string,
  projectIds: Array<string | undefined>,
  artifactItemId: string
): Promise<void> {
  await recordProjectContextInvalidationsBestEffort(userId, projectIds, {
    changed: ["index"],
    entityType: "index",
    entityId: artifactItemId,
    source: "core-mcp"
  });
}

async function runWithWbsAccount<T>(
  ctx: ToolContext,
  operation: (authContext: AuthRunContext) => Promise<T>
): Promise<T> {
  return runWithAuthContext(ctx.accessToken, async (authContext) => {
    await ensureWbsAccountProvisioned(authContext);
    return operation(authContext);
  });
}

async function maintainPlanFromItemMutation(ctx: ToolContext, userId: string, itemResult: unknown): Promise<void> {
  const planId = planIdFromItem(itemResult);
  if (!planId) return;
  const plan = await wbsClient.getPlan(ctx.accessToken, planId);
  await maintainWbsIndexBestEffort(ctx.accessToken, plan);
  await invalidateWbsIndexFromMcp(userId, wbsProjectIdsBestEffort(plan), planId);
}

export function registerWbsTools(server: McpServer, ctx: ToolContext): void;
export function registerWbsTools(server: McpServer): void;
export function registerWbsTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }

  server.registerTool(
    "wbs.list",
    {
      title: "List WBS Plans",
      description: "List WBS plans for the authenticated user.",
      inputSchema: {
        projectId: z.string().optional(),
        q: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional()
      }
    },
    async (options) => {
      const result = await runWithWbsAccount(ctx, () => wbsClient.listPlans(ctx.accessToken, options));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.get",
    {
      title: "Get WBS Plan",
      description: "Get a WBS plan by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithWbsAccount(ctx, async () => {
        const plan = await wbsClient.getPlan(ctx.accessToken, id);
        markIndexEntryReadBestEffort({
          accessToken: ctx.accessToken,
          sourceService: "wbs",
          resourceId: id
        });
        return plan;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.create",
    {
      title: "Create WBS Plan",
      description: "Create a WBS plan and add it to the Project index when projectId is supplied.",
      inputSchema: {
        ...wbsPlanCreateFields
      }
    },
    async (payload) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const created = await wbsClient.createPlan(ctx.accessToken, payload);
        await maintainWbsIndexBestEffort(ctx.accessToken, created);
        await invalidateWbsIndexFromMcp(userId, wbsProjectIdsBestEffort(created), objectId(created) ?? "unknown");
        return created;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.update",
    {
      title: "Update WBS Plan",
      description: "Update WBS plan metadata and refresh its Project index entry.",
      inputSchema: {
        id: z.string().min(1),
        ...wbsPlanUpdateFields
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const before = await wbsClient.getPlan(ctx.accessToken, id);
        const projectIds = wbsProjectIdsBestEffort(before);
        const updated = await wbsClient.updatePlan(ctx.accessToken, id, payload);
        await reconcileWbsMutationBestEffort(ctx.accessToken, before, updated);
        projectIds.push(...wbsProjectIdsBestEffort(updated));
        await invalidateWbsIndexFromMcp(userId, projectIds, id);
        return updated;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.delete",
    {
      title: "Delete WBS Plan",
      description: "Delete a WBS plan and tombstone its Project index entry.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const before = await wbsClient.getPlan(ctx.accessToken, id);
        const projectIds = wbsProjectIdsBestEffort(before);
        await wbsClient.removePlan(ctx.accessToken, id);
        await cleanupDeletedWbsBestEffort(ctx.accessToken, before);
        await invalidateWbsIndexFromMcp(userId, projectIds, id, "delete");
        return { status: "ok" };
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.items.list",
    {
      title: "List WBS Items",
      description: "List the hierarchical rows for a WBS plan.",
      inputSchema: {
        planId: z.string().min(1)
      }
    },
    async ({ planId }) => {
      const result = await runWithWbsAccount(ctx, () => wbsClient.listItems(ctx.accessToken, planId));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.items.create",
    {
      title: "Create WBS Item",
      description: "Create a WBS row under an optional parent item.",
      inputSchema: {
        planId: z.string().min(1),
        ...wbsItemCreateFields
      }
    },
    async ({ planId, ...payload }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const created = await wbsClient.createItem(ctx.accessToken, planId, payload);
        await maintainPlanFromItemMutation(ctx, userId, created);
        return created;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.items.update",
    {
      title: "Update WBS Item",
      description: "Update a WBS row with optimistic concurrency.",
      inputSchema: {
        id: z.string().min(1),
        ...wbsItemUpdateFields
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const updated = await wbsClient.updateItem(ctx.accessToken, id, payload);
        await maintainPlanFromItemMutation(ctx, userId, updated);
        return updated;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.items.delete",
    {
      title: "Delete WBS Item",
      description: "Delete a WBS row and its descendants.",
      inputSchema: {
        id: z.string().min(1),
        expectedVersion: z.number().int().positive().optional()
      }
    },
    async ({ id, expectedVersion }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const before = await wbsClient.getItem(ctx.accessToken, id);
        await wbsClient.removeItem(ctx.accessToken, id, expectedVersion);
        const planId = planIdFromItem(before);
        if (planId) {
          const plan = await wbsClient.getPlan(ctx.accessToken, planId);
          await maintainWbsIndexBestEffort(ctx.accessToken, plan);
          await invalidateWbsIndexFromMcp(userId, wbsProjectIdsBestEffort(plan), planId);
        }
        return { status: "ok", id, expectedVersion };
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.items.move",
    {
      title: "Move WBS Item",
      description: "Move or reorder a WBS row.",
      inputSchema: {
        id: z.string().min(1),
        ...wbsItemMoveFields
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const moved = await wbsClient.moveItem(ctx.accessToken, id, payload);
        await maintainPlanFromItemMutation(ctx, userId, moved);
        return moved;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.dependencies.list",
    {
      title: "List WBS Dependencies",
      description: "List dependency links for a WBS plan.",
      inputSchema: {
        planId: z.string().min(1)
      }
    },
    async ({ planId }) => {
      const result = await runWithWbsAccount(ctx, () => wbsClient.listDependencies(ctx.accessToken, planId));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.dependencies.create",
    {
      title: "Create WBS Dependency",
      description: "Create a dependency link between two WBS rows.",
      inputSchema: {
        planId: z.string().min(1),
        ...wbsDependencyCreateFields
      }
    },
    async ({ planId, ...payload }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const dependency = await wbsClient.createDependency(ctx.accessToken, planId, payload);
        const plan = await wbsClient.getPlan(ctx.accessToken, planId);
        await maintainWbsIndexBestEffort(ctx.accessToken, plan);
        await invalidateWbsIndexFromMcp(userId, wbsProjectIdsBestEffort(plan), planId);
        return dependency;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.dependencies.delete",
    {
      title: "Delete WBS Dependency",
      description: "Delete a WBS dependency link.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithWbsAccount(ctx, async () => {
        await wbsClient.removeDependency(ctx.accessToken, id);
        return { status: "ok", id };
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.export",
    {
      title: "Export WBS",
      description: "Render a WBS plan as JSON, Markdown, or CSV content.",
      inputSchema: {
        id: z.string().min(1),
        format: wbsExportFormatSchema.default("markdown")
      }
    },
    async ({ id, format }) => {
      const result = await runWithWbsAccount(ctx, () => wbsClient.exportContent(ctx.accessToken, id, { format }));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.artifact.save",
    {
      title: "Save WBS Artifact",
      description: "Save a WBS export snapshot to Artifacts without changing the WBS source plan.",
      inputSchema: {
        id: z.string().min(1),
        ...wbsArtifactSaveFields
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const saved = await saveWbsExportArtifact(ctx.accessToken, id, payload);
        const artifactItemId = objectId(saved.artifact);
        if (artifactItemId) {
          const projectIds = await listArtifactProjectIdsBestEffort(ctx.accessToken, saved.artifact);
          await invalidateArtifactIndexFromMcp(userId, projectIds, artifactItemId);
        }
        return { status: "ok", ...saved };
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "wbs.projectIndex.rebuild",
    {
      title: "Rebuild WBS Project Index",
      description: "Repair a Project's WBS index entries by scanning WBS plans for that Project and tombstoning drift.",
      inputSchema: {
        projectId: z.string().min(1)
      }
    },
    async ({ projectId }) => {
      const result = await runWithWbsAccount(ctx, async ({ userId }) => {
        const rebuilt = await rebuildProjectWbsIndex(ctx.accessToken, projectId);
        await invalidateWbsIndexFromMcp(userId, [projectId], projectId);
        return rebuilt;
      });
      return asMcpText(result);
    }
  );
}
