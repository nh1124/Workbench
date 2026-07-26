import express from "express";
import { projectsClient } from "../internalClients.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import {
  createProjectLinkWithValidation,
  deleteProjectWithGuard,
  getProjectContextWithResolvedLinks,
  getProjectDeletionImpact,
  listProjectLinksResolved,
  rebuildProjectIndex,
  removeProjectLinkWithValidation
} from "../projectContext.js";
import {
  projectIdFromMutationResult,
  requireProjectContextEndpoints
} from "../projectContextSync.js";
import {
  asJsonRecord,
  asNonEmptyString,
  invalidateProjectContextFromApi,
  objectId,
  recordSyncEventBestEffort,
  respondInternalError
} from "./shared.js";

export function registerProjectRoutes(app: express.Express): void {
app.get("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  try {
    const result = await projectsClient.list(
      authContext.accessToken,
      query,
      status,
      Number.isFinite(limit) ? limit : undefined,
      cursor
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.create(authContext.accessToken, req.body);
    const projectId = objectId(result);
    await recordSyncEventBestEffort(authContext.userId, "projects", projectId, "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    if (projectId) {
      await invalidateProjectContextFromApi(authContext.userId, [projectId], "project", "project", projectId);
    }
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.getDefault(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.setDefault(authContext.accessToken, req.body);
    const body = asJsonRecord(req.body);
    const projectId = asNonEmptyString(body.projectId) ?? objectId(result);
    await recordSyncEventBestEffort(authContext.userId, "projects", projectId, "update", {
      source: "core-api",
      relation: "default",
      projectId,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/context", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const numberQuery = (name: string): number | undefined => {
    const value = typeof req.query[name] === "string" ? Number(req.query[name]) : undefined;
    return Number.isFinite(value) ? value : undefined;
  };
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const projectId = String(req.params.projectId);
    const result = await getProjectContextWithResolvedLinks(authContext.accessToken, String(req.params.projectId), {
      q: query,
      include: typeof req.query.include === "string" ? req.query.include : undefined,
      memoryLimit: numberQuery("memoryLimit"),
      indexLimit: numberQuery("indexLimit"),
      relationLimit: numberQuery("relationLimit"),
      maxChars: numberQuery("maxChars")
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/brief", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(await projectsClient.getBrief(authContext.accessToken, String(req.params.projectId)));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/projects/:projectId/brief", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const body = asJsonRecord(req.body);
  try {
    const result = await projectsClient.updateBrief(authContext.accessToken, String(req.params.projectId), {
      contentMarkdown: body.contentMarkdown,
      expectedVersion: body.expectedVersion,
      updatedByKind: "user"
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "brief",
      "brief",
      String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/memories", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const result = await projectsClient.listMemories(authContext.accessToken, String(req.params.projectId), {
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      authority: typeof req.query.authority === "string" ? req.query.authority : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/memories", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.appendMemory(authContext.accessToken, String(req.params.projectId), {
      ...asJsonRecord(req.body),
      authority: asNonEmptyString(asJsonRecord(req.body).authority) ?? "user_confirmed",
      createdByKind: "user"
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "memory",
      "memory",
      objectId(result) ?? String(req.params.projectId)
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/project-memories/:memoryId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.updateMemory(authContext.accessToken, String(req.params.memoryId), req.body);
    await invalidateProjectContextFromApi(
      authContext.userId,
      [projectIdFromMutationResult(result)],
      "memory",
      "memory",
      String(req.params.memoryId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/index", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const projectId = String(req.params.projectId);
    const result = await projectsClient.listIndexEntries(authContext.accessToken, projectId, {
      q: query,
      sourceService: typeof req.query.sourceService === "string" ? req.query.sourceService : undefined,
      resourceType: typeof req.query.resourceType === "string" ? req.query.resourceType : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/index/rebuild", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await rebuildProjectIndex(authContext.accessToken, String(req.params.projectId));
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "index",
      "index",
      String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/deletion-impact", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(await getProjectDeletionImpact(authContext.accessToken, String(req.params.projectId)));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/relations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    return res.json(
      await projectsClient.listRelations(authContext.accessToken, String(req.params.projectId), {
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
      })
    );
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/relations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.createRelation(authContext.accessToken, String(req.params.projectId), {
      ...asJsonRecord(req.body),
      createdByKind: "user"
    });
    const endpoints = requireProjectContextEndpoints(result);
    await invalidateProjectContextFromApi(
      authContext.userId,
      [endpoints.sourceProjectId, endpoints.targetProjectId],
      "relation",
      "relation",
      endpoints.id
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/project-relations/:relationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.updateRelation(authContext.accessToken, String(req.params.relationId), req.body);
    const endpoints = requireProjectContextEndpoints(result);
    await invalidateProjectContextFromApi(
      authContext.userId,
      [endpoints.sourceProjectId, endpoints.targetProjectId],
      "relation",
      "relation",
      endpoints.id
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/project-relations/:relationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const relation = await projectsClient.getRelation(authContext.accessToken, String(req.params.relationId));
    const endpoints = requireProjectContextEndpoints(relation);
    await projectsClient.removeRelation(authContext.accessToken, String(req.params.relationId));
    await invalidateProjectContextFromApi(
      authContext.userId,
      [endpoints.sourceProjectId, endpoints.targetProjectId],
      "relation",
      "relation",
      endpoints.id
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/links", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    return res.json(
      await listProjectLinksResolved(authContext.accessToken, String(req.params.projectId), {
        targetService: typeof req.query.targetService === "string" ? req.query.targetService : undefined,
        targetResourceType:
          typeof req.query.targetResourceType === "string" ? req.query.targetResourceType : undefined,
        targetResourceId: typeof req.query.targetResourceId === "string" ? req.query.targetResourceId : undefined,
        relationType: typeof req.query.relationType === "string" ? req.query.relationType : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
      })
    );
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/links", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await createProjectLinkWithValidation(
      authContext.accessToken,
      String(req.params.projectId),
      req.body
    );
    const linkRelationType = asNonEmptyString(asJsonRecord(result).relationType)
      ?? asNonEmptyString(asJsonRecord(req.body).relationType);
    const changed = linkRelationType === "secondary_membership" ? "membership" : "link";
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      changed === "membership" ? ["membership", "index"] : changed,
      changed,
      objectId(result) ?? String(req.params.projectId)
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/project-links/:linkId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const link = await removeProjectLinkWithValidation(authContext.accessToken, String(req.params.linkId));
    const changed = link.relationType === "secondary_membership" ? "membership" : "link";
    await invalidateProjectContextFromApi(
      authContext.userId,
      [link.projectId],
      changed === "membership" ? ["membership", "index"] : changed,
      changed,
      link.id
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/context-summary", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(await projectsClient.getContextSummary(authContext.accessToken, String(req.params.projectId)));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/context-summary/refresh", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.refreshContextSummary(
      authContext.accessToken,
      String(req.params.projectId),
      req.body
    );
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "summary",
      "summary",
      objectId(result) ?? String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.get(authContext.accessToken, String(req.params.projectId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.update(authContext.accessToken, String(req.params.projectId), req.body);
    await recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "project",
      "project",
      String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await deleteProjectWithGuard(authContext.accessToken, String(req.params.projectId));
    await recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "delete", {
      source: "core-api",
      deleted: true
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "project",
      "project",
      String(req.params.projectId),
      "delete"
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});
}
