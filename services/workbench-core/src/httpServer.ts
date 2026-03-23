import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { issueTokenBundle, verifyAccessToken, verifyRefreshToken } from "./auth.js";
import { ensureCoreSchema } from "./db.js";
import { getIntegrationManifests, type IntegrationManifestId } from "./integrations/index.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerAuthTools } from "./mcp/registerAuthTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";
import { ensureIntegrationLinked } from "./integrationLinking.js";
import { artifactsClient, InternalServiceError, notesClient, projectsClient, serviceBaseUrls, tasksClient } from "./internalClients.js";
import { DeepResearchError } from "./deepResearch/errors.js";
import {
  cancelDeepResearch,
  getDeepResearchDefaults,
  listDeepResearchHistory,
  getDeepResearchStatus,
  runDeepResearch,
  saveDeepResearchJobArtifact
} from "./deepResearch/service.js";
import {
  findUserById,
  listIntegrationConfigs,
  listProvisionings,
  loginUser,
  registerUser,
  saveIntegrationConfig,
  upsertProvisioning
} from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

type ServiceTarget = {
  id: IntegrationManifestId;
  baseUrl: string;
  apiKey: string;
};

const serviceTargets: ServiceTarget[] = [
  {
    id: "notes",
    baseUrl: requireEnv("NOTES_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_NOTES")
  },
  {
    id: "artifacts",
    baseUrl: requireEnv("ARTIFACTS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_ARTIFACTS")
  },
  {
    id: "tasks",
    baseUrl: requireEnv("TASKS_SERVICE_URL"),
    apiKey: requireEnv("INTERNAL_API_KEY_TASKS")
  }
];

const projectsServiceUrl = optionalEnv("PROJECTS_SERVICE_URL");
const projectsInternalApiKey = optionalEnv("INTERNAL_API_KEY_PROJECTS");
if (projectsServiceUrl && projectsInternalApiKey) {
  serviceTargets.push({
    id: "projects",
    baseUrl: projectsServiceUrl,
    apiKey: projectsInternalApiKey
  });
}

const accountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const integrationConfigSchema = z.object({
  enabled: z.boolean(),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
});

const taskImportBodySchema = z.union([z.string(), z.object({ csv: z.string() })]);

const deepResearchRequestSchema = z.object({
  query: z.string().min(1),
  provider: z.enum(["auto", "gemini", "openai", "anthropic"]).optional(),
  speed: z.enum(["deep", "fast"]).optional(),
  timeoutSec: z.number().int().positive().optional(),
  asyncOnTimeout: z.boolean().optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

const deepResearchManualSaveSchema = z.object({
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

type AuthenticatedContext = {
  userId: string;
  username: string;
  accessToken: string;
};

function readBearerToken(req: express.Request): string | undefined {
  const raw = req.header("authorization");
  if (!raw) return undefined;
  const [scheme, token] = raw.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token.trim();
}

async function requireAuthenticatedContext(
  req: express.Request,
  res: express.Response
): Promise<AuthenticatedContext | undefined> {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ message: "Missing bearer token" });
    return undefined;
  }

  try {
    const claims = verifyAccessToken(token);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      res.status(401).json({ message: "Invalid token user" });
      return undefined;
    }

    return {
      userId: user.id,
      username: user.username,
      accessToken: token
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ message: "Invalid or expired token" });
      return undefined;
    }
    const message = error instanceof Error ? error.message : "Authentication failed";
    res.status(401).json({ message });
    return undefined;
  }
}

function respondInternalError(res: express.Response, error: unknown): express.Response {
  if (error instanceof InternalServiceError) {
    if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 400) {
      return res.status(error.status).json({ message: error.body || error.message });
    }
    return res.status(502).json({ message: `[${error.service}] ${error.body || error.message}` });
  }

  const message = error instanceof Error ? error.message : "Unexpected internal error";
  return res.status(500).json({ message });
}

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

async function provisionAccountToServices(userId: string, username: string) {
  const results = await Promise.all(
    serviceTargets.map(async (service) => {
      try {
        const response = await fetch(`${service.baseUrl}/internal/accounts`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": service.apiKey
          },
          body: JSON.stringify({ coreUserId: userId, username })
        });

        if (!response.ok) {
          const text = await response.text();
          await upsertProvisioning(userId, service.id, "error", text || `HTTP ${response.status}`);
          return { serviceId: service.id, status: "error" as const, message: text || `HTTP ${response.status}` };
        }

        await upsertProvisioning(userId, service.id, "ok");
        return { serviceId: service.id, status: "ok" as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provisioning failed";
        await upsertProvisioning(userId, service.id, "error", message);
        return { serviceId: service.id, status: "error" as const, message };
      }
    })
  );

  return results;
}

app.get("/health", (_req, res) => {
  res.json({
    service: "workbench-core",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

app.post("/accounts/register", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const user = await registerUser(parsed.data.username, parsed.data.password);
    const provisioning = await provisionAccountToServices(user.id, user.username);
    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    return res.status(201).json({ user, provisioning, ...tokenBundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Registration failed";
    if (message.includes("duplicate key")) {
      return res.status(409).json({ message: "Username already exists" });
    }
    return res.status(500).json({ message });
  }
});

app.post("/accounts/login", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const user = await loginUser(parsed.data.username, parsed.data.password);
  if (!user) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  await provisionAccountToServices(user.id, user.username);
  const provisioning = await listProvisionings(user.id);
  const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
  return res.json({ user, provisioning, ...tokenBundle });
});

app.post("/auth/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const claims = verifyRefreshToken(parsed.data.refreshToken);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      return res.status(401).json({ message: "Invalid refresh token user" });
    }

    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    return res.json({ user, ...tokenBundle });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }
    const message = error instanceof Error ? error.message : "Refresh failed";
    return res.status(401).json({ message });
  }
});

app.get("/auth/me", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const user = await findUserById(authContext.userId);
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  const provisioning = await listProvisionings(user.id);
  return res.json({ user, provisioning });
});

app.get("/integrations/manifests", async (_req, res) => {
  const enabledIntegrationIds = new Set(serviceTargets.map((service) => service.id));
  enabledIntegrationIds.add("deep_research");
  return res.json(getIntegrationManifests(enabledIntegrationIds));
});

app.get("/integrations/configs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const configs = await listIntegrationConfigs(authContext.userId);
  return res.json(configs);
});

app.put("/integrations/configs/:integrationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const parsed = integrationConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const existingConfig = (await listIntegrationConfigs(authContext.userId)).find(
      (row) => row.integrationId === req.params.integrationId
    );
    const mergedValues = {
      ...(existingConfig?.values ?? {}),
      ...parsed.data.values
    };

    const values = parsed.data.enabled
      ? await ensureIntegrationLinked(req.params.integrationId, mergedValues)
      : mergedValues;
    await saveIntegrationConfig(authContext.userId, req.params.integrationId, parsed.data.enabled, values);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration activation failed";
    return res.status(502).json({ message });
  }

  return res.json({ status: "ok" });
});

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

// External facade for projects
app.get("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  try {
    const result = await projectsClient.list(
      authContext.accessToken,
      query,
      status,
      Number.isFinite(limit) ? limit : undefined,
      cursor
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.create(authContext.accessToken, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.getDefault(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.setDefault(authContext.accessToken, req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.get(authContext.accessToken, String(req.params.projectId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.update(authContext.accessToken, String(req.params.projectId), req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await projectsClient.remove(authContext.accessToken, String(req.params.projectId));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for notes
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
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for artifacts
app.get("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.list(authContext.accessToken, projectId, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  try {
    const result = await artifactsClient.tree(authContext.accessToken, projectId);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.getItem(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/folders", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.createFolder(authContext.accessToken, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.createNote(authContext.accessToken, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/upload", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const target = `${serviceBaseUrls.artifacts}/artifacts/upload`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) {
      res.setHeader("Content-Type", responseContentType);
    }

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.patch("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.updateItem(authContext.accessToken, String(req.params.id), req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await artifactsClient.removeItem(authContext.accessToken, String(req.params.id));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") {
    query.set("download", req.query.download);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/download${suffix}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.create(authContext.accessToken, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.update(authContext.accessToken, String(req.params.id), req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await artifactsClient.remove(authContext.accessToken, String(req.params.id));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for tasks
app.get("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await tasksClient.list(authContext.accessToken, context, status, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/history", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.history(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.create(authContext.accessToken, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.update(authContext.accessToken, String(req.params.id), req.body);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await tasksClient.remove(authContext.accessToken, String(req.params.id));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/export", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const csv = await tasksClient.exportCsv(authContext.accessToken);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="tasks.csv"');
    return res.send(csv);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/import", express.text({ type: "text/csv", limit: "10mb" }), async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = taskImportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  const csvContent = typeof parsed.data === "string" ? parsed.data : parsed.data.csv;
  if (!csvContent.trim()) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  try {
    const result = await tasksClient.importCsv(authContext.accessToken, csvContent);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ---------------------------------------------------------------------------
// MCP HTTP endpoint (Streamable HTTP transport, stateless)
// Requires Bearer token authentication. Tools are accessible at POST /mcp.
// ---------------------------------------------------------------------------

function createMcpServerInstance(): McpServer {
  const server = new McpServer({ name: "workbench-core-mcp", version: "0.2.0" });
  registerAuthTools(server);
  registerNotesTools(server);
  registerArtifactsTools(server);
  registerTasksTools(server);
  registerDeepResearchTools(server);
  return server;
}

// Handle POST /mcp  – used for tool calls (and initialize)
app.post("/mcp", async (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized", message: "Bearer token required for MCP access" });
  }

  const server = createMcpServerInstance();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP request failed";
    if (!res.headersSent) {
      res.status(500).json({ error: "InternalError", message });
    }
  }
});

// Handle GET /mcp – SSE stream for server-initiated messages (stateless: returns 405)
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "MethodNotAllowed",
    message: "This MCP server runs in stateless mode. Use POST /mcp for all requests."
  });
});

// ---------------------------------------------------------------------------

const port = Number(requireEnv("CORE_SERVICE_PORT"));
const host = requireEnv("CORE_SERVICE_HOST");
if (!Number.isFinite(port)) {
  throw new Error(`Invalid CORE_SERVICE_PORT value: ${process.env.CORE_SERVICE_PORT}`);
}

void ensureCoreSchema().then(() => {
  app.listen(port, host, () => {
    console.log(`Workbench Core HTTP listening on ${host}:${port}`);
    console.log(`MCP HTTP endpoint available at POST http://${host}:${port}/mcp`);
  });
});
