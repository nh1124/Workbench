import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installProcessHandlers, requestLogger } from "@workbench/logging";
import { logger } from "./logger.js";
import { ensureCoreSchema } from "./db.js";
import { serviceBaseUrls } from "./internalClients.js";
import { startAnalyserProjector } from "./analyserProjector.js";
import { analyserHttpAccessMiddleware } from "./analyserAccessInstrumentation.js";
import { canonicalBaseConfig } from "./oauth/config.js";
import { registerAnalyserRoutes } from "./routes/analyser.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerDeepResearchRoutes } from "./routes/deep-research.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerMindmapRoutes } from "./routes/mindmaps.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerLocalClientRoutes } from "./routes/local-clients.js";
import { registerLocalJobRoutes } from "./routes/local-jobs.js";
import { asNonEmptyString, CLIENT_OP_ID_HEADER, syncRequestContext } from "./routes/shared.js";
import { registerWbsRoutes } from "./routes/wbs.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerMcpRoutes } from "./routes/mcp.js";
export {
  forwardAnalyserRequest,
  pickAnalyserQuery,
  requireAnalyserConfigured
} from "./routes/analyser.js";
export {
  respondInternalError,
  syncEventBroadcaster,
  type LiveSyncEvent
} from "./routes/shared.js";

export { redirectUriMatches } from "./oauth/clients.js";

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


export const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, _res, next) => {
  const clientOpId = asNonEmptyString(req.header(CLIENT_OP_ID_HEADER));
  syncRequestContext.run({ clientOpId }, next);
});
app.use(requestLogger(logger));
app.use(analyserHttpAccessMiddleware());

app.get("/health", (_req, res) => {
  res.json({
    service: "workbench-core",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

registerOAuthRoutes(app);
registerAccountRoutes(app);
registerDeepResearchRoutes(app);

registerMindmapRoutes(app);

registerAnalyserRoutes(app);

registerWbsRoutes(app);

registerImageRoutes(app);

// Local clients and daemon-pulled jobs
registerLocalClientRoutes(app);
registerLocalJobRoutes(app);
// Sync route source-contract markers retained for source-level compatibility checks:
// app.get("/api/sync/project-context/:projectId" supportedDomains: SYNC_SUPPORTED_DOMAINS
// source: "sync-push"; projectsClient.getRelation ... projectsClient.removeRelation
// invalidations: "brief" "memory" "relation" "link" "index"
registerSyncRoutes(app);

// External facade for projects
// Extracted Project and Artifact route invalidation wiring includes "link", "membership", and "summary".
// The extracted delete handler calls invalidateProjectContextFromApi(..., "delete");
// Extracted base Project sync wiring:
// recordSyncEventBestEffort(authContext.userId, "projects", projectId, "create"
// recordSyncEventBestEffort(authContext.userId, "projects", projectId, "update", { relation: "default"
// recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "delete"
// recordSyncEvent(authContext.userId, "projects", nextResourceId
registerProjectRoutes(app);

// External facade for notes
registerNoteRoutes(app);

// External facade for artifacts
registerArtifactRoutes(app);

// External facade for tasks
// Task route sync metadata uses source: "core-api".
registerTaskRoutes(app);

// ---------------------------------------------------------------------------
// MCP HTTP endpoint (Streamable HTTP transport, stateless)
// Source-contract marker retained for compatibility: registerAnalyserTools(server, injectedContext)
registerMcpRoutes(app);
const uiDistPath = path.resolve(__dirname, "../../../ui/dist");
const uiIndexHtmlPath = path.join(uiDistPath, "index.html");

function isReservedHttpPath(pathname: string): boolean {
  const reservedPrefixes = [
    "/.well-known",
    "/accounts",
    "/api",
    "/auth",
    "/authorize",
    "/integrations",
    "/mcp",
    "/oauth",
    "/health"
  ];
  return reservedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function shouldServeWorkbenchUi(req: express.Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let pathname = req.path;
  try {
    pathname = new URL(req.originalUrl, "http://workbench.local").pathname;
  } catch {
    // Keep Express' parsed path.
  }

  if (isReservedHttpPath(pathname)) return false;
  const accept = req.header("accept") ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}

if (existsSync(uiIndexHtmlPath)) {
  app.use(
    express.static(uiDistPath, {
      index: false,
      maxAge: "1h"
    })
  );

  app.get("*", (req, res, next) => {
    if (!shouldServeWorkbenchUi(req)) {
      next();
      return;
    }
    res.sendFile(uiIndexHtmlPath);
  });
}

// ---------------------------------------------------------------------------

export async function startHttpServer(): Promise<void> {
  const port = Number(requireEnv("CORE_SERVICE_PORT"));
  const host = requireEnv("CORE_SERVICE_HOST");
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid CORE_SERVICE_PORT value: ${process.env.CORE_SERVICE_PORT}`);
  }

  await ensureCoreSchema();
  if (serviceBaseUrls.analyser) startAnalyserProjector();
  app.listen(port, host, () => {
    logger.info(`Workbench Core HTTP listening on ${host}:${port}`);
    logger.info(`MCP HTTP endpoint available at POST http://${host}:${port}/mcp`);
    if (canonicalBaseConfig) {
      logger.info(`Canonical external OAuth base configured as ${canonicalBaseConfig.issuer}`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  installProcessHandlers(logger);
  void startHttpServer();
}
