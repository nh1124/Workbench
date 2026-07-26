import express from "express";
import { z } from "zod";
import { mindmapsClient } from "../internalClients.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import {
  cleanupDeletedMindmapBestEffort,
  listArtifactProjectIdsBestEffort,
  maintainMindmapIndexBestEffort,
  mindmapProjectIdsBestEffort,
  rebuildProjectMindmapIndex,
  reconcileMindmapMutationBestEffort,
  saveMindmapExportArtifact
} from "../projectContext.js";
import {
  mindmapArtifactSaveSchema,
  mindmapCreateSchema,
  mindmapExportFormatSchema,
  mindmapUpdateSchema
} from "../schemas/mindmaps.js";
import { ensureMindmapsAccountProvisioned } from "../serviceProvisioning.js";
import {
  invalidateArtifactIndexFromApi,
  invalidateProjectContextFromApi,
  objectId,
  respondInternalError
} from "./shared.js";

async function invalidateMindmapIndexFromApi(
  userId: string,
  projectIds: Array<string | undefined>,
  documentId: string
): Promise<void> {
  await invalidateProjectContextFromApi(userId, projectIds, "index", "index", documentId);
}

export function registerMindmapRoutes(app: express.Express): void {
app.get("/api/mindmaps", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const mode = typeof req.query.mode === "string" && ["mindmap", "logical_tree"].includes(req.query.mode)
    ? req.query.mode
    : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const result = await mindmapsClient.list(authContext.accessToken, {
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      mode,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/mindmaps", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = mindmapCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const created = await mindmapsClient.create(authContext.accessToken, parsed.data);
    await maintainMindmapIndexBestEffort(authContext.accessToken, created);
    await invalidateMindmapIndexFromApi(authContext.userId, mindmapProjectIdsBestEffort(created), objectId(created) ?? "unknown");
    return res.status(201).json(created);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/mindmaps/:documentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const document = await mindmapsClient.get(authContext.accessToken, String(req.params.documentId));
    return res.json(document);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/mindmaps/:documentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = mindmapUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    let before: unknown;
    let projectIds: string[] = [];
    try {
      before = await mindmapsClient.get(authContext.accessToken, String(req.params.documentId));
      projectIds = mindmapProjectIdsBestEffort(before);
    } catch {
      before = undefined;
    }
    const updated = await mindmapsClient.update(authContext.accessToken, String(req.params.documentId), parsed.data);
    if (before) await reconcileMindmapMutationBestEffort(authContext.accessToken, before, updated);
    else await maintainMindmapIndexBestEffort(authContext.accessToken, updated);
    projectIds.push(...mindmapProjectIdsBestEffort(updated));
    await invalidateMindmapIndexFromApi(authContext.userId, projectIds, String(req.params.documentId));
    return res.json(updated);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/mindmaps/:documentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const before = await mindmapsClient.get(authContext.accessToken, String(req.params.documentId));
    const projectIds = mindmapProjectIdsBestEffort(before);
    await mindmapsClient.remove(authContext.accessToken, String(req.params.documentId));
    await cleanupDeletedMindmapBestEffort(authContext.accessToken, before);
    await invalidateProjectContextFromApi(authContext.userId, projectIds, "index", "index", String(req.params.documentId), "delete");
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/mindmaps/projects/:projectId/index/rebuild", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const rebuilt = await rebuildProjectMindmapIndex(authContext.accessToken, String(req.params.projectId));
    await invalidateMindmapIndexFromApi(authContext.userId, [String(req.params.projectId)], String(req.params.projectId));
    return res.json(rebuilt);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/mindmaps/:documentId/export", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = z.object({ format: mindmapExportFormatSchema.default("markdown") }).safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const exported = await mindmapsClient.exportContent(authContext.accessToken, String(req.params.documentId), parsed.data);
    return res.json(exported);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/mindmaps/:documentId/artifact", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = mindmapArtifactSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureMindmapsAccountProvisioned(authContext);
    const result = await saveMindmapExportArtifact(authContext.accessToken, String(req.params.documentId), parsed.data);
    const artifactItemId = objectId(result.artifact);
    if (artifactItemId) {
      const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result.artifact);
      await invalidateArtifactIndexFromApi(authContext.userId, projectIds, artifactItemId);
    }
    return res.status(201).json({ status: "ok", ...result });
  } catch (error) {
    return respondInternalError(res, error);
  }
});
}
