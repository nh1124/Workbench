import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import {
  createArtifactFile,
  createArtifactFolder,
  createArtifactNote,
  deleteArtifactItem,
  getArtifactItemDetail,
  listArtifactItemProjects,
  listArtifactItems,
  readArtifactFileData,
  updateArtifactItem
} from "./artifactItemsStore.js";
import { ensureArtifactsSchema, upsertServiceAccount } from "./db.js";
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifacts,
  updateArtifact
} from "./store.js";

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

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

const projectsServiceUrl = (() => {
  const direct = optionalEnv("PROJECTS_SERVICE_URL");
  if (direct) {
    return direct;
  }
  const host = optionalEnv("PROJECTS_SERVICE_HOST");
  const port = optionalEnv("PROJECTS_SERVICE_PORT");
  if (host && port) {
    return `http://${host}:${port}`;
  }
  return undefined;
})();
const projectsInternalApiKey = optionalEnv("INTERNAL_API_KEY_PROJECTS");

type DefaultProjectPayload = {
  project?: {
    id: string;
    name: string;
    isFallbackDefault?: boolean;
  };
  id?: string;
  name?: string;
  source?: "user" | "fallback";
};

type ProjectListPayload = {
  items?: Array<{
    id?: string;
    name?: string;
    isFallbackDefault?: boolean;
  }>;
};

function readBearerToken(req: express.Request): string | undefined {
  const raw = req.header("authorization");
  if (!raw) return undefined;
  const [scheme, token] = raw.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim();
}

function parseDefaultProjectPayload(data: DefaultProjectPayload): { projectId: string; projectName: string } | undefined {
  const projectId = data.project?.id || data.id;
  const projectName = data.project?.name || data.name;
  if (!projectId || !projectName) {
    return undefined;
  }
  return {
    projectId: String(projectId).trim(),
    projectName: String(projectName).trim()
  };
}

function parseFallbackProjectFromList(data: ProjectListPayload): { projectId: string; projectName: string } | undefined {
  const items = Array.isArray(data.items) ? data.items : [];
  const fallback = items.find((item) => item?.isFallbackDefault);
  if (!fallback?.id || !fallback?.name) {
    return undefined;
  }
  return {
    projectId: String(fallback.id).trim(),
    projectName: String(fallback.name).trim()
  };
}

async function resolveDefaultProjectForOwner(
  coreUserId: string,
  bearerToken?: string
): Promise<{ projectId: string; projectName: string }> {
  const fallback = { projectId: "default", projectName: "default" };
  if (!projectsServiceUrl) {
    return fallback;
  }

  try {
    if (bearerToken) {
      const userResponse = await fetch(`${projectsServiceUrl}/projects/default`, {
        headers: {
          Authorization: `Bearer ${bearerToken}`
        }
      });
      if (userResponse.ok) {
        const defaultSelection = (await userResponse.json()) as DefaultProjectPayload;
        const parsed = parseDefaultProjectPayload(defaultSelection);
        if (defaultSelection.source === "fallback" && parsed?.projectId && parsed?.projectName) {
          return parsed;
        }
        if (defaultSelection.source === "user") {
          const listResponse = await fetch(`${projectsServiceUrl}/projects?limit=100`, {
            headers: {
              Authorization: `Bearer ${bearerToken}`
            }
          });
          if (listResponse.ok) {
            const fallbackFromList = parseFallbackProjectFromList((await listResponse.json()) as ProjectListPayload);
            if (fallbackFromList?.projectId && fallbackFromList?.projectName) {
              return fallbackFromList;
            }
          }
        }
        if (parsed?.projectId && parsed?.projectName) {
          return parsed;
        }
      }
    }

    if (projectsInternalApiKey) {
      const internalResponse = await fetch(
        `${projectsServiceUrl}/internal/default-project?coreUserId=${encodeURIComponent(coreUserId)}`,
        {
          headers: {
            "x-api-key": projectsInternalApiKey
          }
        }
      );
      if (internalResponse.ok) {
        const parsed = parseDefaultProjectPayload((await internalResponse.json()) as DefaultProjectPayload);
        if (parsed?.projectId && parsed?.projectName) {
          return parsed;
        }
      }
    }

    return fallback;
  } catch {
    return fallback;
  }
}

async function resolveProjectOrDefault(
  req: express.Request,
  projectId?: string
): Promise<{ projectId: string; projectName: string } | undefined> {
  const normalized = projectId?.trim();
  if (normalized) {
    return undefined;
  }

  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return undefined;
  }

  const token = readBearerToken(req);
  try {
    return await resolveDefaultProjectForOwner(owner, token);
  } catch {
    return {
      projectId: "default",
      projectName: "default"
    };
  }
}

const artifactInputSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().default(""),
  projectId: z.string().min(1),
  projectName: z.string().optional(),
  url: z.string().url().optional().or(z.literal(""))
});

const artifactScopeSchema = z.enum(["private", "org", "project"]);

const folderInputSchema = z.object({
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  path: z.string().min(1),
  title: z.string().optional(),
  scope: artifactScopeSchema.optional()
});

const noteInputSchema = z.object({
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  path: z.string().optional(),
  title: z.string().min(1),
  scope: artifactScopeSchema.optional(),
  tags: z.array(z.string()).optional(),
  contentMarkdown: z.string().optional()
});

const itemUpdateSchema = z.object({
  title: z.string().optional(),
  path: z.string().optional(),
  scope: artifactScopeSchema.optional(),
  tags: z.array(z.string()).optional(),
  contentMarkdown: z.string().optional(),
  projectName: z.string().optional()
});

const internalAccountSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1)
});

function parseTagsFromUpload(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0);
  }

  if (typeof raw !== "string") {
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0);
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return trimmed
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

app.get("/health", (_req, res) => {
  res.json({
    service: "artifacts",
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
  return res.status(201).json({ status: "ok", service: "artifacts" });
});

app.get("/artifacts", requireUserAuth, async (req, res) => {
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const artifacts = await listArtifacts(projectId, Number.isFinite(limit) ? limit : undefined, owner);
  res.json(artifacts);
});

app.get("/artifacts/:id([0-9a-fA-F-]{16,})", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const artifact = await getArtifact(String(req.params.id), owner);

  if (!artifact) {
    return res.status(404).json({ message: "Artifact not found" });
  }

  return res.json(artifact);
});

app.post("/artifacts", requireUserAuth, async (req, res) => {
  const parsed = artifactInputSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const normalized = parsed.data.url === "" ? { ...parsed.data, url: undefined } : parsed.data;
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const created = await createArtifact(normalized, owner);
  return res.status(201).json(created);
});

app.patch("/artifacts/:id([0-9a-fA-F-]{16,})", requireUserAuth, async (req, res) => {
  const parsed = artifactInputSchema.partial().safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const normalized = parsed.data.url === "" ? { ...parsed.data, url: undefined } : parsed.data;
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const updated = await updateArtifact(String(req.params.id), normalized, owner);

  if (!updated) {
    return res.status(404).json({ message: "Artifact not found" });
  }

  return res.json(updated);
});

app.delete("/artifacts/:id([0-9a-fA-F-]{16,})", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const deleted = await deleteArtifact(String(req.params.id), owner);

  if (!deleted) {
    return res.status(404).json({ message: "Artifact not found" });
  }

  return res.status(204).send();
});

app.get("/projects", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }
  const projects = await listArtifactItemProjects(owner);
  res.json(projects);
});

app.get("/artifacts/tree", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const items = await listArtifactItems(projectId, owner);
  return res.json(items);
});

app.get("/artifacts/items/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const item = await getArtifactItemDetail(String(req.params.id), owner);
  if (!item) {
    return res.status(404).json({ message: "Artifact item not found" });
  }

  return res.json(item);
});

app.post("/artifacts/folders", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const parsed = folderInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const nextProjectId = parsed.data.projectId?.trim();
    const resolvedDefault = await resolveProjectOrDefault(req, nextProjectId);
    const created = await createArtifactFolder(
      {
        ...parsed.data,
        projectId: nextProjectId || resolvedDefault?.projectId,
        projectName: parsed.data.projectName?.trim() || resolvedDefault?.projectName
      },
      owner
    );
    return res.status(201).json(created);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Folder creation failed";
    return res.status(400).json({ message });
  }
});

app.post("/artifacts/notes", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const parsed = noteInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const nextProjectId = parsed.data.projectId?.trim();
    const resolvedDefault = await resolveProjectOrDefault(req, nextProjectId);
    const created = await createArtifactNote(
      {
        ...parsed.data,
        projectId: nextProjectId || resolvedDefault?.projectId,
        projectName: parsed.data.projectName?.trim() || resolvedDefault?.projectName
      },
      owner
    );
    return res.status(201).json(created);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Note creation failed";
    return res.status(400).json({ message });
  }
});

app.post("/artifacts/upload", requireUserAuth, upload.single("file"), async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "File is required" });
  }

  const projectId = typeof req.body.projectId === "string" ? req.body.projectId.trim() : undefined;

  const directoryPath = typeof req.body.directoryPath === "string" ? req.body.directoryPath : undefined;
  const projectName = typeof req.body.projectName === "string" ? req.body.projectName : undefined;
  const scope = typeof req.body.scope === "string" ? req.body.scope : undefined;
  const tags = parseTagsFromUpload(req.body.tags);

  try {
    const resolvedDefault = await resolveProjectOrDefault(req, projectId);
    const created = await createArtifactFile(
      {
        projectId: projectId || resolvedDefault?.projectId,
        projectName: projectName?.trim() || resolvedDefault?.projectName,
        directoryPath,
        scope: scope === "private" || scope === "org" || scope === "project" ? scope : undefined,
        tags,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        sizeBytes: req.file.size
      },
      owner
    );

    return res.status(201).json(created);
  } catch (error) {
    const message = error instanceof Error ? error.message : "File upload failed";
    return res.status(400).json({ message });
  }
});

app.patch("/artifacts/items/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const parsed = itemUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const updated = await updateArtifactItem(String(req.params.id), parsed.data, owner);
    if (!updated) {
      return res.status(404).json({ message: "Artifact item not found" });
    }
    return res.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return res.status(400).json({ message });
  }
});

app.delete("/artifacts/items/:id", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const deleted = await deleteArtifactItem(String(req.params.id), owner);
  if (!deleted) {
    return res.status(404).json({ message: "Artifact item not found" });
  }

  return res.status(204).send();
});

app.get("/artifacts/items/:id/download", requireUserAuth, async (req, res) => {
  const owner = req.authUser?.coreUserId;
  if (!owner) {
    return res.status(401).json({ message: "Missing auth context" });
  }

  const fileData = await readArtifactFileData(String(req.params.id), owner);
  if (!fileData) {
    return res.status(404).json({ message: "File item not found" });
  }

  const asAttachment = String(req.query.download ?? "") === "1";
  const disposition = asAttachment ? "attachment" : "inline";

  res.setHeader("Content-Type", fileData.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(fileData.buffer.length));
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(fileData.fileName)}`);
  return res.send(fileData.buffer);
});

const port = Number(requireEnv("ARTIFACTS_SERVICE_PORT"));
const host = requireEnv("ARTIFACTS_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid ARTIFACTS_SERVICE_PORT value: ${process.env.ARTIFACTS_SERVICE_PORT}`);
}

void ensureArtifactsSchema().then(() => {
  app.listen(port, host, () => {
    console.log(`Artifacts service HTTP listening on ${host}:${port}`);
  });
});

