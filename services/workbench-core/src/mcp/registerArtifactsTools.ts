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

  server.registerTool(
    "artifacts.tree",
    {
      title: "List Artifact Tree",
      description: "List artifact items in tree representation for the authenticated user.",
      inputSchema: {
        projectId: z.string().optional()
      }
    },
    async ({ projectId }) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.tree(ctx.accessToken, projectId));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.item.get",
    {
      title: "Get Artifact Item",
      description: "Get a tree/item record by item id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.getItem(ctx.accessToken, id));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.folder.create",
    {
      title: "Create Artifact Folder",
      description: "Create a folder in artifacts tree.",
      inputSchema: {
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        path: z.string().min(1),
        title: z.string().optional(),
        scope: z.enum(["private", "org", "project"]).optional()
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.createFolder(ctx.accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.note.create",
    {
      title: "Create Artifact Note",
      description: "Create a markdown note in artifacts tree.",
      inputSchema: {
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        path: z.string().optional(),
        title: z.string().min(1),
        scope: z.enum(["private", "org", "project"]).optional(),
        tags: z.array(z.string()).optional(),
        contentMarkdown: z.string().optional()
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.createNote(ctx.accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.item.update",
    {
      title: "Update Artifact Item",
      description: "Update artifact item metadata/content/path.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        path: z.string().optional(),
        scope: z.enum(["private", "org", "project"]).optional(),
        tags: z.array(z.string()).optional(),
        contentMarkdown: z.string().optional(),
        projectName: z.string().optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.updateItem(ctx.accessToken, id, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.item.delete",
    {
      title: "Delete Artifact Item",
      description: "Delete a tree/item record by item id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      await runWithAuth(ctx.accessToken, () => artifactsClient.removeItem(ctx.accessToken, id));
      return asMcpText({ status: "ok" });
    }
  );

  server.registerTool(
    "artifacts.upload",
    {
      title: "Upload Artifact File",
      description: "Upload a file into artifacts using base64-encoded content.",
      inputSchema: {
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        directoryPath: z.string().optional(),
        scope: z.enum(["private", "org", "project"]).optional(),
        tags: z.array(z.string()).optional(),
        filename: z.string().min(1),
        mimeType: z.string().optional(),
        contentBase64: z.string().min(1)
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.uploadFile(ctx.accessToken, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.download",
    {
      title: "Download Artifact File",
      description: "Download a file item and return base64-encoded content with metadata.",
      inputSchema: {
        id: z.string().min(1),
        asAttachment: z.boolean().optional()
      }
    },
    async ({ id, asAttachment }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        artifactsClient.downloadFile(ctx.accessToken, id, asAttachment ?? true)
      );
      return asMcpText(result);
    }
  );
}
