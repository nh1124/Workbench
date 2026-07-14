import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectsClient } from "../internalClients.js";
import { logger } from "../logger.js";
import { deleteProjectWithGuard } from "../projectContext.js";
import { recordProjectContextInvalidationsBestEffort } from "../projectContextSync.js";
import { recordSyncEvent, type SyncAction } from "../syncStore.js";
import { asMcpText, runWithAuth, runWithAuthContext } from "./helpers.js";

const projectStatusSchema = z.enum(["draft", "active", "archived"]);

type ToolContext = {
  accessToken: string;
};

function resultId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function invalidateProjectFromMcp(
  userId: string,
  projectId: string,
  action: "update" | "delete" = "update"
): Promise<void> {
  await recordProjectContextInvalidationsBestEffort(userId, [projectId], {
    changed: ["project"],
    entityType: "project",
    entityId: projectId,
    source: "core-mcp",
    action
  });
}

async function recordBaseProjectEventFromMcp(
  userId: string,
  projectId: string,
  action: SyncAction,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await recordSyncEvent(userId, "projects", projectId, action, payload);
  } catch (error) {
    logger.warn("[sync] failed to record MCP Project event", {
      projectId,
      action,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function registerProjectsTools(server: McpServer, ctx: ToolContext): void;
export function registerProjectsTools(server: McpServer): void;
export function registerProjectsTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }
  server.registerTool(
    "projects.list",
    {
      title: "List Projects",
      description: "List projects for the authenticated user.",
      inputSchema: {
        query: z.string().optional(),
        status: projectStatusSchema.optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional()
      }
    },
    async ({ query, status, limit, cursor }) => {
      const result = await runWithAuth(ctx.accessToken, () => projectsClient.list(ctx.accessToken, query, status, limit, cursor));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.get",
    {
      title: "Get Project",
      description: "Get a project by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithAuth(ctx.accessToken, () => projectsClient.get(ctx.accessToken, id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.create",
    {
      title: "Create Project",
      description: "Create a project.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        status: projectStatusSchema.optional(),
        ownerAccountId: z.string().optional()
      }
    },
    async (payload) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const project = await projectsClient.create(ctx.accessToken, payload);
        const projectId = resultId(project);
        if (projectId) {
          await recordBaseProjectEventFromMcp(userId, projectId, "create", {
            source: "core-mcp",
            resource: project as Record<string, unknown>
          });
          await invalidateProjectFromMcp(userId, projectId);
        }
        return project;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.update",
    {
      title: "Update Project",
      description: "Update a project.",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        status: projectStatusSchema.optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const project = await projectsClient.update(ctx.accessToken, id, payload);
        await recordBaseProjectEventFromMcp(userId, id, "update", {
          source: "core-mcp",
          patch: payload,
          resource: project as Record<string, unknown>
        });
        await invalidateProjectFromMcp(userId, id);
        return project;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.delete",
    {
      title: "Delete Project",
      description: "Delete a project.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        await deleteProjectWithGuard(ctx.accessToken, id);
        await recordBaseProjectEventFromMcp(userId, id, "delete", {
          source: "core-mcp",
          deleted: true
        });
        await invalidateProjectFromMcp(userId, id, "delete");
      });
      return asMcpText({ status: "ok" });
    }
  );
}
