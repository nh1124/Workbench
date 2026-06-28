import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureImagesSchema, upsertServiceAccount } from "./db.js";
import {
  attachArtifactToAsset,
  cancelImageJob,
  createImageReference,
  deleteImageAsset,
  deleteImageJob,
  getImageAsset,
  getImageJob,
  imageDefaults,
  ImageServiceError,
  listImageJobs,
  readImageAssetData,
  retryImageJob,
  runImageGeneration
} from "./store.js";
import { ImageProviderError } from "./providers/types.js";

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

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1)
});

const providerSchema = z.enum(["auto", "mock", "openai", "nanobanana"]);
const intentSchema = z.enum(["create", "refine", "edit", "context_update"]);
const sizeSchema = z.enum(["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024", "auto"]);
const qualitySchema = z.enum(["draft", "standard", "high"]);
const preserveSchema = z.enum(["composition", "subject", "style", "colors", "text", "layout"]);
const contextRefSchema = z.object({
  kind: z.enum(["project", "artifact", "note", "task", "research", "freeform"]),
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional()
});

const generationSchema = z.object({
  intent: intentSchema.optional(),
  prompt: z.string().min(1),
  instruction: z.string().optional(),
  negativePrompt: z.string().optional(),
  provider: providerSchema.optional(),
  model: z.string().optional(),
  size: sizeSchema.optional(),
  count: z.number().int().min(1).max(8).optional(),
  quality: qualitySchema.optional(),
  stylePreset: z.string().optional(),
  seed: z.number().int().optional(),
  referenceImageIds: z.array(z.string()).optional(),
  sourceAssetIds: z.array(z.string()).optional(),
  sourceArtifactItemIds: z.array(z.string()).optional(),
  contextRefs: z.array(contextRefSchema).optional(),
  contextSnapshot: z.object({
    refs: z.array(contextRefSchema).default([]),
    summary: z.string().optional()
  }).optional(),
  preserve: z.array(preserveSchema).optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  providerCredentials: z.object({
    openaiApiKey: z.string().optional(),
    nanobananaApiKey: z.string().optional(),
    defaultProvider: providerSchema.optional(),
    defaultOpenAIModel: z.string().optional(),
    defaultNanobananaModel: z.string().optional()
  }).optional()
});

const retrySchema = generationSchema.partial();

const referencePurposeSchema = z.enum(["reference", "source", "mask"]);

const artifactAttachSchema = z.object({
  artifactItemId: z.string().min(1),
  artifactItemPath: z.string().optional(),
  artifactTitle: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

function ownerFromRequest(req: express.Request, res: express.Response): string | undefined {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    res.status(401).json({ message: "Missing auth context" });
    return undefined;
  }
  return owner;
}

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

function respondImageError(res: express.Response, error: unknown): express.Response {
  if (error instanceof ImageProviderError || error instanceof ImageServiceError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : "Image request failed";
  return res.status(500).json({ message, code: "IMAGE_INTERNAL_ERROR" });
}

app.get("/health", (_req, res) => {
  res.json({
    service: "images",
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
  return res.status(201).json({ status: "ok", service: "images" });
}));

app.get("/images/defaults", requireUserAuth, asyncRoute(async (_req, res) => {
  const defaults = await imageDefaults();
  return res.json(defaults);
}));

app.post("/images/references", requireUserAuth, upload.single("file"), asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  if (!req.file) {
    return res.status(400).json({ message: "File is required" });
  }

  const parsedPurpose = referencePurposeSchema.safeParse(req.body.purpose ?? "reference");
  if (!parsedPurpose.success) {
    return res.status(400).json({ message: parsedPurpose.error.flatten() });
  }

  try {
    const created = await createImageReference({
      ownerCoreUserId: owner,
      purpose: parsedPurpose.data,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      projectId: typeof req.body.projectId === "string" ? req.body.projectId : undefined,
      metadata: {
        originalFilename: req.file.originalname
      }
    });
    return res.status(201).json(created);
  } catch (error) {
    return respondImageError(res, error);
  }
}));

app.post("/images/generations", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const parsed = generationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const result = await runImageGeneration(owner, parsed.data);
    return res.status(201).json(result);
  } catch (error) {
    return respondImageError(res, error);
  }
}));

app.get("/images/generations", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const items = await listImageJobs(owner, Number.isFinite(limit) ? limit : undefined);
  return res.json({ items });
}));

app.get("/images/generations/:jobId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const job = await getImageJob(owner, String(req.params.jobId));
  if (!job) {
    return res.status(404).json({ message: "Image generation job not found" });
  }
  return res.json(job);
}));

app.post("/images/generations/:jobId/cancel", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const job = await cancelImageJob(owner, String(req.params.jobId));
  if (!job) {
    return res.status(404).json({ message: "Image generation job not found" });
  }
  return res.json(job);
}));

app.delete("/images/generations/:jobId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const deleted = await deleteImageJob(owner, String(req.params.jobId));
  if (!deleted) {
    return res.status(404).json({ message: "Image generation job not found" });
  }
  return res.status(204).send();
}));

app.post("/images/generations/:jobId/retry", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const parsed = retrySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }

  try {
    const job = await retryImageJob(owner, String(req.params.jobId), parsed.data);
    if (!job) {
      return res.status(404).json({ message: "Image generation job not found" });
    }
    return res.status(201).json(job);
  } catch (error) {
    return respondImageError(res, error);
  }
}));

app.get("/images/assets/:assetId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const asset = await getImageAsset(owner, String(req.params.assetId));
  if (!asset) {
    return res.status(404).json({ message: "Image asset not found" });
  }
  return res.json(asset);
}));

app.get("/images/assets/:assetId/download", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const data = await readImageAssetData(owner, String(req.params.assetId));
  if (!data) {
    return res.status(404).json({ message: "Image asset not found" });
  }

  const asAttachment = String(req.query.download ?? "") === "1";
  const disposition = asAttachment ? "attachment" : "inline";
  res.setHeader("Content-Type", data.asset.mimeType);
  res.setHeader("Content-Length", String(data.buffer.length));
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(data.fileName)}`);
  return res.send(data.buffer);
}));

app.delete("/images/assets/:assetId", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const deleted = await deleteImageAsset(owner, String(req.params.assetId));
  if (!deleted) {
    return res.status(404).json({ message: "Image asset not found" });
  }
  return res.status(204).send();
}));

app.post("/images/assets/:assetId/artifact", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res);
  if (!owner) return;
  const parsed = artifactAttachSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten(), code: "INVALID_INPUT" });
  }
  const updated = await attachArtifactToAsset(owner, String(req.params.assetId), parsed.data);
  if (!updated) {
    return res.status(404).json({ message: "Image asset not found" });
  }
  return res.json(updated);
}));

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  respondImageError(res, error);
});

const port = Number(requireEnv("IMAGES_SERVICE_PORT"));
const host = requireEnv("IMAGES_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid IMAGES_SERVICE_PORT value: ${process.env.IMAGES_SERVICE_PORT}`);
}

void ensureImagesSchema().then(() => {
  app.listen(port, host, () => {
    console.log(`Images service HTTP listening on ${host}:${port}`);
  });
});
