import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectsClient } from "../internalClients.js";
import { asMcpText, runWithAuth, tokenInput } from "./helpers.js";

const projectStatusSchema = z.enum(["draft", "active", "archived"]);

type ToolContext = {
  accessToken: string;
};

export function registerProjectsTools(server: McpServer, ctx?: ToolContext): void {
  server.registerTool(
    "projects.list",
    {
      title: "List Projects",
      description: "List projects for the authenticated user.",
      inputSchema: {
        ...tokenInput,
        query: z.string().optional(),
        status: projectStatusSchema.optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().optional()
      }
    },
    async ({ accessToken, query, status, limit, cursor }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(
        accessToken,
        () => projectsClient.list(token!, query, status, limit, cursor),
        ctx?.accessToken
      );
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.get",
    {
      title: "Get Project",
      description: "Get a project by id.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => projectsClient.get(token!, id), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.create",
    {
      title: "Create Project",
      description: "Create a project.",
      inputSchema: {
        ...tokenInput,
        name: z.string().min(1),
        description: z.string().optional(),
        status: projectStatusSchema.optional(),
        ownerAccountId: z.string().optional()
      }
    },
    async ({ accessToken, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => projectsClient.create(token!, payload), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.update",
    {
      title: "Update Project",
      description: "Update a project.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        status: projectStatusSchema.optional()
      }
    },
    async ({ accessToken, id, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => projectsClient.update(token!, id, payload), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.delete",
    {
      title: "Delete Project",
      description: "Delete a project.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const token = accessToken ?? ctx?.accessToken;
      await runWithAuth(accessToken, () => projectsClient.remove(token!, id), ctx?.accessToken);
      return asMcpText({ status: "ok" });
    }
  );
}
