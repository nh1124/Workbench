import express from "express";
import { DeepResearchError } from "../deepResearch/errors.js";
import {
  cancelDeepResearch,
  getDeepResearchDefaults,
  getDeepResearchStatus,
  listDeepResearchHistory,
  runDeepResearch,
  saveDeepResearchJobArtifact
} from "../deepResearch/service.js";
import { requireAuthenticatedContext } from "../middleware/auth.js";
import {
  deepResearchManualSaveSchema,
  deepResearchRequestSchema
} from "../schemas/requests.js";

function respondDeepResearchError(res: express.Response, error: unknown): express.Response {
  if (error instanceof DeepResearchError) {
    return res.status(error.status).json({
      message: error.message,
      code: error.code
    });
  }

  const message = error instanceof Error ? error.message : "Deep Research request failed";
  return res.status(500).json({
    message,
    code: "DEEP_RESEARCH_INTERNAL_ERROR"
  });
}

export function registerDeepResearchRoutes(app: express.Express): void {
app.get("/api/deep-research/defaults", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const defaults = await getDeepResearchDefaults(authContext.userId);
    return res.json(defaults);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.post("/api/deep-research", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = deepResearchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const result = await runDeepResearch(authContext.userId, authContext.accessToken, parsed.data);
    return res.json(result);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.get("/api/deep-research/jobs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const result = await listDeepResearchHistory(authContext.userId, Number.isFinite(limit) ? limit : undefined);
    return res.json({ items: result });
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.get("/api/deep-research/jobs/:jobId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await getDeepResearchStatus(authContext.userId, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.post("/api/deep-research/jobs/:jobId/cancel", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await cancelDeepResearch(authContext.userId, String(req.params.jobId));
    return res.json(result);
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});

app.post("/api/deep-research/jobs/:jobId/save", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = deepResearchManualSaveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const artifact = await saveDeepResearchJobArtifact(
      authContext.userId,
      authContext.accessToken,
      String(req.params.jobId),
      parsed.data
    );
    return res.json({ status: "ok", artifact });
  } catch (error) {
    return respondDeepResearchError(res, error);
  }
});
}
