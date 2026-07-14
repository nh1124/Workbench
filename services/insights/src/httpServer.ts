import cors from "cors";
import { createLogger, installProcessHandlers, requestLogger } from "@workbench/logging";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureInsightsSchema, provisionServiceAccount } from "./db.js";
import { createDerived, getSummary, ingestSamples, ingestSummaries, InsightsServiceError, listDerived, listMachines, listSummaries, queryActivity, registerMachine } from "./store.js";
import { dateSchema, derivedCreateSchema, machineRegisterSchema, sampleIngestSchema, summaryIngestSchema } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });
function requireEnv(name: string): string {
  const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing required environment variable: ${name}`); return value;
}
const logger = createLogger("insights");
installProcessHandlers(logger);
const app = express(); app.use(cors()); app.use(express.json({ limit: "5mb" })); app.use(requestLogger(logger));
type AsyncRouteHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
function asyncRoute(handler: AsyncRouteHandler): express.RequestHandler { return (req, res, next) => { void handler(req, res, next).catch(next); }; }
function ownerFromRequest(req: express.Request, res: express.Response): string | undefined {
  const owner = req.authUser?.serviceAccountId; if (!owner) { res.status(401).json({ message: "Missing auth context" }); return undefined; } return owner;
}
function respondError(res: express.Response, error: unknown): express.Response {
  if (error instanceof InsightsServiceError) return res.status(error.status).json({ message: error.message, code: error.code });
  return res.status(500).json({ message: error instanceof Error ? error.message : "Insights request failed", code: "INSIGHTS_INTERNAL_ERROR" });
}
function invalid(res: express.Response, error: z.ZodError): express.Response { return res.status(400).json({ message: error.flatten(), code: "INVALID_INPUT" }); }

const provisionSchema = z.object({ coreUserId: z.string().min(1), username: z.string().min(1) }).strict();
const listSummariesQuerySchema = z.object({
  machineId: z.string().uuid().optional(), from: dateSchema.optional(), to: dateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().min(1).optional()
});
const activityQuerySchema = z.object({ from: dateSchema, to: dateSchema, machineId: z.string().uuid().optional() })
  .refine((value) => value.from <= value.to, { message: "from must be on or before to" });
const listDerivedQuerySchema = z.object({
  from: dateSchema.optional(), to: dateSchema.optional(), kind: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(), cursor: z.string().min(1).optional()
});

app.get("/health", (_req, res) => res.json({ service: "insights", status: "ok", timestamp: new Date().toISOString() }));
app.post("/internal/accounts", requireInternalApiKey, asyncRoute(async (req, res) => {
  const parsed = provisionSchema.safeParse(req.body ?? {}); if (!parsed.success) return invalid(res, parsed.error);
  await provisionServiceAccount(parsed.data.coreUserId, parsed.data.username); return res.status(201).json({ status: "ok", service: "insights" });
}));
app.post("/machines/register", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = machineRegisterSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json(await registerMachine(owner, parsed.data)); } catch (error) { return respondError(res, error); }
}));
app.get("/machines", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; try { return res.json({ items: await listMachines(owner) }); } catch (error) { return respondError(res, error); }
}));
app.post("/ingest/samples", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = sampleIngestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json({ ingested: await ingestSamples(owner, parsed.data.machineId, parsed.data.samples) }); } catch (error) { return respondError(res, error); }
}));
app.post("/ingest/summaries", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = summaryIngestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json({ ingested: await ingestSummaries(owner, parsed.data.machineId, parsed.data.summaries) }); } catch (error) { return respondError(res, error); }
}));
app.get("/summaries", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = listSummariesQuerySchema.safeParse(req.query);
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json(await listSummaries(owner, parsed.data)); } catch (error) { return respondError(res, error); }
}));
app.get("/summaries/:machineId/:date", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = z.object({ machineId: z.string().uuid(), date: dateSchema }).safeParse(req.params);
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json(await getSummary(owner, parsed.data.machineId, parsed.data.date)); } catch (error) { return respondError(res, error); }
}));
app.get("/activity", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = activityQuerySchema.safeParse(req.query);
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json(await queryActivity(owner, parsed.data)); } catch (error) { return respondError(res, error); }
}));
app.post("/derived", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = derivedCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return invalid(res, parsed.error); try { return res.status(201).json(await createDerived(owner, parsed.data)); } catch (error) { return respondError(res, error); }
}));
app.get("/derived", requireUserAuth, asyncRoute(async (req, res) => {
  const owner = ownerFromRequest(req, res); if (!owner) return; const parsed = listDerivedQuerySchema.safeParse(req.query);
  if (!parsed.success) return invalid(res, parsed.error); try { return res.json(await listDerived(owner, parsed.data)); } catch (error) { return respondError(res, error); }
}));
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(error); return; } respondError(res, error);
});
const port = Number(requireEnv("INSIGHTS_SERVICE_PORT")); const host = requireEnv("INSIGHTS_SERVICE_HOST");
void ensureInsightsSchema().then(() => app.listen(port, host, () => logger.info(`[insights] HTTP service listening on http://${host}:${port}`)));
