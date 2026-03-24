import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactsClient } from "../internalClients.js";
import { asMcpText, runWithAuth } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerArtifactsTools(server: McpServer, ctx: ToolContext): void;
export function registerArtifactsTools(server: McpServer): void;
export function registerArtifactsTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }
  server.registerTool(
    "artifacts.list",
    {
      title: "List Artifacts",
      description: "List artifacts for the authenticated user.",
      inputSchema: {
        projectId: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ projectId, limit }) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.list(ctx.accessToken, projectId, limit));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.get",
    {
      title: "Get Artifact",
      description: "Get an artifact by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.get(ctx.accessToken, id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.create",
    {
      title: "Create Artifact",
      description: "Create an artifact.",
      inputSchema: {
        name: z.string().min(1),
        type: z.string().min(1),
        description: z.string().optional(),
        projectId: z.string().min(1),
        projectName: z.string().optional(),
        url: z.string().optional()
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.create(ctx.accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.update",
    {
      title: "Update Artifact",
      description: "Update an artifact.",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        url: z.string().optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.update(ctx.accessToken, id, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.delete",
    {
      title: "Delete Artifact",
      description: "Delete an artifact.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      await runWithAuth(ctx.accessToken, () => artifactsClient.remove(ctx.accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );
}
