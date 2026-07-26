import express from "express";
import { notesClient } from "../internalClients.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import {
  objectId,
  recordSyncEventBestEffort,
  respondInternalError
} from "./shared.js";

export function registerNoteRoutes(app: express.Express): void {
app.get("/api/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await notesClient.list(authContext.accessToken, projectId, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/notes/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/notes/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.create(authContext.accessToken, req.body);
    await recordSyncEventBestEffort(authContext.userId, "notes", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/notes/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await notesClient.update(authContext.accessToken, String(req.params.id), req.body);
    await recordSyncEventBestEffort(authContext.userId, "notes", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/notes/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await notesClient.remove(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "notes", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});
}
