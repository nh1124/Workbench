import cors from "cors";
import { createLogger, installProcessHandlers, requestLogger } from "@workbench/logging";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureMindmapsSchema, upsertServiceAccount } from "./db.js";
import {
  createMindmap,
  deleteMindmap,
  exportMindmap,
  getMindmap,
  listMindmaps,
  MindmapServiceError,
  recordMindmapArtifactExport,
  updateMindmap
} from "./store.js";
import type { MindmapDocumentBody, MindmapMode, MindmapNode } from "./types.js";

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

const logger = createLogger("mindmaps");
installProcessHandlers(logger);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestLogger(logger));

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1)
});

const mindmapModeSchema = z.enum(["mindmap", "logical_tree"]);
const exportFormatSchema = z.enum(["json", "markdown", "svg"]);

const nodeSchema: z.ZodType<MindmapNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    note: z.string().optional(),
    markers: z.array(z.string()).optional(),
    collapsed: z.boolean().optional(),
    children: z.array(nodeSchema).optional()
  })
);

const bodySchema: z.ZodType<MindmapDocumentBody> = z.object({
  root: nodeSchema,
  layout: z.object({
    direction: z.enum(["right", "left", "radial", "down"]).optional()
  }).optional(),
  theme: z.object({
    accentColor: z.string().optional()
  }).optional(),
  metadata: z.record(z.unknown()).optional()
});

const createMindmapSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  mode: mindmapModeSchema.optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  body: bodySchema.optional(),
  tags: z.array(z.string()).optional(),
  template: z.enum(["blank", "mindmap", "logical_tree"]).optional()
});

const updateMindmapSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  mode: mindmapModeSchema.optional(),
  projectId: z.string().nullable().optional(),
  projectName: z.string().nullable().optional(),
  body: bodySchema.optional(),
  tags: z.array(z.string()).optional(),
  expectedVersion: z.number().int().positive().optional()
});

const artifactExportSchema = z.object({
  sourceVersion: z.number().int().positive(),
  artifactItemId: z.string().min(1),
  artifactItemPath: z.string().optional(),
  artifactTitle: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  exportFormat: exportFormatSchema
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

function respondMindmapError(res: express.Response, error: unknown): express.Response {
  if (error instanceof MindmapServiceError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : "Mindmap request failed";
  return res.status(500).json({ message, code: "MINDMAP_INTERNAL_ERROR" });
}

app.get("/health", (_req, res) => {
  res.json({
    service: "mindmaps",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/internal/accounts", requireInternalApiKey, asyncRoute(async (req, res) => {
  const parsed = internalAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  await upsertServiceAccount(parsed.data.coreUserId, parsed.data.username);
  return res.status(201).json({ status: "ok", service: "mindmaps" });
}));

app.get("/mindmaps", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const mode = typeof req.query.mode === "string" && ["mindmap", "logical_tree"].includes(req.query.mode)
    ? (req.query.mode as MindmapMode)
    : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const result = await listMindmaps(owner, {
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      mode,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.post("/mindmaps", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = createMindmapSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const created = await createMindmap(owner, parsed.data);
    return res.status(201).json(created);
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.get("/mindmaps/:documentId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    const document = await getMindmap(owner, String(req.params.documentId));
    return res.json(document);
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.patch("/mindmaps/:documentId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = updateMindmapSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const updated = await updateMindmap(owner, String(req.params.documentId), parsed.data);
    return res.json(updated);
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.delete("/mindmaps/:documentId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  try {
    await deleteMindmap(owner, String(req.params.documentId));
    return res.status(204).send();
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.post("/mindmaps/:documentId/export", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = z.object({ format: exportFormatSchema.default("markdown") }).safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const exported = await exportMindmap(owner, String(req.params.documentId), parsed.data.format);
    return res.json(exported);
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.post("/mindmaps/:documentId/artifact-exports", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;

  const parsed = artifactExportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const recorded = await recordMindmapArtifactExport(owner, String(req.params.documentId), parsed.data);
    return res.status(201).json(recorded);
  } catch (error) {
    return respondMindmapError(res, error);
  }
}));

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  respondMindmapError(res, error);
});

const port = Number(requireEnv("MINDMAPS_SERVICE_PORT"));
const host = requireEnv("MINDMAPS_SERVICE_HOST");

void ensureMindmapsSchema().then(() => {
  app.listen(port, host, () => {
    logger.info(`[mindmaps] HTTP service listening on http://${host}:${port}`);
  });
});
