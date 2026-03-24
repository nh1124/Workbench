import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactsClient } from "../internalClients.js";
import { asMcpText, runWithAuth, tokenInput } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

export function registerArtifactsTools(server: McpServer, ctx?: ToolContext): void {
  server.registerTool(
    "artifacts.list",
    {
      title: "List Artifacts",
      description: "List artifacts for the authenticated user.",
      inputSchema: {
        ...tokenInput,
        projectId: z.string().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async ({ accessToken, projectId, limit }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => artifactsClient.list(token!, projectId, limit), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.get",
    {
      title: "Get Artifact",
      description: "Get an artifact by id.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => artifactsClient.get(token!, id), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.create",
    {
      title: "Create Artifact",
      description: "Create an artifact.",
      inputSchema: {
        ...tokenInput,
        name: z.string().min(1),
        type: z.string().min(1),
        description: z.string().optional(),
        projectId: z.string().min(1),
        projectName: z.string().optional(),
        url: z.string().optional()
      }
    },
    async ({ accessToken, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => artifactsClient.create(token!, payload), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.update",
    {
      title: "Update Artifact",
      description: "Update an artifact.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        url: z.string().optional()
      }
    },
    async ({ accessToken, id, ...payload }) => {
      const token = accessToken ?? ctx?.accessToken;
      const result = await runWithAuth(accessToken, () => artifactsClient.update(token!, id, payload), ctx?.accessToken);
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.delete",
    {
      title: "Delete Artifact",
      description: "Delete an artifact.",
      inputSchema: {
        ...tokenInput,
        id: z.string().min(1)
      }
    },
    async ({ accessToken, id }) => {
      const token = accessToken ?? ctx?.accessToken;
      await runWithAuth(accessToken, () => artifactsClient.remove(token!, id), ctx?.accessToken);
      return asMcpText({ status: "ok" });
    }
  );
}
