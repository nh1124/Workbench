import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { notesClient } from "../internalClients.js";
import { asMcpText, runWithAuth, tokenInput } from "./helpers.js";

export function registerNotesTools(server: McpServer): void {
  server.registerTool(
    "notes.list",
    {
      title: "List Notes",
      description: "List notes for the authenticated user.",
      inputSchema: {
        ...tokenInput,
        projectId: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ accessToken, projectId, limit }) => {
      const result = await runWithAuth(accessToken, () => notesClient.list(accessToken, projectId, limit));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.get",
    {
      title: "Get Note",
      description: "Get a note by id.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const result = await runWithAuth(accessToken, () => notesClient.get(accessToken, id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.create",
    {
      title: "Create Note",
      description: "Create a note.",
      inputSchema: {
        ...tokenInput,
        title: z.string().min(1),
        content: z.string().optional(),
        projectId: z.string().min(1),
        projectName: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ accessToken, ...payload }) => {
      const result = await runWithAuth(accessToken, () => notesClient.create(accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.update",
    {
      title: "Update Note",
      description: "Update a note.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1),
        title: z.string().optional(),
        content: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ accessToken, id, ...payload }) => {
      const result = await runWithAuth(accessToken, () => notesClient.update(accessToken, id, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "notes.delete",
    {
      title: "Delete Note",
      description: "Delete a note.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      await runWithAuth(accessToken, () => notesClient.remove(accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );
}
