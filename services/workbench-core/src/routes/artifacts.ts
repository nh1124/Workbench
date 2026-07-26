import express from "express";
import { artifactsClient, serviceBaseUrls } from "../internalClients.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import {
  createArtifactNoteWithIndex,
  getArtifactProjectMemberships,
  linkArtifactToProject,
  listArtifactProjectIdsBestEffort,
  maintainArtifactIndexBestEffort,
  projectIdsFromArtifactDeletionSnapshot,
  reconcileArtifactMutationBestEffort,
  removeArtifactItemWithProjectCleanup,
  unlinkArtifactFromProject
} from "../projectContext.js";
import { artifactDeletionSnapshotRoot, artifactEventMetadata } from "../syncEventMetadata.js";
import {
  asJsonRecord,
  asNonEmptyString,
  invalidateArtifactIndexFromApi,
  invalidateProjectContextFromApi,
  jsonRecordFromBuffer,
  objectId,
  recordSyncEventBestEffort,
  respondInternalError
} from "./shared.js";

export function registerArtifactRoutes(app: express.Express): void {
app.get("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.list(authContext.accessToken, projectId, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  try {
    const result = await artifactsClient.tree(authContext.accessToken, projectId);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree/list", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const pathPrefix = typeof req.query.pathPrefix === "string" ? req.query.pathPrefix : undefined;
  const kinds = typeof req.query.kinds === "string" ? req.query.kinds.split(",").map((kind) => kind.trim()) : undefined;
  const includeContent = typeof req.query.includeContent === "string" ? ["1", "true", "yes"].includes(req.query.includeContent.toLowerCase()) : undefined;
  const updatedSince = typeof req.query.updatedSince === "string" ? req.query.updatedSince : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.treeList(authContext.accessToken, {
      projectId,
      pathPrefix,
      kinds,
      includeContent,
      updatedSince,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.getItem(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:artifactItemId/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(
      await getArtifactProjectMemberships(authContext.accessToken, String(req.params.artifactItemId))
    );
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/items/:artifactItemId/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const body = asJsonRecord(req.body);
  const projectId = asNonEmptyString(body.projectId);
  if (!projectId) return res.status(400).json({ message: "projectId is required" });
  try {
    const result = await linkArtifactToProject(authContext.accessToken, String(req.params.artifactItemId), {
      projectId,
      note: asNonEmptyString(body.note),
      expectedArtifactVersion:
        typeof body.expectedArtifactVersion === "number" ? body.expectedArtifactVersion : undefined
    });
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.artifactItemId), "update", {
      source: "core-api",
      relation: "project-membership",
      action: "link",
      projectId
    }, { projectId });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [projectId],
      ["membership", "index"],
      "membership",
      String(req.params.artifactItemId)
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/items/:artifactItemId/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await unlinkArtifactFromProject(
      authContext.accessToken,
      String(req.params.artifactItemId),
      String(req.params.projectId)
    );
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.artifactItemId), "update", {
      source: "core-api",
      relation: "project-membership",
      action: "unlink",
      projectId: String(req.params.projectId)
    }, { projectId: String(req.params.projectId) });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      ["membership", "index"],
      "membership",
      String(req.params.artifactItemId)
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/folders", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.createFolder(authContext.accessToken, req.body);
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(undefined, result));
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, objectId(result) ?? "unknown");
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await createArtifactNoteWithIndex(authContext.accessToken, req.body);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(undefined, result));
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, objectId(result) ?? "unknown");
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/upload", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const target = `${serviceBaseUrls.artifacts}/artifacts/upload`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) {
      res.setHeader("Content-Type", responseContentType);
    }

    if (upstream.ok && responseContentType?.includes("application/json")) {
      const result = jsonRecordFromBuffer(buffer);
      await maintainArtifactIndexBestEffort(authContext.accessToken, result);
      const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
      await invalidateArtifactIndexFromApi(authContext.userId, projectIds, objectId(result) ?? "unknown");
    }

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.patch("/api/artifacts/items/:id/content-patch", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.patchNoteContent(authContext.accessToken, String(req.params.id), req.body);
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/items/:id/section", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.updateNoteSection(authContext.accessToken, String(req.params.id), req.body);
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    let before: unknown;
    let projectIds: string[] = [];
    try {
      before = await artifactsClient.getItem(authContext.accessToken, String(req.params.id));
      projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, before);
    } catch {
      before = undefined;
    }
    const result = await artifactsClient.updateItem(authContext.accessToken, String(req.params.id), req.body);
    if (before) {
      await reconcileArtifactMutationBestEffort(authContext.accessToken, before, result);
    } else {
      await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    }
    projectIds.push(...await listArtifactProjectIdsBestEffort(authContext.accessToken, result));
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(before, result));
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const snapshot = await removeArtifactItemWithProjectCleanup(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    }, artifactEventMetadata(artifactDeletionSnapshotRoot(snapshot)));
    await invalidateArtifactIndexFromApi(
      authContext.userId,
      projectIdsFromArtifactDeletionSnapshot(snapshot),
      String(req.params.id)
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") {
    query.set("download", req.query.download);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/download${suffix}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/items/:id/preview-pdf", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/preview-pdf`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.create(authContext.accessToken, req.body);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(undefined, result, "artifact"));
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    let before: unknown;
    try {
      before = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    } catch {
      before = undefined;
    }
    const result = await artifactsClient.update(authContext.accessToken, String(req.params.id), req.body);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(before, result, "artifact"));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    let before: unknown;
    try {
      before = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    } catch {
      before = undefined;
    }
    await artifactsClient.remove(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    }, artifactEventMetadata(before, undefined, "artifact"));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});
}
