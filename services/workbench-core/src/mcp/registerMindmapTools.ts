import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mindmapsClient } from "../internalClients.js";
import {
  cleanupDeletedMindmapBestEffort,
  listArtifactProjectIdsBestEffort,
  maintainMindmapIndexBestEffort,
  MINDMAP_TARGET_RESOURCE_TYPE,
  mindmapProjectIdsBestEffort,
  reconcileMindmapMutationBestEffort,
  rebuildProjectMindmapIndex,
  saveMindmapExportArtifact
} from "../projectContext.js";
import { recordProjectContextInvalidationsBestEffort } from "../projectContextSync.js";
import { ensureMindmapsAccountProvisioned } from "../serviceProvisioning.js";
import { recordResourceReadUsageBestEffort } from "../usageInstrumentation.js";
import { asMcpText, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

type AuthRunContext = {
  userId: string;
  username: string;
};

const mindmapModeSchema = z.enum(["mindmap", "logical_tree"]);
const mindmapExportFormatSchema = z.enum(["json", "markdown", "svg"]);

async function invalidateMindmapIndexFromMcp(
  userId: string,
  projectIds: Array<string | undefined>,
  documentId: string,
  action: "update" | "delete" = "update"
): Promise<void> {
  await recordProjectContextInvalidationsBestEffort(userId, projectIds, {
    changed: ["index"],
    entityType: "index",
    entityId: documentId,
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

function objectId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function runWithMindmapsAccount<T>(
  ctx: ToolContext,
  operation: (authContext: AuthRunContext) => Promise<T>
): Promise<T> {
  return runWithAuthContext(ctx.accessToken, async (authContext) => {
    await ensureMindmapsAccountProvisioned(authContext);
    return operation(authContext);
  });
}

export function registerMindmapTools(server: McpServer, ctx: ToolContext): void;
export function registerMindmapTools(server: McpServer): void;
export function registerMindmapTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }

  server.registerTool(
    "mindmaps.list",
    {
      title: "List Mindmaps",
      description: "List Mindmap and Logical Tree documents for the authenticated user.",
      inputSchema: {
        projectId: z.string().optional(),
        q: z.string().optional(),
        mode: mindmapModeSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional()
      }
    },
    async (options) => {
      const result = await runWithMindmapsAccount(ctx, () => mindmapsClient.list(ctx.accessToken, options));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "mindmaps.get",
    {
      title: "Get Mindmap",
      description: "Get a Mindmap or Logical Tree document body by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithMindmapsAccount(ctx, async ({ userId }) => {
        const document = await mindmapsClient.get(ctx.accessToken, id);
        recordResourceReadUsageBestEffort({
          accessToken: ctx.accessToken,
          userId,
          sourceService: "mindmaps",
          resourceType: MINDMAP_TARGET_RESOURCE_TYPE,
          resourceId: id
        });
        return document;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "mindmaps.create",
    {
      title: "Create Mindmap",
      description: "Create a Mindmap or Logical Tree document and add it to the Project index when projectId is supplied.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        mode: mindmapModeSchema.optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        body: z.unknown().optional(),
        tags: z.array(z.string()).optional(),
        template: z.enum(["blank", "mindmap", "logical_tree"]).optional()
      }
    },
    async (payload) => {
      const result = await runWithMindmapsAccount(ctx, async ({ userId }) => {
        const created = await mindmapsClient.create(ctx.accessToken, payload);
        await maintainMindmapIndexBestEffort(ctx.accessToken, created);
        await invalidateMindmapIndexFromMcp(userId, mindmapProjectIdsBestEffort(created), objectId(created) ?? "unknown");
        return created;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "mindmaps.update",
    {
      title: "Update Mindmap",
      description: "Update a Mindmap document with optional optimistic concurrency and refresh its Project index entry.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        mode: mindmapModeSchema.optional(),
        projectId: z.string().nullable().optional(),
        projectName: z.string().nullable().optional(),
        body: z.unknown().optional(),
        tags: z.array(z.string()).optional(),
        expectedVersion: z.number().int().positive().optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithMindmapsAccount(ctx, async ({ userId }) => {
        const before = await mindmapsClient.get(ctx.accessToken, id);
        const projectIds = mindmapProjectIdsBestEffort(before);
        const updated = await mindmapsClient.update(ctx.accessToken, id, payload);
        await reconcileMindmapMutationBestEffort(ctx.accessToken, before, updated);
        projectIds.push(...mindmapProjectIdsBestEffort(updated));
        await invalidateMindmapIndexFromMcp(userId, projectIds, id);
        return updated;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "mindmaps.delete",
    {
      title: "Delete Mindmap",
      description: "Delete a Mindmap document and tombstone its Project index entry.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithMindmapsAccount(ctx, async ({ userId }) => {
        const before = await mindmapsClient.get(ctx.accessToken, id);
        const projectIds = mindmapProjectIdsBestEffort(before);
        await mindmapsClient.remove(ctx.accessToken, id);
        await cleanupDeletedMindmapBestEffort(ctx.accessToken, before);
        await invalidateMindmapIndexFromMcp(userId, projectIds, id, "delete");
        return { status: "ok" };
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "mindmaps.export",
    {
      title: "Export Mindmap",
      description: "Render a Mindmap document as JSON, Markdown, or SVG content.",
      inputSchema: {
        id: z.string().min(1),
        format: mindmapExportFormatSchema.default("markdown")
      }
    },
    async ({ id, format }) => {
      const result = await runWithMindmapsAccount(ctx, () =>
        mindmapsClient.exportContent(ctx.accessToken, id, { format })
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "mindmaps.artifact.save",
    {
      title: "Save Mindmap Artifact",
      description: "Save a Mindmap export snapshot to Artifacts without changing the Mindmap source document.",
      inputSchema: {
        id: z.string().min(1),
        format: mindmapExportFormatSchema.default("markdown"),
        artifactTitle: z.string().optional(),
        artifactPath: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithMindmapsAccount(ctx, async ({ userId }) => {
        const saved = await saveMindmapExportArtifact(ctx.accessToken, id, payload);
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
    "mindmaps.projectIndex.rebuild",
    {
      title: "Rebuild Mindmap Project Index",
      description: "Repair a Project's Mindmap index entries by scanning Mindmap documents for that Project and tombstoning drift.",
      inputSchema: {
        projectId: z.string().min(1)
      }
    },
    async ({ projectId }) => {
      const result = await runWithMindmapsAccount(ctx, async ({ userId }) => {
        const rebuilt = await rebuildProjectMindmapIndex(ctx.accessToken, projectId);
        await invalidateMindmapIndexFromMcp(userId, [projectId], projectId);
        return rebuilt;
      });
      return asMcpText(result);
    }
  );
}
