import express from "express";
import { z } from "zod";
import { wbsClient } from "../internalClients.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import {
  cleanupDeletedWbsBestEffort,
  listArtifactProjectIdsBestEffort,
  maintainWbsIndexBestEffort,
  rebuildProjectWbsIndex,
  reconcileWbsMutationBestEffort,
  saveWbsExportArtifact,
  wbsProjectIdsBestEffort
} from "../projectContext.js";
import {
  wbsArtifactSaveSchema,
  wbsDependencyCreateSchema,
  wbsExportFormatSchema,
  wbsItemCreateSchema,
  wbsItemMoveSchema,
  wbsItemUpdateSchema,
  wbsPlanCreateSchema,
  wbsPlanUpdateSchema
} from "../schemas/wbs.js";
import { ensureWbsAccountProvisioned } from "../serviceProvisioning.js";
import {
  asJsonRecord,
  invalidateArtifactIndexFromApi,
  invalidateProjectContextFromApi,
  objectId,
  respondInternalError
} from "./shared.js";

async function invalidateWbsIndexFromApi(
  userId: string,
  projectIds: Array<string | undefined>,
  planId: string
): Promise<void> {
  await invalidateProjectContextFromApi(userId, projectIds, "index", "index", planId);
}

function responseItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = asJsonRecord(value).items;
  return Array.isArray(items) ? items : [];
}

function wbsPlanIdFromItem(value: unknown): string | undefined {
  const planId = asJsonRecord(value).planId;
  return typeof planId === "string" && planId.trim() ? planId.trim() : undefined;
}

export function registerWbsRoutes(app: express.Express): void {
app.get("/api/wbs/plans", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    await ensureWbsAccountProvisioned(authContext);
    const result = await wbsClient.listPlans(authContext.accessToken, {
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/plans", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsPlanCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    const created = await wbsClient.createPlan(authContext.accessToken, parsed.data);
    await maintainWbsIndexBestEffort(authContext.accessToken, created);
    await invalidateWbsIndexFromApi(authContext.userId, wbsProjectIdsBestEffort(created), objectId(created) ?? "unknown");
    return res.status(201).json(created);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/wbs/plans/:planId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    const plan = await wbsClient.getPlan(authContext.accessToken, String(req.params.planId));
    return res.json(plan);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/wbs/plans/:planId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsPlanUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    let before: unknown;
    let projectIds: string[] = [];
    try {
      before = await wbsClient.getPlan(authContext.accessToken, String(req.params.planId));
      projectIds = wbsProjectIdsBestEffort(before);
    } catch {
      before = undefined;
    }
    const updated = await wbsClient.updatePlan(authContext.accessToken, String(req.params.planId), parsed.data);
    if (before) await reconcileWbsMutationBestEffort(authContext.accessToken, before, updated);
    else await maintainWbsIndexBestEffort(authContext.accessToken, updated);
    projectIds.push(...wbsProjectIdsBestEffort(updated));
    await invalidateWbsIndexFromApi(authContext.userId, projectIds, String(req.params.planId));
    return res.json(updated);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/wbs/plans/:planId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    const before = await wbsClient.getPlan(authContext.accessToken, String(req.params.planId));
    const projectIds = wbsProjectIdsBestEffort(before);
    await wbsClient.removePlan(authContext.accessToken, String(req.params.planId));
    await cleanupDeletedWbsBestEffort(authContext.accessToken, before);
    await invalidateProjectContextFromApi(authContext.userId, projectIds, "index", "index", String(req.params.planId), "delete");
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/projects/:projectId/index/rebuild", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    const rebuilt = await rebuildProjectWbsIndex(authContext.accessToken, String(req.params.projectId));
    await invalidateWbsIndexFromApi(authContext.userId, [String(req.params.projectId)], String(req.params.projectId));
    return res.json(rebuilt);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/wbs/plans/:planId/items", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    const items = await wbsClient.listItems(authContext.accessToken, String(req.params.planId));
    return res.json(responseItems(items));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/plans/:planId/items", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsItemCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    await wbsClient.createItem(authContext.accessToken, String(req.params.planId), parsed.data);
    const plan = await wbsClient.getPlan(authContext.accessToken, String(req.params.planId));
    const items = await wbsClient.listItems(authContext.accessToken, String(req.params.planId));
    await maintainWbsIndexBestEffort(authContext.accessToken, plan);
    await invalidateWbsIndexFromApi(authContext.userId, wbsProjectIdsBestEffort(plan), String(req.params.planId));
    return res.status(201).json(responseItems(items));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/wbs/items/:itemId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsItemUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    const updated = await wbsClient.updateItem(authContext.accessToken, String(req.params.itemId), parsed.data);
    const planId = wbsPlanIdFromItem(updated);
    if (!planId) {
      return res.status(502).json({ message: "WBS service returned an item without planId", code: "INVALID_WBS_RESPONSE" });
    }
    const plan = await wbsClient.getPlan(authContext.accessToken, planId);
    const items = await wbsClient.listItems(authContext.accessToken, planId);
    await maintainWbsIndexBestEffort(authContext.accessToken, plan);
    await invalidateWbsIndexFromApi(authContext.userId, wbsProjectIdsBestEffort(plan), planId);
    return res.json(responseItems(items));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/wbs/items/:itemId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    const beforeItem = await wbsClient.getItem(authContext.accessToken, String(req.params.itemId));
    const planId = wbsPlanIdFromItem(beforeItem);
    if (!planId) {
      return res.status(502).json({ message: "WBS service returned an item without planId", code: "INVALID_WBS_RESPONSE" });
    }
    await wbsClient.removeItem(authContext.accessToken, String(req.params.itemId));
    const plan = await wbsClient.getPlan(authContext.accessToken, planId);
    const items = await wbsClient.listItems(authContext.accessToken, planId);
    await maintainWbsIndexBestEffort(authContext.accessToken, plan);
    await invalidateWbsIndexFromApi(authContext.userId, wbsProjectIdsBestEffort(plan), planId);
    return res.json(responseItems(items));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/items/:itemId/move", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsItemMoveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    const moved = await wbsClient.moveItem(authContext.accessToken, String(req.params.itemId), parsed.data);
    const planId = wbsPlanIdFromItem(moved);
    if (!planId) {
      return res.status(502).json({ message: "WBS service returned an item without planId", code: "INVALID_WBS_RESPONSE" });
    }
    const plan = await wbsClient.getPlan(authContext.accessToken, planId);
    const items = await wbsClient.listItems(authContext.accessToken, planId);
    await maintainWbsIndexBestEffort(authContext.accessToken, plan);
    await invalidateWbsIndexFromApi(authContext.userId, wbsProjectIdsBestEffort(plan), planId);
    return res.json(responseItems(items));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/wbs/plans/:planId/dependencies", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    const dependencies = await wbsClient.listDependencies(authContext.accessToken, String(req.params.planId));
    return res.json(responseItems(dependencies));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/plans/:planId/dependencies", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsDependencyCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    const dependency = await wbsClient.createDependency(authContext.accessToken, String(req.params.planId), parsed.data);
    return res.status(201).json(dependency);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/wbs/dependencies/:dependencyId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await ensureWbsAccountProvisioned(authContext);
    await wbsClient.removeDependency(authContext.accessToken, String(req.params.dependencyId));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/plans/:planId/export", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = z.object({ format: wbsExportFormatSchema.default("markdown") }).safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    const exported = await wbsClient.exportContent(authContext.accessToken, String(req.params.planId), parsed.data);
    return res.json(exported);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/wbs/plans/:planId/artifact", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = wbsArtifactSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    await ensureWbsAccountProvisioned(authContext);
    const result = await saveWbsExportArtifact(authContext.accessToken, String(req.params.planId), parsed.data);
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
