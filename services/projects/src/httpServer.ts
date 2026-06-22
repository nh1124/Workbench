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
import { getProjectBrief, updateProjectBrief } from "./projectBriefStore.js";
import { appendProjectMemory, listProjectMemories, updateProjectMemory } from "./projectMemoryStore.js";
import {
  bulkUpsertProjectIndexEntries,
  searchProjectIndex,
  tombstoneProjectIndexEntry,
  upsertProjectIndexEntry
} from "./projectIndexStore.js";
import { getProjectLink, listProjectLinksByTarget } from "./projectLinksStore.js";
import {
  createProjectRelation,
  deleteProjectRelation,
  getProjectRelation,
  listProjectRelations,
  updateProjectRelation
} from "./projectRelationsStore.js";
import { getProjectContext } from "./projectContextStore.js";
import {
  getProjectContextExportSnapshot,
  getProjectSyncContextSnapshot,
  ProjectContextSnapshotLimitError
} from "./projectContextSnapshotsStore.js";
import {
  DuplicateRelationError,
  InvalidCursorError,
  InvalidRelationError,
  parseCursor,
  VersionConflictError
} from "./projectStoreUtils.js";
import {
  CREATED_BY_KINDS,
  PROJECT_INDEX_ASSOCIATION_KINDS,
  PROJECT_MEMORY_AUTHORITIES,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_RELATION_DIRECTIONS,
  PROJECT_RELATION_ORIGINS,
  PROJECT_RELATION_TYPES,
  PROJECT_STATUSES,
  type ProjectContextSection
} from "./types.js";

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

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const CORE_MUTATION_ORIGIN_HEADER = "x-workbench-core-mutation";
const CORE_MUTATION_TOKEN_HEADER = "x-workbench-core-mutation-token";
const requireCoreMutationOrigin = envFlag("WORKBENCH_REQUIRE_CORE_MUTATION_ORIGIN");
const coreMutationToken = optionalEnv("WORKBENCH_CORE_MUTATION_TOKEN");

function isMutationMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE";
}

function requireCoreMutationOriginMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!requireCoreMutationOrigin || !isMutationMethod(req.method) || req.path.startsWith("/internal/")) {
    next();
    return;
  }

  if (req.header(CORE_MUTATION_ORIGIN_HEADER) !== "1") {
    res.status(403).json({
      code: "CORE_MUTATION_ORIGIN_REQUIRED",
      message: "Mutations must be routed through Workbench Core."
    });
    return;
  }

  if (coreMutationToken && req.header(CORE_MUTATION_TOKEN_HEADER) !== coreMutationToken) {
    res.status(403).json({
      code: "CORE_MUTATION_TOKEN_INVALID",
      message: "Invalid Workbench Core mutation token."
    });
    return;
  }

  next();
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

function validatedCursorQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidCursorError();
  parseCursor(value);
  return value;
}

function respondInvalidCursor(res: express.Response, error: unknown): boolean {
  if (!(error instanceof InvalidCursorError)) return false;
  res.status(400).json({ code: "INVALID_CURSOR", message: error.message });
  return true;
}

export const app = express();
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

const briefUpdateSchema = z.object({
  contentMarkdown: z.string(),
  expectedVersion: z.number().int().nonnegative(),
  updatedByKind: z.enum(["user", "agent"])
});

const memoryInputSchema = z.object({
  kind: z.enum(PROJECT_MEMORY_KINDS),
  bodyMarkdown: z.string().min(1),
  authority: z.enum(PROJECT_MEMORY_AUTHORITIES),
  sourceService: z.string().min(1).optional(),
  sourceResourceType: z.string().min(1).optional(),
  sourceResourceId: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  supersedesId: z.string().min(1).optional(),
  createdByKind: z.enum(CREATED_BY_KINDS)
});

const memoryUpdateSchema = z.object({
  bodyMarkdown: z.string().min(1).optional(),
  status: z.enum(PROJECT_MEMORY_STATUSES).optional(),
  authority: z.enum(PROJECT_MEMORY_AUTHORITIES).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one update is required");

const indexEntryInputSchema = z.object({
  sourceService: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  associationKind: z.enum(PROJECT_INDEX_ASSOCIATION_KINDS),
  associationId: z.string().min(1).optional(),
  path: z.string().optional(),
  title: z.string().min(1),
  summaryText: z.string(),
  summarySource: z.string().min(1).optional(),
  sourceVersion: z.string().optional(),
  contentHash: z.string().optional(),
  sourceUpdatedAt: z.string().datetime(),
  metadataJson: z.record(z.unknown()).optional()
}).superRefine((value, context) => {
  if (value.associationKind === "primary" && value.associationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["associationId"], message: "Primary entries cannot have associationId" });
  }
  if (value.associationKind === "secondary" && !value.associationId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["associationId"], message: "Secondary entries require associationId" });
  }
});

const indexTombstoneSchema = z.object({
  sourceService: z.string().min(1),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1)
});

const relationInputSchema = z.object({
  targetProjectId: z.string().min(1),
  relationType: z.enum(PROJECT_RELATION_TYPES),
  directionality: z.enum(PROJECT_RELATION_DIRECTIONS).optional(),
  note: z.string().optional(),
  origin: z.enum(PROJECT_RELATION_ORIGINS).optional(),
  strength: z.number().min(0).max(1).optional(),
  createdByKind: z.enum(CREATED_BY_KINDS)
});

const relationUpdateSchema = z.object({
  relationType: z.enum(PROJECT_RELATION_TYPES).optional(),
  directionality: z.enum(PROJECT_RELATION_DIRECTIONS).optional(),
  note: z.string().optional(),
  origin: z.enum(PROJECT_RELATION_ORIGINS).optional(),
  strength: z.number().min(0).max(1).nullable().optional(),
  expectedVersion: z.number().int().positive()
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

app.use(requireCoreMutationOriginMiddleware);

app.get("/projects", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  let cursor: string | undefined;
  try {
    cursor = validatedCursorQuery(req.query.cursor);
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }
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
  let cursor: string | undefined;
  try {
    cursor = validatedCursorQuery(req.query.cursor);
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }
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

  let cursor: string | undefined;
  try {
    cursor = validatedCursorQuery(req.query.cursor);
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }

  const projectId = String(req.params.projectId);
  const result = await listProjectLinks(projectId, owner, {
    targetService: typeof req.query.targetService === "string" ? req.query.targetService : undefined,
    targetResourceType: typeof req.query.targetResourceType === "string" ? req.query.targetResourceType : undefined,
    targetResourceId: typeof req.query.targetResourceId === "string" ? req.query.targetResourceId : undefined,
    relationType: typeof req.query.relationType === "string" ? req.query.relationType : undefined,
    cursor,
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

app.get("/project-links", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const targetService = typeof req.query.targetService === "string" ? req.query.targetService.trim() : "";
  const targetResourceType = typeof req.query.targetResourceType === "string" ? req.query.targetResourceType.trim() : "";
  const targetResourceId = typeof req.query.targetResourceId === "string" ? req.query.targetResourceId.trim() : "";
  if (!targetService || !targetResourceType || !targetResourceId) {
    return res.status(400).json({ message: "targetService, targetResourceType and targetResourceId are required" });
  }
  try {
    const cursor = validatedCursorQuery(req.query.cursor);
    const result = await listProjectLinksByTarget({
      targetService,
      targetResourceType,
      targetResourceId,
      relationType: typeof req.query.relationType === "string" ? req.query.relationType : undefined,
      cursor,
      limit: sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined)
    }, owner);
    return res.json(result);
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }
});

app.get("/project-links/:linkId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const link = await getProjectLink(String(req.params.linkId), owner);
  return link ? res.json(link) : res.status(404).json({ message: "Project link not found" });
});

app.get("/projects/:projectId/brief", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const brief = await getProjectBrief(String(req.params.projectId), owner);
  return brief ? res.json(brief) : res.status(404).json({ message: "Project not found" });
});

app.put("/projects/:projectId/brief", requireUserAuth, async (req, res) => {
  const parsed = briefUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  try {
    const brief = await updateProjectBrief(String(req.params.projectId), parsed.data, owner);
    return brief ? res.json(brief) : res.status(404).json({ message: "Project not found" });
  } catch (error) {
    if (error instanceof VersionConflictError) return res.status(409).json({ code: "VERSION_CONFLICT", message: error.message });
    throw error;
  }
});

app.get("/projects/:projectId/memories", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const authority = typeof req.query.authority === "string" ? req.query.authority : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (kind && !PROJECT_MEMORY_KINDS.includes(kind as never)) return res.status(400).json({ message: "Invalid memory kind" });
  if (authority && !PROJECT_MEMORY_AUTHORITIES.includes(authority as never)) return res.status(400).json({ message: "Invalid memory authority" });
  if (status && !PROJECT_MEMORY_STATUSES.includes(status as never)) return res.status(400).json({ message: "Invalid memory status" });
  try {
    const cursor = validatedCursorQuery(req.query.cursor);
    const result = await listProjectMemories(String(req.params.projectId), owner, {
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      kind: kind as (typeof PROJECT_MEMORY_KINDS)[number] | undefined,
      authority: authority as (typeof PROJECT_MEMORY_AUTHORITIES)[number] | undefined,
      status: status as (typeof PROJECT_MEMORY_STATUSES)[number] | undefined,
      cursor,
      limit: sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined)
    });
    return result ? res.json(result) : res.status(404).json({ message: "Project not found" });
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }
});

app.post("/projects/:projectId/memories", requireUserAuth, async (req, res) => {
  const parsed = memoryInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const memory = await appendProjectMemory(String(req.params.projectId), parsed.data, owner);
  return memory ? res.status(201).json(memory) : res.status(404).json({ message: "Project or superseded memory not found" });
});

app.patch("/project-memories/:memoryId", requireUserAuth, async (req, res) => {
  const parsed = memoryUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const memory = await updateProjectMemory(String(req.params.memoryId), parsed.data, owner);
  return memory ? res.json(memory) : res.status(404).json({ message: "Project memory not found" });
});

app.get("/projects/:projectId/index-entries", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const associationKind = typeof req.query.associationKind === "string" ? req.query.associationKind : undefined;
  if (associationKind && !PROJECT_INDEX_ASSOCIATION_KINDS.includes(associationKind as never)) {
    return res.status(400).json({ message: "Invalid associationKind" });
  }
  try {
    const cursor = validatedCursorQuery(req.query.cursor);
    const result = await searchProjectIndex(String(req.params.projectId), owner, {
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      sourceService: typeof req.query.sourceService === "string" ? req.query.sourceService : undefined,
      resourceType: typeof req.query.resourceType === "string" ? req.query.resourceType : undefined,
      associationKind: associationKind as (typeof PROJECT_INDEX_ASSOCIATION_KINDS)[number] | undefined,
      cursor,
      limit: sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined)
    });
    return result ? res.json(result) : res.status(404).json({ message: "Project not found" });
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }
});

app.post("/projects/:projectId/index-entries/upsert", requireUserAuth, async (req, res) => {
  const raw = req.body && typeof req.body === "object" && "entry" in req.body ? req.body.entry : req.body;
  const parsed = indexEntryInputSchema.safeParse(raw);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const entry = await upsertProjectIndexEntry(String(req.params.projectId), parsed.data, owner);
  return entry ? res.json(entry) : res.status(404).json({ message: "Project not found" });
});

app.post("/projects/:projectId/index-entries/tombstone", requireUserAuth, async (req, res) => {
  const parsed = indexTombstoneSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const tombstoned = await tombstoneProjectIndexEntry(String(req.params.projectId), parsed.data, owner);
  return tombstoned === undefined ? res.status(404).json({ message: "Project not found" }) : res.json({ tombstoned });
});

app.post("/projects/:projectId/index-entries/bulk-upsert", requireUserAuth, async (req, res) => {
  const parsed = z.object({ entries: z.array(indexEntryInputSchema).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const items = await bulkUpsertProjectIndexEntries(String(req.params.projectId), parsed.data.entries, owner);
  return items ? res.json({ items }) : res.status(404).json({ message: "Project not found" });
});

app.get("/projects/:projectId/relations", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const relationType = typeof req.query.relationType === "string" ? req.query.relationType : undefined;
  const directionality = typeof req.query.directionality === "string" ? req.query.directionality : undefined;
  if (relationType && !PROJECT_RELATION_TYPES.includes(relationType as never)) return res.status(400).json({ message: "Invalid relationType" });
  if (directionality && !PROJECT_RELATION_DIRECTIONS.includes(directionality as never)) return res.status(400).json({ message: "Invalid directionality" });
  try {
    const cursor = validatedCursorQuery(req.query.cursor);
    const result = await listProjectRelations(String(req.params.projectId), owner, {
      relationType: relationType as (typeof PROJECT_RELATION_TYPES)[number] | undefined,
      directionality: directionality as (typeof PROJECT_RELATION_DIRECTIONS)[number] | undefined,
      cursor,
      limit: sanitizeLimit(typeof req.query.limit === "string" ? req.query.limit : undefined)
    });
    return result ? res.json(result) : res.status(404).json({ message: "Project not found" });
  } catch (error) {
    if (respondInvalidCursor(res, error)) return;
    throw error;
  }
});

app.post("/projects/:projectId/relations", requireUserAuth, async (req, res) => {
  const parsed = relationInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  try {
    const relation = await createProjectRelation(String(req.params.projectId), parsed.data, owner);
    return relation ? res.status(201).json(relation) : res.status(404).json({ message: "Source or target project not found" });
  } catch (error) {
    if (error instanceof InvalidRelationError) return res.status(400).json({ code: "INVALID_RELATION", message: error.message });
    if (error instanceof DuplicateRelationError) return res.status(409).json({ code: "DUPLICATE_RELATION", message: error.message });
    throw error;
  }
});

app.get("/project-relations/:relationId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const relation = await getProjectRelation(String(req.params.relationId), owner);
  return relation ? res.json(relation) : res.status(404).json({ message: "Project relation not found" });
});

app.patch("/project-relations/:relationId", requireUserAuth, async (req, res) => {
  const parsed = relationUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.flatten() });
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  try {
    const relation = await updateProjectRelation(String(req.params.relationId), parsed.data, owner);
    return relation ? res.json(relation) : res.status(404).json({ message: "Project relation not found" });
  } catch (error) {
    if (error instanceof VersionConflictError) return res.status(409).json({ code: "VERSION_CONFLICT", message: error.message });
    if (error instanceof DuplicateRelationError) return res.status(409).json({ code: "DUPLICATE_RELATION", message: error.message });
    throw error;
  }
});

app.delete("/project-relations/:relationId", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const deleted = await deleteProjectRelation(String(req.params.relationId), owner);
  return deleted ? res.status(204).send() : res.status(404).json({ message: "Project relation not found" });
});

app.get("/projects/:projectId/context", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  const allowed: ProjectContextSection[] = ["brief", "summary", "memory", "index", "relations", "links"];
  const include = typeof req.query.include === "string" ? req.query.include.split(",").map((value) => value.trim()).filter(Boolean) : undefined;
  if (include?.some((section) => !allowed.includes(section as ProjectContextSection))) {
    return res.status(400).json({ message: "Invalid context section" });
  }
  const context = await getProjectContext(String(req.params.projectId), owner, {
    query: typeof req.query.q === "string" ? req.query.q : undefined,
    include: include as ProjectContextSection[] | undefined,
    memoryLimit: sanitizeLimit(typeof req.query.memoryLimit === "string" ? req.query.memoryLimit : undefined),
    indexLimit: sanitizeLimit(typeof req.query.indexLimit === "string" ? req.query.indexLimit : undefined),
    relationLimit: sanitizeLimit(typeof req.query.relationLimit === "string" ? req.query.relationLimit : undefined),
    linkLimit: sanitizeLimit(typeof req.query.linkLimit === "string" ? req.query.linkLimit : undefined),
    maxChars: sanitizeLimit(typeof req.query.maxChars === "string" ? req.query.maxChars : undefined)
  });
  return context ? res.json(context) : res.status(404).json({ message: "Project not found" });
});

app.get("/projects/:projectId/sync-context", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  try {
    const snapshot = await getProjectSyncContextSnapshot(String(req.params.projectId), owner);
    return snapshot ? res.json(snapshot) : res.status(404).json({ message: "Project not found" });
  } catch (error) {
    if (error instanceof ProjectContextSnapshotLimitError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    throw error;
  }
});

app.get("/projects/:projectId/context-export", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) return res.status(401).json({ message: "Missing auth context" });
  try {
    const snapshot = await getProjectContextExportSnapshot(String(req.params.projectId), owner);
    return snapshot ? res.json(snapshot) : res.status(404).json({ message: "Project not found" });
  } catch (error) {
    if (error instanceof ProjectContextSnapshotLimitError) {
      return res.status(error.status).json({ code: error.code, message: error.message });
    }
    throw error;
  }
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

const isDirectExecution = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
if (isDirectExecution) {
  void ensureProjectsSchema().then(() => {
    app.listen(port, host, () => {
      console.log(`Projects service HTTP listening on ${host}:${port}`);
    });
  });
}
