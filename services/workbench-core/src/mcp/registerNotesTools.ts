import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { notesClient } from "../internalClients.js";
import { asMcpText, runWithAuth } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerNotesTools(server: McpServer, ctx: ToolContext): void;
export function registerNotesTools(server: McpServer): void;
export function registerNotesTools(server: McpServer, ctx?: ToolContext): void {
  if (!ctx) {
    throw new Error("Tool context is required");
  }
  server.registerTool(
    "notes.list",
    {
      title: "List Notes",
      description: "List notes for the authenticated user.",
      inputSchema: {
        projectId: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ projectId, limit }) => {
      const result = await runWithAuth(ctx.accessToken, () => notesClient.list(ctx.accessToken, projectId, limit));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.get",
    {
      title: "Get Note",
      description: "Get a note by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithAuth(ctx.accessToken, () => notesClient.get(ctx.accessToken, id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.create",
    {
      title: "Create Note",
      description: "Create a note.",
      inputSchema: {
        title: z.string().min(1),
        content: z.string().optional(),
        projectId: z.string().min(1),
        projectName: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => notesClient.create(ctx.accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.update",
    {
      title: "Update Note",
      description: "Update a note.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        content: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () => notesClient.update(ctx.accessToken, id, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.delete",
    {
      title: "Delete Note",
      description: "Delete a note.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      await runWithAuth(ctx.accessToken, () => notesClient.remove(ctx.accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );
}
