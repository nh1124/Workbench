import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureProjectsSchema, upsertServiceAccount } from "./db.js";
import {
  createProject,
  deleteProject,
  getDefaultProject,
  getProject,
  getProjectContextSummary,
  linkResourceToProject,
  listProjectLinks,
  listProjects,
  refreshProjectContextSummary,
  setDefaultProject,
  searchProjects,
  unlinkResourceFromProject,
  updateProject
} from "./store.js";
import { PROJECT_STATUSES } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sanitizeLimit(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const projectInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  ownerAccountId: z.string().optional()
});

const projectLinkInputSchema = z.object({
  targetService: z.string().min(1),
  targetResourceType: z.string().min(1),
  targetResourceId: z.string().min(1),
  relationType: z.string().min(1).optional(),
  titleSnapshot: z.string().optional(),
  summarySnapshot: z.string().optional(),
  metadataJson: z.record(z.unknown()).optional()
});

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1),
});

const summaryRefreshSchema = z.object({
  source: z.string().min(1).optional()
});

const setDefaultProjectSchema = z.object({
  projectId: z.string().min(1)
});

app.get("/health", (_req, res) => {
  res.json({
    service: "projects",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/accounts", requireInternalApiKey, async (req, res) => {
  const parsed = internalAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  await upsertServiceAccount(parsed.data.coreUserId, parsed.data.username);
  await getDefaultProject(parsed.data.coreUserId);
  return res.status(201).json({ status: "ok", service: "projects" });
});

app.get("/internal/default-project", requireInternalApiKey, async (req, res) => {
  const coreUserId = typeof req.query.coreUserId === "string" ? req.query.coreUserId.trim() : "";
  if (!coreUserId) {
    return res.status(400).json({ message: "coreUserId is required" });
  }

  const selection = await getDefaultProject(coreUserId);
  return res.json(selection);
});

app.get("/projects", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const result = await listProjects(
    {
      status: PROJECT_STATUSES.includes(status as (typeof PROJECT_STATUSES)[number])
        ? (status as (typeof PROJECT_STATUSES)[number])
        : undefined,
      query,
      cursor,
      limit
    },
    owner
  );

  return res.json(result);
});

app.get("/projects/search", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  if (!query) {
    return res.status(400).json({ message: "query is required" });
  }

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined);
  const result = await searchProjects(query, owner, {
    status: PROJECT_STATUSES.includes(status as (typeof PROJECT_STATUSES)[number])
      ? (status as (typeof PROJECT_STATUSES)[number])
      : undefined,
    cursor,
    limit
  });
  return res.json(result);
});

app.get("/projects/default", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const selection = await getDefaultProject(owner);
  return res.json(selection);
});

app.get("/projects/:projectId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const project = await getProject(String(req.params.projectId), owner);
  if (!project) {
    return res.status(404).json({ message: "Project not found" });
  }

  return res.json(project);
});

app.post("/projects", requireUserAuth, async (req, res) => {
  const parsed = projectInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  if (parsed.data.ownerAccountId && parsed.data.ownerAccountId !== owner) {
    return res.status(400).json({ message: "ownerAccountId must match authenticated user" });
  }

  const created = await createProject(parsed.data, owner);
  return res.status(201).json(created);
});

app.patch("/projects/:projectId", requireUserAuth, async (req, res) => {
  const parsed = projectInputSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  if (parsed.data.ownerAccountId && parsed.data.ownerAccountId !== owner) {
    return res.status(400).json({ message: "ownerAccountId is immutable" });
  }

  let updated;
  try {
    updated = await updateProject(String(req.params.projectId), parsed.data, owner);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return res.status(400).json({ message });
  }
  if (!updated) {
    return res.status(404).json({ message: "Project not found" });
  }

  return res.json(updated);
});

app.delete("/projects/:projectId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  try {
    const deleted = await deleteProject(String(req.params.projectId), owner);
    if (!deleted) {
      return res.status(404).json({ message: "Project not found" });
    }
    return res.status(204).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed";
    return res.status(400).json({ message });
  }
});

app.put("/projects/default", requireUserAuth, async (req, res) => {
  const parsed = setDefaultProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const updated = await setDefaultProject(owner, parsed.data.projectId);
  if (!updated) {
    return res.status(404).json({ message: "Project not found" });
  }

  return res.json(updated);
});

app.get("/projects/:projectId/links", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const projectId = String(req.params.projectId);
  const result = await listProjectLinks(projectId, owner, {
    targetService: typeof req.query.targetService === "string" ? req.query.targetService : undefined,
    targetResourceType: typeof req.query.targetResourceType === "string" ? req.query.targetResourceType : undefined,
    cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
    limit: sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined)
  });

  if (!result) {
    return res.status(404).json({ message: "Project not found" });
  }

  return res.json(result);
});

app.post("/projects/:projectId/links", requireUserAuth, async (req, res) => {
  const parsed = projectLinkInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const linked = await linkResourceToProject(String(req.params.projectId), parsed.data, owner);
  if (!linked) {
    return res.status(404).json({ message: "Project not found" });
  }

  return res.status(201).json(linked);
});

app.delete("/project-links/:linkId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const deleted = await unlinkResourceFromProject(String(req.params.linkId), owner);
  if (!deleted) {
    return res.status(404).json({ message: "Project link not found" });
  }

  return res.status(204).send();
});

app.get("/projects/:projectId/context-summary", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const summary = await getProjectContextSummary(String(req.params.projectId), owner);
  if (!summary) {
    return res.status(404).json({ message: "Project context summary not found" });
  }

  return res.json(summary);
});

const refreshProjectSummaryHandler: express.RequestHandler = async (req, res) => {
  const parsed = summaryRefreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const summary = await refreshProjectContextSummary(
    String(req.params.projectId),
    owner,
    parsed.data.source ?? "rule-based"
  );

  if (!summary) {
    return res.status(404).json({ message: "Project not found" });
  }

  return res.json(summary);
};

app.post("/projects/:projectId/context-summary/refresh", requireUserAuth, refreshProjectSummaryHandler);
app.post("/projects/:projectId/context-summary\\:refresh", requireUserAuth, refreshProjectSummaryHandler);

const port = Number(requireEnv("PROJECTS_SERVICE_PORT"));
const host = requireEnv("PROJECTS_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid PROJECTS_SERVICE_PORT value: ${process.env.PROJECTS_SERVICE_PORT}`);
}

void ensureProjectsSchema().then(() => {
  app.listen(port, host, () => {
    console.log(`Projects service HTTP listening on ${host}:${port}`);
  });
});
