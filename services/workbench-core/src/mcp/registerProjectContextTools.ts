import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectsClient } from "../internalClients.js";
import {
  createProjectLinkWithValidation,
  getProjectDeletionImpact,
  rebuildProjectArtifactIndex,
  removeProjectLinkWithValidation
} from "../projectContext.js";
import {
  projectIdFromMutationResult,
  recordProjectContextInvalidationsBestEffort,
  requireProjectContextEndpoints,
  type ProjectContextChanged
} from "../projectContextSync.js";
import { asMcpText, runWithAuth, runWithAuthContext } from "./helpers.js";

type ToolContext = { accessToken: string };

const memoryKindSchema = z.enum(["decision", "fact", "preference", "pitfall", "observation"]);
const memoryAuthoritySchema = z.enum(["user_confirmed", "agent_observed", "imported"]);
const memoryStatusSchema = z.enum(["active", "archived", "superseded"]);
const relationTypeSchema = z.enum(["related", "depends_on", "supports", "informs", "overlaps"]);
const directionalitySchema = z.enum(["directed", "bidirectional"]);

async function invalidateProjectContextFromMcp(
  userId: string,
  projectIds: Array<string | undefined>,
  changed: ProjectContextChanged,
  entityId: string
): Promise<void> {
  await recordProjectContextInvalidationsBestEffort(userId, projectIds, {
    changed: [changed],
    entityType: changed,
    entityId,
    source: "core-mcp"
  });
}

function resultId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function resultRelationType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const relationType = (value as { relationType?: unknown }).relationType;
  return typeof relationType === "string" && relationType.trim() ? relationType.trim() : undefined;
}

export function registerProjectContextTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "projects.context.get",
    {
      title: "Get Project Context",
      description: "Get a token-budgeted Project context pack before operating on that Project.",
      inputSchema: {
        projectId: z.string().min(1),
        q: z.string().optional(),
        include: z.array(z.enum(["brief", "summary", "memory", "index", "relations", "links"])).optional(),
        memoryLimit: z.number().int().positive().max(100).optional(),
        indexLimit: z.number().int().positive().max(500).optional(),
        relationLimit: z.number().int().positive().max(100).optional(),
        maxChars: z.number().int().positive().max(50_000).optional()
      }
    },
    async ({ projectId, include, ...options }) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () =>
          projectsClient.getContext(ctx.accessToken, projectId, {
            ...options,
            include: include?.join(",")
          })
        )
      )
  );

  server.registerTool(
    "projects.brief.get",
    {
      title: "Get Project Brief",
      description: "Read the curated current instructions for a Project.",
      inputSchema: { projectId: z.string().min(1) }
    },
    async ({ projectId }) =>
      asMcpText(await runWithAuth(ctx.accessToken, () => projectsClient.getBrief(ctx.accessToken, projectId)))
  );

  server.registerTool(
    "projects.brief.update",
    {
      title: "Update Project Brief",
      description: "Update durable Project instructions with optimistic concurrency. Use only with explicit user intent.",
      inputSchema: {
        projectId: z.string().min(1),
        contentMarkdown: z.string(),
        expectedVersion: z.number().int().nonnegative()
      }
    },
    async ({ projectId, contentMarkdown, expectedVersion }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const updated = await projectsClient.updateBrief(ctx.accessToken, projectId, {
            contentMarkdown,
            expectedVersion,
            updatedByKind: "agent"
        });
        await invalidateProjectContextFromMcp(userId, [projectId], "brief", projectId);
        return updated;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.memory.list",
    {
      title: "List Project Memory",
      description: "Search durable Project memory entries. Authority and provenance remain visible in results.",
      inputSchema: {
        projectId: z.string().min(1),
        q: z.string().optional(),
        kind: memoryKindSchema.optional(),
        authority: memoryAuthoritySchema.optional(),
        status: memoryStatusSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional()
      }
    },
    async ({ projectId, ...options }) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () => projectsClient.listMemories(ctx.accessToken, projectId, options))
      )
  );

  server.registerTool(
    "projects.memory.append",
    {
      title: "Append Project Memory",
      description: "Append a durable observation. Agent-created entries are always marked agent_observed.",
      inputSchema: {
        projectId: z.string().min(1),
        kind: memoryKindSchema,
        bodyMarkdown: z.string().min(1),
        sourceService: z.string().optional(),
        sourceResourceType: z.string().optional(),
        sourceResourceId: z.string().optional(),
        supersedesId: z.string().optional()
      }
    },
    async ({ projectId, ...payload }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const memory = await projectsClient.appendMemory(ctx.accessToken, projectId, {
            ...payload,
            authority: "agent_observed",
            createdByKind: "agent"
        });
        await invalidateProjectContextFromMcp(userId, [projectId], "memory", resultId(memory) ?? projectId);
        return memory;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.memory.update",
    {
      title: "Update Project Memory",
      description: "Update a Project memory entry without changing it to user-confirmed authority.",
      inputSchema: {
        memoryId: z.string().min(1),
        bodyMarkdown: z.string().min(1).optional(),
        status: memoryStatusSchema.optional()
      }
    },
    async ({ memoryId, ...payload }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const memory = await projectsClient.updateMemory(ctx.accessToken, memoryId, payload);
        await invalidateProjectContextFromMcp(userId, [projectIdFromMutationResult(memory)], "memory", memoryId);
        return memory;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.memory.archive",
    {
      title: "Archive Project Memory",
      description: "Archive a Project memory entry without deleting its audit history.",
      inputSchema: { memoryId: z.string().min(1) }
    },
    async ({ memoryId }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const memory = await projectsClient.updateMemory(ctx.accessToken, memoryId, { status: "archived" });
        await invalidateProjectContextFromMcp(userId, [projectIdFromMutationResult(memory)], "memory", memoryId);
        return memory;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.index.search",
    {
      title: "Search Project Index",
      description: "Search compact derived resource summaries without opening every Artifact.",
      inputSchema: {
        projectId: z.string().min(1),
        q: z.string().optional(),
        sourceService: z.string().optional(),
        resourceType: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional()
      }
    },
    async ({ projectId, ...options }) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () => projectsClient.listIndexEntries(ctx.accessToken, projectId, options))
      )
  );

  server.registerTool(
    "projects.index.rebuild",
    {
      title: "Rebuild Project Index",
      description: "Explicitly repair a Project Artifact index. This is a potentially expensive maintenance operation.",
      inputSchema: { projectId: z.string().min(1) }
    },
    async ({ projectId }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const rebuilt = await rebuildProjectArtifactIndex(ctx.accessToken, projectId);
        await invalidateProjectContextFromMcp(userId, [projectId], "index", projectId);
        return rebuilt;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.delete.preview",
    {
      title: "Preview Project Deletion",
      description: "Read deletion impact without side effects, including blocking primary Artifacts.",
      inputSchema: { projectId: z.string().min(1) }
    },
    async ({ projectId }) =>
      asMcpText(await runWithAuth(ctx.accessToken, () => getProjectDeletionImpact(ctx.accessToken, projectId)))
  );

  server.registerTool(
    "projects.relations.list",
    {
      title: "List Project Relations",
      description: "List explicit depth-one relations for a Project.",
      inputSchema: {
        projectId: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional()
      }
    },
    async ({ projectId, ...options }) =>
      asMcpText(
        await runWithAuth(ctx.accessToken, () => projectsClient.listRelations(ctx.accessToken, projectId, options))
      )
  );

  server.registerTool(
    "projects.relations.add",
    {
      title: "Add Project Relation",
      description: "Create an explicit Project relation; this does not propagate Artifact membership.",
      inputSchema: {
        projectId: z.string().min(1),
        targetProjectId: z.string().min(1),
        relationType: relationTypeSchema,
        directionality: directionalitySchema.optional(),
        note: z.string().optional(),
        strength: z.number().min(0).max(1).optional()
      }
    },
    async ({ projectId, ...payload }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const relation = await projectsClient.createRelation(ctx.accessToken, projectId, {
            ...payload,
            origin: "manual",
            createdByKind: "agent"
        });
        const endpoints = requireProjectContextEndpoints(relation);
        await invalidateProjectContextFromMcp(
          userId,
          [endpoints.sourceProjectId, endpoints.targetProjectId],
          "relation",
          endpoints.id
        );
        return relation;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.relations.update",
    {
      title: "Update Project Relation",
      description: "Update an explicit Project relation.",
      inputSchema: {
        relationId: z.string().min(1),
        relationType: relationTypeSchema.optional(),
        directionality: directionalitySchema.optional(),
        note: z.string().optional(),
        strength: z.number().min(0).max(1).nullable().optional(),
        expectedVersion: z.number().int().positive()
      }
    },
    async ({ relationId, ...payload }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const relation = await projectsClient.updateRelation(ctx.accessToken, relationId, payload);
        const endpoints = requireProjectContextEndpoints(relation);
        await invalidateProjectContextFromMcp(
          userId,
          [endpoints.sourceProjectId, endpoints.targetProjectId],
          "relation",
          endpoints.id
        );
        return relation;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.relations.remove",
    {
      title: "Remove Project Relation",
      description: "Remove an explicit Project relation. Artifact membership is unaffected.",
      inputSchema: { relationId: z.string().min(1) }
    },
    async ({ relationId }) => {
      await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const relation = await projectsClient.getRelation(ctx.accessToken, relationId);
        const endpoints = requireProjectContextEndpoints(relation);
        await projectsClient.removeRelation(ctx.accessToken, relationId);
        await invalidateProjectContextFromMcp(
          userId,
          [endpoints.sourceProjectId, endpoints.targetProjectId],
          "relation",
          endpoints.id
        );
      });
      return asMcpText({ status: "ok" });
    }
  );

  server.registerTool(
    "projects.links.list",
    {
      title: "List Project Links",
      description: "List generic resource links for a Project.",
      inputSchema: {
        projectId: z.string().min(1),
        targetService: z.string().optional(),
        targetResourceType: z.string().optional(),
        targetResourceId: z.string().optional(),
        relationType: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        cursor: z.string().optional()
      }
    },
    async ({ projectId, ...options }) =>
      asMcpText(await runWithAuth(ctx.accessToken, () => projectsClient.listLinks(ctx.accessToken, projectId, options)))
  );

  server.registerTool(
    "projects.links.add",
    {
      title: "Add Project Link",
      description: "Add a generic resource link. Artifact secondary memberships receive full validation and index maintenance.",
      inputSchema: {
        projectId: z.string().min(1),
        targetService: z.string().min(1),
        targetResourceType: z.string().min(1),
        targetResourceId: z.string().min(1),
        relationType: z.string().optional(),
        titleSnapshot: z.string().optional(),
        summarySnapshot: z.string().optional(),
        metadataJson: z.record(z.unknown()).optional()
      }
    },
    async ({ projectId, ...payload }) => {
      const result = await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const link = await createProjectLinkWithValidation(ctx.accessToken, projectId, payload);
        const changed = (resultRelationType(link) ?? payload.relationType?.trim()) === "secondary_membership"
          ? "membership"
          : "link";
        if (changed === "membership") {
          await recordProjectContextInvalidationsBestEffort(userId, [projectId], {
            changed: ["membership", "index"],
            entityType: "membership",
            entityId: resultId(link) ?? projectId,
            source: "core-mcp"
          });
        } else {
          await invalidateProjectContextFromMcp(userId, [projectId], changed, resultId(link) ?? projectId);
        }
        return link;
      });
      return asMcpText(result);
    }
  );

  server.registerTool(
    "projects.links.remove",
    {
      title: "Remove Project Link",
      description: "Remove a resource link. Artifact membership index state is cleaned up when applicable.",
      inputSchema: { linkId: z.string().min(1) }
    },
    async ({ linkId }) => {
      await runWithAuthContext(ctx.accessToken, async ({ userId }) => {
        const link = await removeProjectLinkWithValidation(ctx.accessToken, linkId);
        const changed = link.relationType === "secondary_membership" ? "membership" : "link";
        if (changed === "membership") {
          await recordProjectContextInvalidationsBestEffort(userId, [link.projectId], {
            changed: ["membership", "index"],
            entityType: "membership",
            entityId: link.id,
            source: "core-mcp"
          });
        } else {
          await invalidateProjectContextFromMcp(userId, [link.projectId], changed, link.id);
        }
      });
      return asMcpText({ status: "ok" });
    }
  );
}
