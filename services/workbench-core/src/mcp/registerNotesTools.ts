import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { notesClient } from "../internalClients.js";
import { asMcpText, runWithAuth, tokenInput } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerNotesTools(server: McpServer, ctx?: ToolContext): void {
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
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => notesClient.list(token!, projectId, limit), ctx?.accessToken);
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
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => notesClient.get(token!, id), ctx?.accessToken);
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
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => notesClient.create(token!, payload), ctx?.accessToken);
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
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => notesClient.update(token!, id, payload), ctx?.accessToken);
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
      const token = accessToken ?? ctx?.accessToken;
      await runWithAuth(accessToken, () => notesClient.remove(token!, id), ctx?.accessToken);
      return asMcpText({ status: "ok" });
    }
  );
}
