import cors from "cors";
import { createLogger, installProcessHandlers, requestLogger } from "@workbench/logging";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureWbsSchema, upsertServiceAccount } from "./db.js";
import {
  createDependency,
  createItem,
  createPlan,
  deleteDependency,
  deleteItem,
  deletePlan,
  exportPlan,
  getItem,
  getPlan,
  listArtifactExports,
  listDependencies,
  listItems,
  listPlans,
  moveItem,
  recordArtifactExport,
  updateItem,
  updatePlan,
  WbsServiceError
} from "./store.js";
import type { WbsDependencyType, WbsExportFormat, WbsItemStatus } from "./types.js";

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

const logger = createLogger("wbs");
installProcessHandlers(logger);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestLogger(logger));

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1)
});

const statusSchema = z.enum(["todo", "doing", "blocked", "done"]);
const dependencyTypeSchema = z.enum(["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"]);
const exportFormatSchema = z.enum(["json", "markdown", "csv"]);

const createPlanSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  settings: z.record(z.unknown()).optional()
});

const updatePlanSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().optional(),
  projectId: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  settings: z.record(z.unknown()).optional()
});

const createItemSchema = z.object({
  parentId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  ownerLabel: z.string().optional(),
  startDate: z.string().optional(),
  dueDate: z.string().optional(),
  effortHours: z.number().nonnegative().optional(),
  status: statusSchema.optional(),
  progress: z.number().int().min(0).max(100).optional()
});

const updateItemSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().optional(),
  ownerLabel: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  effortHours: z.number().nonnegative().nullable().optional(),
  status: statusSchema.optional(),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  linkedTaskId: z.string().nullable().optional()
});

const moveItemSchema = z.object({
  expectedVersion: z.number().int().positive(),
  parentId: z.string().nullable().optional(),
  beforeItemId: z.string().optional(),
  afterItemId: z.string().optional()
});

const createDependencySchema = z.object({
  fromItemId: z.string().min(1),
  toItemId: z.string().min(1),
  dependencyType: dependencyTypeSchema.optional(),
  lagDays: z.number().int().default(0)
});

const exportRequestSchema = z.object({
  format: exportFormatSchema.default("markdown")
});

const artifactExportSchema = z.object({
  sourceVersion: z.number().int().positive(),
  artifactItemId: z.string().min(1),
  artifactPath: z.string().optional(),
  format: exportFormatSchema
});

type AsyncRouteHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<unknown>;

function asyncRoute(handler: AsyncRouteHandler): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function ownerFromRequest(req: express.Request, res: express.Response): string | undefined {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    res.status(401).json({ message: "Missing auth context" });
    return undefined;
  }
  return owner;
}

function respondWbsError(res: express.Response, error: unknown): express.Response {
  if (error instanceof WbsServiceError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : "WBS request failed";
  return res.status(500).json({ message, code: "WBS_INTERNAL_ERROR" });
}

function optionalExpectedVersion(req: express.Request, res: express.Response): number | undefined {
  const bodyValue = req.body && typeof req.body === "object" ? (req.body as { expectedVersion?: unknown }).expectedVersion : undefined;
  const queryValue = req.query.expectedVersion;
  const raw = bodyValue ?? (typeof queryValue === "string" ? queryValue : undefined);
  if (raw === undefined) return undefined;

  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    res.status(400).json({ message: "expectedVersion must be a positive integer", code: "INVALID_INPUT" });
    return undefined;
  }
  return parsed;
}

function queryLimit(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

app.get("/health", (_req, res) => {
  res.json({
    service: "wbs",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/accounts", requireInternalApiKey, asyncRoute(async (req, res) => {
  const parsed = internalAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  await upsertServiceAccount(parsed.data.coreUserId, parsed.data.username);
  return res.status(201).json({ status: "ok", service: "wbs" });
}));

app.get("/wbs/plans", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    const result = await listPlans(owner, {
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      limit: queryLimit(req.query.limit),
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.post("/wbs/plans", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = createPlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const created = await createPlan(owner, parsed.data);
    return res.status(201).json(created);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.get("/wbs/plans/:planId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    return res.json(await getPlan(owner, String(req.params.planId)));
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.patch("/wbs/plans/:planId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = updatePlanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const updated = await updatePlan(owner, String(req.params.planId), parsed.data);
    return res.json(updated);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.delete("/wbs/plans/:planId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const expectedVersion = optionalExpectedVersion(req, res);
  if (res.headersSent) return;

  try {
    await deletePlan(owner, String(req.params.planId), expectedVersion);
    return res.status(204).send();
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.get("/wbs/plans/:planId/items", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    return res.json({ items: await listItems(owner, String(req.params.planId)) });
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.get("/wbs/items/:itemId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    return res.json(await getItem(owner, String(req.params.itemId)));
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.post("/wbs/plans/:planId/items", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = createItemSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const created = await createItem(owner, String(req.params.planId), {
      ...parsed.data,
      status: parsed.data.status as WbsItemStatus | undefined
    });
    return res.status(201).json(created);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.patch("/wbs/items/:itemId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = updateItemSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const updated = await updateItem(owner, String(req.params.itemId), {
      ...parsed.data,
      status: parsed.data.status as WbsItemStatus | undefined
    });
    return res.json(updated);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.delete("/wbs/items/:itemId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const expectedVersion = optionalExpectedVersion(req, res);
  if (res.headersSent) return;

  try {
    await deleteItem(owner, String(req.params.itemId), expectedVersion);
    return res.status(204).send();
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.post("/wbs/items/:itemId/move", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = moveItemSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const moved = await moveItem(owner, String(req.params.itemId), parsed.data);
    return res.json(moved);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.get("/wbs/plans/:planId/dependencies", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    return res.json({ items: await listDependencies(owner, String(req.params.planId)) });
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.post("/wbs/plans/:planId/dependencies", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = createDependencySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const created = await createDependency(owner, String(req.params.planId), {
      ...parsed.data,
      dependencyType: parsed.data.dependencyType as WbsDependencyType | undefined
    });
    return res.status(201).json(created);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.delete("/wbs/dependencies/:dependencyId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    await deleteDependency(owner, String(req.params.dependencyId));
    return res.status(204).send();
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

async function handleExport(req: express.Request, res: express.Response): Promise<unknown> {
  const owner = ownerFromRequest(req, res);
  if (!owner) return undefined;

  const parsed = exportRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    return res.json(await exportPlan(owner, String(req.params.planId), parsed.data.format as WbsExportFormat));
  } catch (error) {
    return respondWbsError(res, error);
  }
}

app.post("/wbs/plans/:planId/export", requireUserAuth, asyncRoute(handleExport));
app.post("/wbs/plans/:planId/export-content", requireUserAuth, asyncRoute(handleExport));

app.get("/wbs/plans/:planId/artifact-exports", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    return res.json({ items: await listArtifactExports(owner, String(req.params.planId)) });
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.post("/wbs/plans/:planId/artifact-exports", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = artifactExportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const recorded = await recordArtifactExport(owner, String(req.params.planId), {
      ...parsed.data,
      format: parsed.data.format as WbsExportFormat
    });
    return res.status(201).json(recorded);
  } catch (error) {
    return respondWbsError(res, error);
  }
}));

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  respondWbsError(res, error);
});

const port = Number(requireEnv("WBS_SERVICE_PORT"));
const host = requireEnv("WBS_SERVICE_HOST");

void ensureWbsSchema().then(() => {
  app.listen(port, host, () => {
    logger.info(`[wbs] HTTP service listening on http://${host}:${port}`);
  });
});
