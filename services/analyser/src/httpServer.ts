import { createLogger, installProcessHandlers, requestLogger } from "@workbench/logging";
import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey } from "./auth.js";
import { ensureAnalyserSchema, provisionServiceAccount } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const logger = createLogger("analyser");
installProcessHandlers(logger);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(requestLogger(logger));

type AsyncRouteHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
function asyncRoute(handler: AsyncRouteHandler): express.RequestHandler {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}

function invalid(res: express.Response, error: z.ZodError): express.Response {
  return res.status(400).json({ message: error.flatten(), code: "INVALID_INPUT" });
}

const provisionSchema = z.object({
  coreUserId: z.string().min(1),
  username: z.string().min(1)
}).strict();

app.get("/health", (_req, res) => {
  res.json({ service: "analyser", status: "ok", timestamp: new Date().toISOString() });
});

app.post("/internal/accounts", requireInternalApiKey, asyncRoute(async (req, res) => {
  const parsed = provisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error);
  await provisionServiceAccount(parsed.data.coreUserId, parsed.data.username);
  return res.status(201).json({ status: "ok", service: "analyser" });
}));

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(error); return; }
  res.status(500).json({
    message: error instanceof Error ? error.message : "Analyser request failed",
    code: "ANALYSER_INTERNAL_ERROR"
  });
});

const port = Number(requireEnv("ANALYSER_SERVICE_PORT"));
const host = requireEnv("ANALYSER_SERVICE_HOST");
void ensureAnalyserSchema().then(() => {
  app.listen(port, host, () => logger.info(`[analyser] HTTP service listening on http://${host}:${port}`));
});
