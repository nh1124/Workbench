import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectsClient } from "../internalClients.js";
import { asMcpText, runWithAuth } from "./helpers.js";

const projectStatusSchema = z.enum(["draft", "active", "archived"]);

type ToolContext = {
  accessToken: string;
};

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
      const result = await runWithAuth(ctx.accessToken, () => projectsClient.create(ctx.accessToken, payload));
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
      const result = await runWithAuth(ctx.accessToken, () => projectsClient.update(ctx.accessToken, id, payload));
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
      await runWithAuth(ctx.accessToken, () => projectsClient.remove(ctx.accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );
}
