import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { artifactsClient } from "../internalClients.js";
import { createLocalJob, getLocalJob, serializeLocalJobForOwner } from "../localClientsStore.js";
import {
  createArtifactNoteWithIndex,
  getArtifactProjectMemberships,
  linkArtifactToProject,
  maintainArtifactIndexBestEffort,
  reconcileArtifactMutationBestEffort,
  removeArtifactItemWithProjectCleanup,
  unlinkArtifactFromProject,
  uploadArtifactFileWithIndex
} from "../projectContext.js";
import { asMcpText, runWithAuth, runWithAuthContext } from "./helpers.js";

type ToolContext = {
  accessToken: string;
};

const artifactItemKindSchema = z.enum(["folder", "note", "file"]);
const artifactScopeSchema = z.enum(["private", "org", "project"]);
const artifactNotePatchOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("insert"),
    index: z.number().int().nonnegative(),
    text: z.string()
  }),
  z.object({
    type: z.literal("delete"),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("replace"),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string()
  })
]);

function compactArtifactItemResult(value: unknown, includeContent = false): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const item = value as Record<string, unknown>;
  if (includeContent) {
    return item;
  }

  const { contentMarkdown, ...rest } = item;
  if (typeof contentMarkdown === "string") {
    return {
      ...rest,
      contentLength: contentMarkdown.length
    };
  }
  return rest;
}

async function updateArtifactItemWithIndex(token: string, id: string, payload: unknown): Promise<unknown> {
  let before: unknown;
  try {
    before = await artifactsClient.getItem(token, id);
  } catch {
    before = undefined;
  }
  const result = await artifactsClient.updateItem(token, id, payload);
  if (before) await reconcileArtifactMutationBestEffort(token, before, result);
  else await maintainArtifactIndexBestEffort(token, result);
  return result;
}

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
    "artifacts.tree.list",
    {
      title: "List Artifact Tree Items",
      description: "List artifact tree items with server-side filters. Prefer this over artifacts.tree for MCP efficiency.",
      inputSchema: {
        projectId: z.string().optional(),
        pathPrefix: z.string().optional(),
        kinds: z.array(artifactItemKindSchema).optional(),
        includeContent: z.boolean().optional(),
        updatedSince: z.string().optional(),
        limit: z.number().int().positive().max(500).optional()
      }
    },
    async (options) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.treeList(ctx.accessToken, options));
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
    "artifacts.item.projects.list",
    {
      title: "List Artifact Item Projects",
      description: "List the primary and explicit secondary Project memberships for an Artifact item.",
      inputSchema: { artifactItemId: z.string().min(1) }
    },
    async ({ artifactItemId }) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () => getArtifactProjectMemberships(ctx.accessToken, artifactItemId))
      )
  );

  server.registerTool(
    "artifacts.item.projects.link",
    {
      title: "Link Artifact Item To Project",
      description: "Add a validated secondary Project membership without duplicating the Artifact.",
      inputSchema: {
        artifactItemId: z.string().min(1),
        projectId: z.string().min(1),
        note: z.string().optional(),
        expectedArtifactVersion: z.number().int().positive().optional()
      }
    },
    async ({ artifactItemId, ...input }) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () => linkArtifactToProject(ctx.accessToken, artifactItemId, input))
      )
  );

  server.registerTool(
    "artifacts.item.projects.unlink",
    {
      title: "Unlink Artifact Item From Project",
      description: "Remove a secondary membership. The primary Project and Artifact content are never deleted.",
      inputSchema: {
        artifactItemId: z.string().min(1),
        projectId: z.string().min(1)
      }
    },
    async ({ artifactItemId, projectId }) => {
      await runWithAuth(ctx.accessToken, () =>
        unlinkArtifactFromProject(ctx.accessToken, artifactItemId, projectId)
      );
      return asMcpText({ status: "ok" });
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
        scope: artifactScopeSchema.optional()
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => artifactsClient.createFolder(ctx.accessToken, payload));
      await maintainArtifactIndexBestEffort(ctx.accessToken, result);
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
        scope: artifactScopeSchema.optional(),
        tags: z.array(z.string()).optional(),
        contentMarkdown: z.string().optional()
      }
    },
    async (payload) => {
      const result = await runWithAuth(ctx.accessToken, () => createArtifactNoteWithIndex(ctx.accessToken, payload));
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
        projectId: z.string().optional(),
        scope: artifactScopeSchema.optional(),
        tags: z.array(z.string()).optional(),
        contentMarkdown: z.string().optional(),
        projectName: z.string().optional()
      }
    },
    async ({ id, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () => updateArtifactItemWithIndex(ctx.accessToken, id, payload));
      return asMcpText(result);
    }
  );

  server.registerTool(
    "artifacts.item.metadata.update",
    {
      title: "Update Artifact Item Metadata",
      description: "Update artifact item metadata only. Use this instead of artifacts.item.update when content does not change.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().optional(),
        path: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        scope: artifactScopeSchema.optional(),
        tags: z.array(z.string()).optional(),
        returnContent: z.boolean().optional()
      }
    },
    async ({ id, returnContent, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () => updateArtifactItemWithIndex(ctx.accessToken, id, payload));
      return asMcpText(compactArtifactItemResult(result, returnContent));
    }
  );

  server.registerTool(
    "artifacts.item.move",
    {
      title: "Move Artifact Item",
      description: "Move an artifact item to a path and/or project without sending content.",
      inputSchema: {
        id: z.string().min(1),
        path: z.string().optional(),
        projectId: z.string().optional(),
        projectName: z.string().optional(),
        returnContent: z.boolean().optional()
      }
    },
    async ({ id, returnContent, ...payload }) => {
      if (!payload.path && !payload.projectId) {
        throw new Error("path or projectId is required");
      }
      const result = await runWithAuth(ctx.accessToken, () => updateArtifactItemWithIndex(ctx.accessToken, id, payload));
      return asMcpText(compactArtifactItemResult(result, returnContent));
    }
  );

  server.registerTool(
    "artifacts.folder.moveProject",
    {
      title: "Move Artifact Folder To Project",
      description: "Move a folder and all descendant artifact items to another project without sending content.",
      inputSchema: {
        id: z.string().min(1),
        projectId: z.string().min(1),
        projectName: z.string().optional()
      }
    },
    async ({ id, projectId, projectName }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        updateArtifactItemWithIndex(ctx.accessToken, id, { projectId, projectName })
      );
      return asMcpText(compactArtifactItemResult(result));
    }
  );

  server.registerTool(
    "artifacts.note.patch",
    {
      title: "Patch Artifact Note",
      description: "Apply offset-based markdown edits to a note. Use expectedVersion to avoid overwriting concurrent edits.",
      inputSchema: {
        id: z.string().min(1),
        expectedVersion: z.number().int().positive().optional(),
        operations: z.array(artifactNotePatchOperationSchema).min(1).max(100),
        returnContent: z.boolean().optional()
      }
    },
    async ({ id, returnContent, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        artifactsClient.patchNoteContent(ctx.accessToken, id, payload)
      );
      await maintainArtifactIndexBestEffort(ctx.accessToken, result);
      return asMcpText(compactArtifactItemResult(result, returnContent));
    }
  );

  server.registerTool(
    "artifacts.note.section.update",
    {
      title: "Update Artifact Note Section",
      description: "Replace, append, or prepend a markdown heading section without sending the full note content.",
      inputSchema: {
        id: z.string().min(1),
        heading: z.string().min(1),
        level: z.number().int().min(1).max(6).optional(),
        expectedVersion: z.number().int().positive().optional(),
        mode: z.enum(["replaceBody", "appendBody", "prependBody"]).optional(),
        contentMarkdown: z.string(),
        createIfMissing: z.boolean().optional(),
        returnContent: z.boolean().optional()
      }
    },
    async ({ id, returnContent, ...payload }) => {
      const result = await runWithAuth(ctx.accessToken, () =>
        artifactsClient.updateNoteSection(ctx.accessToken, id, payload)
      );
      await maintainArtifactIndexBestEffort(ctx.accessToken, result);
      return asMcpText(compactArtifactItemResult(result, returnContent));
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
      await runWithAuth(ctx.accessToken, () => removeArtifactItemWithProjectCleanup(ctx.accessToken, id));
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
      const result = await runWithAuth(ctx.accessToken, () => uploadArtifactFileWithIndex(ctx.accessToken, payload));
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

  server.registerTool(
    "artifacts.download.to_client",
    {
      title: "Download Artifact File To Local Client",
      description:
        "Create a daemon-pulled local job that downloads an artifact file to an enabled Workbench local client. " +
        "Use this instead of artifacts.download when a local path is needed.",
      inputSchema: {
        id: z.string().min(1),
        localClientId: z.string().optional(),
        target: z.enum(["downloads", "sync-folder"]).optional(),
        filename: z.string().optional()
      }
    },
    async ({ id, localClientId, target, filename }) => {
      const job = await runWithAuthContext(ctx.accessToken, ({ userId }) =>
        createLocalJob(userId, {
          localClientId,
          kind: "download_artifact",
          target: target ?? "downloads",
          payload: {
            artifactItemId: id,
            filename
          }
        })
      );
      return asMcpText({
        jobId: job.id,
        localClientId: job.localClientId,
        status: job.status,
        target: job.target
      });
    }
  );

  server.registerTool(
    "artifacts.download.to_client.status",
    {
      title: "Get Local Client Artifact Download Job Status",
      description:
        "Read completion status for an artifact download local-client job. " +
        "The local path is redacted unless includeLocalPath is true.",
      inputSchema: {
        jobId: z.string().min(1),
        includeLocalPath: z.boolean().optional()
      }
    },
    async ({ jobId, includeLocalPath }) => {
      const job = await runWithAuthContext(ctx.accessToken, ({ userId }) => getLocalJob(userId, jobId));
      if (!job) {
        throw new Error("Local job not found");
      }
      return asMcpText(serializeLocalJobForOwner(job, { includeLocalPaths: includeLocalPath === true }));
    }
  );
}
