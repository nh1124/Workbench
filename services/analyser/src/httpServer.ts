import { createLogger, installProcessHandlers, requestLogger } from "@workbench/logging";
import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requireInternalApiKey, requireUserAuth } from "./auth.js";
import { ensureAnalyserSchema, findServiceAccountByCoreUserId, provisionServiceAccount } from "./db.js";
import { AnalyserServiceError } from "./serviceError.js";
import {
  getDerivedCapture,
  ingestDerivedCapture,
  listDerivedCaptures
} from "./stores/derivedCaptures.js";
import { listMachines, registerMachine } from "./stores/machines.js";
import {
  aggregateActivity,
  ingestObservations,
  listObservations,
  startRetentionHousekeeping
} from "./stores/observations.js";
import { getOperation, listOperations, recordOperation } from "./stores/operations.js";
import {
  getAutomationPolicyRecord,
  getCollectionPolicyRows,
  getEffectiveAutomationPolicy,
  getEffectiveCollectionSettings,
  upsertAutomationPolicy,
  upsertCollectionPolicy
} from "./stores/policies.js";
import {
  createProposal,
  getProposal,
  listProposals,
  markProposalExecuted,
  resolveProposal,
  supersedeProposal,
  updateProposalContent
} from "./stores/proposals.js";
import {
  finalizePublication,
  findPublication,
  listPublications,
  recordPublication,
  reservePublication
} from "./stores/publications.js";
import {
  claimDueRoutine,
  completeRun,
  createRoutine,
  deleteRoutine,
  failRun,
  heartbeatRun,
  listRoutines,
  pullForRun,
  routineStatusSummaries,
  seedRoutines,
  updateRoutine
} from "./stores/routines.js";
import { getSummary, listSummaries, upsertSummary } from "./stores/summaries.js";
import {
  ANALYSER_OPERATION_KINDS,
  automationPolicySchema,
  collectionSettingsSchema,
  dateSchema,
  derivedCaptureInputSchema,
  isoDateTimeSchema,
  observationInputSchema,
  OBSERVATION_SOURCES,
  operationInputSchema,
  proposalContentUpdateSchema,
  proposalExecutionSchema,
  proposalInputSchema,
  proposalSupersedeSchema,
  publicationFinalizeInputSchema,
  publicationInputSchema,
  publicationReserveInputSchema,
  summaryInputSchema
} from "./types.js";

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

type AsyncRouteHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;

function asyncRoute(handler: AsyncRouteHandler): express.RequestHandler {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}

function ownerFromRequest(req: express.Request, res: express.Response): string | undefined {
  const owner = req.authUser?.serviceAccountId;
  if (!owner) {
    res.status(401).json({ message: "Missing auth context" });
    return undefined;
  }
  return owner;
}

function respondError(res: express.Response, error: unknown): express.Response {
  if (error instanceof AnalyserServiceError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  if (error instanceof SyntaxError && "status" in error && (error as { status?: unknown }).status === 400) {
    return res.status(400).json({ message: "Invalid JSON body", code: "INVALID_INPUT" });
  }
  return res.status(500).json({
    message: error instanceof Error ? error.message : "Analyser request failed",
    code: "ANALYSER_INTERNAL_ERROR"
  });
}

function invalid(res: express.Response, error: z.ZodError): express.Response {
  return res.status(400).json({ message: error.flatten(), code: "INVALID_INPUT" });
}

function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: express.Response
): z.infer<T> | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    invalid(res, parsed.error);
    return undefined;
  }
  return parsed.data;
}

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const uuidParamsSchema = z.object({ id: z.string().uuid() }).strict();
const runParamsSchema = z.object({ runId: z.string().uuid() }).strict();
const routineKeySchema = boundedText(100);
const routineParamsSchema = z.object({ key: routineKeySchema }).strict();
const emptyObjectSchema = z.object({}).strict();
const paginationSchema = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: boundedText(4_000).optional()
};

export const provisionSchema = z.object({
  coreUserId: boundedText(2_000),
  username: boundedText(2_000)
}).strict();

export const machineRegisterSchema = z.object({
  machineKey: boundedText(500),
  displayName: boundedText(500).optional(),
  platform: boundedText(200).optional()
}).strict();

export const collectionPolicyUpdateSchema = z.object({
  machineId: z.string().uuid().nullable().optional(),
  settings: collectionSettingsSchema,
  expectedVersion: z.number().int().positive().optional()
}).strict();

export const automationPolicyUpdateSchema = z.object({
  policy: automationPolicySchema,
  expectedVersion: z.number().int().positive().optional()
}).strict();

export const observationIngestSchema = z.object({
  machineId: z.string().uuid().optional(),
  observations: z.array(observationInputSchema).max(500)
}).strict();

// workbench_change / mcp_access / ui_access observations are produced exclusively by
// Core's own projector and access-instrumentation via the internal x-api-key route
// (see /internal/observations/ingest); their metadata is trusted because Core built
// it from verified server-side events, not from caller-supplied claims. Accepting
// those sources on the bearer-token-authenticated public route would let any caller
// forge access/change history under their own owner scope. Only genuinely
// client-originated sources are allowed here.
const PUBLIC_INGEST_SOURCES = ["pc_activity", "local_file", "agent_session"] as const;
export const publicObservationIngestSchema = observationIngestSchema.superRefine((value, context) => {
  value.observations.forEach((observation, index) => {
    if (!(PUBLIC_INGEST_SOURCES as readonly string[]).includes(observation.source)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observations", index, "source"],
        message: `source must be one of ${PUBLIC_INGEST_SOURCES.join(", ")} on the public ingest route`
      });
    }
  });
});

export const internalObservationIngestSchema = z.object({
  coreUserId: boundedText(2_000),
  machineId: z.string().uuid().optional(),
  observations: z.array(observationInputSchema).max(500)
}).strict();

export const internalEffectiveSettingsQuerySchema = z.object({
  coreUserId: boundedText(2_000),
  machineId: z.string().uuid().optional()
}).strict();

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Accept either a full ISO datetime (agents) or a bare calendar date (the UI's
// period presets send YYYY-MM-DD). A bare date is widened to the whole day in
// UTC: "start" → 00:00:00.000Z, "end" → 23:59:59.999Z, so the occurred_at range
// stays inclusive. Full ISO datetimes pass through unchanged.
function observationBoundarySchema(boundary: "start" | "end") {
  return z.string().trim().transform((value, context) => {
    if (DATE_ONLY_PATTERN.test(value)) {
      const iso = `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`;
      if (Number.isNaN(new Date(iso).getTime())) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
        return z.NEVER;
      }
      return iso;
    }
    const parsed = isoDateTimeSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an ISO datetime or a YYYY-MM-DD date" });
      return z.NEVER;
    }
    return parsed.data;
  });
}

export const observationListQuerySchema = z.object({
  source: z.enum(OBSERVATION_SOURCES).optional(),
  machineId: z.string().uuid().optional(),
  projectId: boundedText(2_000).optional(),
  from: observationBoundarySchema("start").optional(),
  to: observationBoundarySchema("end").optional(),
  ...paginationSchema
}).strict().superRefine((value, context) => {
  if (value.from && value.to && new Date(value.from).getTime() > new Date(value.to).getTime()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
  }
});

export const activityAggregateQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  machineId: z.string().uuid().optional()
}).strict().refine((value) => value.from <= value.to, {
  path: ["to"],
  message: "to must be on or after from"
});

export const routineCreateSchema = z.object({
  key: routineKeySchema,
  name: boundedText(500),
  skillKey: boundedText(200),
  skillVersion: boundedText(200).optional(),
  scheduleKind: z.enum(["interval", "cron"]),
  scheduleExpr: boundedText(100),
  timezone: boundedText(100),
  enabled: z.boolean().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  backoffMinutes: z.number().int().min(1).max(1_440).optional()
}).strict();

export const routineUpdateSchema = z.object({
  name: boundedText(500).optional(),
  enabled: z.boolean().optional(),
  scheduleKind: z.enum(["interval", "cron"]).optional(),
  scheduleExpr: boundedText(100).optional(),
  timezone: boundedText(100).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  backoffMinutes: z.number().int().min(1).max(1_440).optional(),
  skillVersion: boundedText(200).optional(),
  expectedVersion: z.number().int().positive().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
  message: "At least one routine field is required"
});

const holderSchema = boundedText(2_000);
const leaseSecondsSchema = z.number().int().min(1).max(86_400).optional();

export const routineClaimSchema = z.object({
  key: routineKeySchema.optional(),
  holder: holderSchema,
  leaseSeconds: leaseSecondsSchema
}).strict();

export const runHeartbeatSchema = z.object({
  holder: holderSchema,
  leaseSeconds: leaseSecondsSchema
}).strict();

export const runPullSchema = z.object({
  holder: holderSchema,
  limit: z.number().int().min(1).max(500).optional()
}).strict();

export const runCompleteSchema = z.object({ holder: holderSchema }).strict();
export const runFailSchema = z.object({
  holder: holderSchema,
  errorSummary: boundedText(2_000)
}).strict();

export const summaryListQuerySchema = z.object({
  kind: boundedText(100).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  routineKey: boundedText(2_000).optional(),
  ...paginationSchema
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, {
  path: ["to"],
  message: "to must be on or after from"
});

export const derivedCaptureListQuerySchema = z.object({
  kind: boundedText(100).optional(),
  machineId: z.string().uuid().optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  ...paginationSchema
}).strict().superRefine((value, context) => {
  if (value.from && value.to && new Date(value.from).getTime() > new Date(value.to).getTime()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
  }
});

export const proposalListQuerySchema = z.object({
  status: z.enum(["open", "approved", "rejected", "executed", "superseded"]).optional(),
  kind: boundedText(100).optional(),
  routineKey: boundedText(2_000).optional(),
  ...paginationSchema
}).strict();

export const proposalResolutionBodySchema = z.object({
  status: z.enum(["approved", "rejected"]),
  provenance: boundedText(2_000),
  expectedVersion: z.number().int().positive()
}).strict();

export const operationListQuerySchema = z.object({
  operationKind: z.enum(ANALYSER_OPERATION_KINDS).optional(),
  result: z.enum(["succeeded", "failed", "skipped"]).optional(),
  proposalId: z.string().uuid().optional(),
  ...paginationSchema
}).strict();

export const publicationListQuerySchema = z.object({
  sourceKind: z.enum(["summary", "proposal"]).optional(),
  sourceId: z.string().uuid().optional(),
  ...paginationSchema
}).strict();

export const publicationFindQuerySchema = z.object({
  sourceKind: z.enum(["summary", "proposal"]),
  sourceId: z.string().uuid(),
  targetKind: z.enum(["note", "artifact"]),
  contentHash: z.string().trim().min(8).max(128).regex(/^[0-9a-fA-F]+$/)
}).strict();

export interface AppDeps {
  requireUserAuth: express.RequestHandler;
  requireInternalApiKey: express.RequestHandler;
  provisionServiceAccount: typeof provisionServiceAccount;
  findServiceAccountByCoreUserId: typeof findServiceAccountByCoreUserId;
  registerMachine: typeof registerMachine;
  listMachines: typeof listMachines;
  getEffectiveCollectionSettings: typeof getEffectiveCollectionSettings;
  getCollectionPolicyRows: typeof getCollectionPolicyRows;
  getEffectiveAutomationPolicy: typeof getEffectiveAutomationPolicy;
  getAutomationPolicyRecord: typeof getAutomationPolicyRecord;
  upsertCollectionPolicy: typeof upsertCollectionPolicy;
  upsertAutomationPolicy: typeof upsertAutomationPolicy;
  ingestObservations: typeof ingestObservations;
  listObservations: typeof listObservations;
  aggregateActivity: typeof aggregateActivity;
  listRoutines: typeof listRoutines;
  routineStatusSummaries: typeof routineStatusSummaries;
  seedRoutines: typeof seedRoutines;
  createRoutine: typeof createRoutine;
  deleteRoutine: typeof deleteRoutine;
  updateRoutine: typeof updateRoutine;
  claimDueRoutine: typeof claimDueRoutine;
  heartbeatRun: typeof heartbeatRun;
  pullForRun: typeof pullForRun;
  completeRun: typeof completeRun;
  failRun: typeof failRun;
  upsertSummary: typeof upsertSummary;
  listSummaries: typeof listSummaries;
  getSummary: typeof getSummary;
  ingestDerivedCapture: typeof ingestDerivedCapture;
  listDerivedCaptures: typeof listDerivedCaptures;
  getDerivedCapture: typeof getDerivedCapture;
  createProposal: typeof createProposal;
  listProposals: typeof listProposals;
  getProposal: typeof getProposal;
  updateProposalContent: typeof updateProposalContent;
  resolveProposal: typeof resolveProposal;
  supersedeProposal: typeof supersedeProposal;
  markProposalExecuted: typeof markProposalExecuted;
  recordOperation: typeof recordOperation;
  listOperations: typeof listOperations;
  getOperation: typeof getOperation;
  recordPublication: typeof recordPublication;
  reservePublication: typeof reservePublication;
  finalizePublication: typeof finalizePublication;
  listPublications: typeof listPublications;
  findPublication: typeof findPublication;
}

const realAppDeps: AppDeps = {
  requireUserAuth,
  requireInternalApiKey,
  provisionServiceAccount,
  findServiceAccountByCoreUserId,
  registerMachine,
  listMachines,
  getEffectiveCollectionSettings,
  getCollectionPolicyRows,
  getEffectiveAutomationPolicy,
  getAutomationPolicyRecord,
  upsertCollectionPolicy,
  upsertAutomationPolicy,
  ingestObservations,
  listObservations,
  aggregateActivity,
  listRoutines,
  routineStatusSummaries,
  seedRoutines,
  createRoutine,
  deleteRoutine,
  updateRoutine,
  claimDueRoutine,
  heartbeatRun,
  pullForRun,
  completeRun,
  failRun,
  upsertSummary,
  listSummaries,
  getSummary,
  ingestDerivedCapture,
  listDerivedCaptures,
  getDerivedCapture,
  createProposal,
  listProposals,
  getProposal,
  updateProposalContent,
  resolveProposal,
  supersedeProposal,
  markProposalExecuted,
  recordOperation,
  listOperations,
  getOperation,
  recordPublication,
  reservePublication,
  finalizePublication,
  listPublications,
  findPublication
};

function userRoute(deps: AppDeps, handler: AsyncRouteHandler): express.RequestHandler[] {
  return [deps.requireUserAuth, asyncRoute(async (req, res, next) => {
    const owner = ownerFromRequest(req, res);
    if (!owner) return;
    return handler(req, res, next);
  })];
}

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));
  app.use(requestLogger(logger));

  app.get("/health", (_req, res) => {
    res.json({ service: "analyser", status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/internal/accounts", deps.requireInternalApiKey, asyncRoute(async (req, res) => {
    const body = parse(provisionSchema, req.body ?? {}, res);
    if (!body) return;
    await deps.provisionServiceAccount(body.coreUserId, body.username);
    return res.status(201).json({ status: "ok", service: "analyser" });
  }));

  app.post("/internal/observations/ingest", deps.requireInternalApiKey, asyncRoute(async (req, res) => {
    const body = parse(internalObservationIngestSchema, req.body ?? {}, res);
    if (!body) return;
    const account = await deps.findServiceAccountByCoreUserId(body.coreUserId);
    if (!account) {
      throw new AnalyserServiceError(404, "ACCOUNT_NOT_FOUND", "Analyser service account not found");
    }
    return res.json(await deps.ingestObservations(
      account.id,
      body.observations,
      body.machineId ? { machineId: body.machineId } : {}
    ));
  }));

  app.get("/internal/settings/effective", deps.requireInternalApiKey, asyncRoute(async (req, res) => {
    const query = parse(internalEffectiveSettingsQuerySchema, req.query, res);
    if (!query) return;
    const account = await deps.findServiceAccountByCoreUserId(query.coreUserId);
    if (!account) {
      throw new AnalyserServiceError(404, "ACCOUNT_NOT_FOUND", "Analyser service account not found");
    }
    return res.json(await deps.getEffectiveCollectionSettings(account.id, query.machineId));
  }));

  app.post("/machines/register", ...userRoute(deps, async (req, res) => {
    const body = parse(machineRegisterSchema, req.body ?? {}, res);
    if (!body) return;
    return res.json(await deps.registerMachine(req.authUser!.serviceAccountId, body));
  }));

  app.get("/machines", ...userRoute(deps, async (req, res) => {
    const query = parse(emptyObjectSchema, req.query, res);
    if (!query) return;
    return res.json({ items: await deps.listMachines(req.authUser!.serviceAccountId) });
  }));

  app.get("/settings", ...userRoute(deps, async (req, res) => {
    const query = parse(emptyObjectSchema, req.query, res);
    if (!query) return;
    const owner = req.authUser!.serviceAccountId;
    const [effective, rows, policy, automationRecord] = await Promise.all([
      deps.getEffectiveCollectionSettings(owner),
      deps.getCollectionPolicyRows(owner),
      deps.getEffectiveAutomationPolicy(owner),
      deps.getAutomationPolicyRecord(owner)
    ]);
    return res.json({
      effective,
      rows,
      automation: {
        policy,
        ...(automationRecord ? { version: automationRecord.version, updatedAt: automationRecord.updatedAt } : {})
      }
    });
  }));

  app.get("/settings/effective", ...userRoute(deps, async (req, res) => {
    const query = parse(z.object({ machineId: z.string().uuid().optional() }).strict(), req.query, res);
    if (!query) return;
    return res.json(await deps.getEffectiveCollectionSettings(req.authUser!.serviceAccountId, query.machineId));
  }));

  app.put("/settings/collection", ...userRoute(deps, async (req, res) => {
    const body = parse(collectionPolicyUpdateSchema, req.body ?? {}, res);
    if (!body) return;
    return res.json(await deps.upsertCollectionPolicy(req.authUser!.serviceAccountId, {
      ...body,
      updatedBy: req.authUser!.usernameSnapshot
    }));
  }));

  app.put("/settings/automation", ...userRoute(deps, async (req, res) => {
    const body = parse(automationPolicyUpdateSchema, req.body ?? {}, res);
    if (!body) return;
    return res.json(await deps.upsertAutomationPolicy(req.authUser!.serviceAccountId, {
      ...body,
      updatedBy: req.authUser!.usernameSnapshot
    }));
  }));

  app.post("/observations/ingest", ...userRoute(deps, async (req, res) => {
    const body = parse(publicObservationIngestSchema, req.body ?? {}, res);
    if (!body) return;
    return res.json(await deps.ingestObservations(
      req.authUser!.serviceAccountId,
      body.observations,
      body.machineId ? { machineId: body.machineId } : {}
    ));
  }));

  app.get("/observations", ...userRoute(deps, async (req, res) => {
    const query = parse(observationListQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.listObservations(req.authUser!.serviceAccountId, query));
  }));

  app.get("/observations/aggregate", ...userRoute(deps, async (req, res) => {
    const query = parse(activityAggregateQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.aggregateActivity(req.authUser!.serviceAccountId, query));
  }));

  app.get("/routines", ...userRoute(deps, async (req, res) => {
    const query = parse(emptyObjectSchema, req.query, res);
    if (!query) return;
    return res.json({ items: await deps.listRoutines(req.authUser!.serviceAccountId) });
  }));

  app.get("/routines/status", ...userRoute(deps, async (req, res) => {
    const query = parse(emptyObjectSchema, req.query, res);
    if (!query) return;
    return res.json({ items: await deps.routineStatusSummaries(req.authUser!.serviceAccountId) });
  }));

  app.post("/routines/seed", ...userRoute(deps, async (req, res) => {
    const body = parse(emptyObjectSchema, req.body ?? {}, res);
    if (!body) return;
    await deps.seedRoutines(req.authUser!.serviceAccountId);
    return res.status(204).send();
  }));

  app.post("/routines", ...userRoute(deps, async (req, res) => {
    const body = parse(routineCreateSchema, req.body ?? {}, res);
    if (!body) return;
    return res.status(201).json(await deps.createRoutine(req.authUser!.serviceAccountId, body));
  }));

  app.patch("/routines/:key", ...userRoute(deps, async (req, res) => {
    const params = parse(routineParamsSchema, req.params, res);
    const body = parse(routineUpdateSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.updateRoutine(req.authUser!.serviceAccountId, params.key, body));
  }));

  app.delete("/routines/:key", ...userRoute(deps, async (req, res) => {
    const params = parse(routineParamsSchema, req.params, res);
    if (!params) return;
    await deps.deleteRoutine(req.authUser!.serviceAccountId, params.key);
    return res.status(204).send();
  }));

  app.post("/routines/claim", ...userRoute(deps, async (req, res) => {
    const body = parse(routineClaimSchema, req.body ?? {}, res);
    if (!body) return;
    return res.json({ claim: await deps.claimDueRoutine(req.authUser!.serviceAccountId, body) });
  }));

  app.post("/runs/:runId/heartbeat", ...userRoute(deps, async (req, res) => {
    const params = parse(runParamsSchema, req.params, res);
    const body = parse(runHeartbeatSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.heartbeatRun(
      req.authUser!.serviceAccountId,
      params.runId,
      body.holder,
      body.leaseSeconds
    ));
  }));

  app.post("/runs/:runId/pull", ...userRoute(deps, async (req, res) => {
    const params = parse(runParamsSchema, req.params, res);
    const body = parse(runPullSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.pullForRun(
      req.authUser!.serviceAccountId,
      params.runId,
      body.holder,
      body.limit
    ));
  }));

  app.post("/runs/:runId/complete", ...userRoute(deps, async (req, res) => {
    const params = parse(runParamsSchema, req.params, res);
    const body = parse(runCompleteSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.completeRun(req.authUser!.serviceAccountId, params.runId, body.holder));
  }));

  app.post("/runs/:runId/fail", ...userRoute(deps, async (req, res) => {
    const params = parse(runParamsSchema, req.params, res);
    const body = parse(runFailSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.failRun(req.authUser!.serviceAccountId, params.runId, body.holder, {
      errorSummary: body.errorSummary
    }));
  }));

  app.post("/summaries", ...userRoute(deps, async (req, res) => {
    const body = parse(summaryInputSchema, req.body ?? {}, res);
    if (!body) return;
    return res.json({ summary: await deps.upsertSummary(req.authUser!.serviceAccountId, body) });
  }));

  app.get("/summaries", ...userRoute(deps, async (req, res) => {
    const query = parse(summaryListQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.listSummaries(req.authUser!.serviceAccountId, query));
  }));

  app.get("/summaries/:id", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    if (!params) return;
    return res.json(await deps.getSummary(req.authUser!.serviceAccountId, params.id));
  }));

  app.post("/captures/derived", ...userRoute(deps, async (req, res) => {
    const body = parse(derivedCaptureInputSchema, req.body ?? {}, res);
    if (!body) return;
    const owner = req.authUser!.serviceAccountId;
    const settings = await deps.getEffectiveCollectionSettings(owner, body.machineId);
    if (settings.settings.screenshotDerivedUpload !== true) {
      throw new AnalyserServiceError(403, "DERIVED_CAPTURE_DISABLED", "Derived capture upload is disabled");
    }
    const result = await deps.ingestDerivedCapture(owner, body);
    return res.status(result.created ? 201 : 200).json(result);
  }));

  app.get("/captures/derived", ...userRoute(deps, async (req, res) => {
    const query = parse(derivedCaptureListQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.listDerivedCaptures(req.authUser!.serviceAccountId, query));
  }));

  app.get("/captures/derived/:id", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    if (!params) return;
    return res.json(await deps.getDerivedCapture(req.authUser!.serviceAccountId, params.id));
  }));

  app.post("/proposals", ...userRoute(deps, async (req, res) => {
    const body = parse(proposalInputSchema, req.body ?? {}, res);
    if (!body) return;
    const result = await deps.createProposal(req.authUser!.serviceAccountId, body);
    return res.status(result.created ? 201 : 200).json(result);
  }));

  app.get("/proposals", ...userRoute(deps, async (req, res) => {
    const query = parse(proposalListQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.listProposals(req.authUser!.serviceAccountId, query));
  }));

  app.get("/proposals/:id", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    if (!params) return;
    return res.json(await deps.getProposal(req.authUser!.serviceAccountId, params.id));
  }));

  app.patch("/proposals/:id/content", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    const body = parse(proposalContentUpdateSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.updateProposalContent(req.authUser!.serviceAccountId, params.id, body));
  }));

  app.post("/proposals/:id/resolve", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    const body = parse(proposalResolutionBodySchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.resolveProposal(req.authUser!.serviceAccountId, params.id, {
      ...body,
      resolvedBy: req.authUser!.usernameSnapshot
    }));
  }));

  app.post("/proposals/:id/supersede", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    const body = parse(proposalSupersedeSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.supersedeProposal(req.authUser!.serviceAccountId, params.id, body));
  }));

  app.post("/proposals/:id/executed", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    const body = parse(proposalExecutionSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.markProposalExecuted(req.authUser!.serviceAccountId, params.id, body));
  }));

  app.post("/operations", ...userRoute(deps, async (req, res) => {
    const body = parse(operationInputSchema, req.body ?? {}, res);
    if (!body) return;
    const result = await deps.recordOperation(req.authUser!.serviceAccountId, body);
    return res.status(result.created ? 201 : 200).json(result);
  }));

  app.get("/operations", ...userRoute(deps, async (req, res) => {
    const query = parse(operationListQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.listOperations(req.authUser!.serviceAccountId, query));
  }));

  app.get("/operations/:id", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    if (!params) return;
    return res.json(await deps.getOperation(req.authUser!.serviceAccountId, params.id));
  }));

  app.post("/publications", ...userRoute(deps, async (req, res) => {
    const body = parse(publicationInputSchema, req.body ?? {}, res);
    if (!body) return;
    const result = await deps.recordPublication(req.authUser!.serviceAccountId, body);
    return res.status(result.created ? 201 : 200).json(result);
  }));

  app.post("/publications/reserve", ...userRoute(deps, async (req, res) => {
    const body = parse(publicationReserveInputSchema, req.body ?? {}, res);
    if (!body) return;
    const result = await deps.reservePublication(req.authUser!.serviceAccountId, body);
    return res.status(result.reserved ? 201 : 200).json(result);
  }));

  app.post("/publications/:id/finalize", ...userRoute(deps, async (req, res) => {
    const params = parse(uuidParamsSchema, req.params, res);
    const body = parse(publicationFinalizeInputSchema, req.body ?? {}, res);
    if (!params || !body) return;
    return res.json(await deps.finalizePublication(req.authUser!.serviceAccountId, params.id, body));
  }));

  app.get("/publications", ...userRoute(deps, async (req, res) => {
    const query = parse(publicationListQuerySchema, req.query, res);
    if (!query) return;
    return res.json(await deps.listPublications(req.authUser!.serviceAccountId, query));
  }));

  app.get("/publications/find", ...userRoute(deps, async (req, res) => {
    const query = parse(publicationFindQuerySchema, req.query, res);
    if (!query) return;
    const publication = await deps.findPublication(req.authUser!.serviceAccountId, query);
    return res.json({ publication: publication ?? null });
  }));

  app.get("/status", ...userRoute(deps, async (req, res) => {
    const query = parse(emptyObjectSchema, req.query, res);
    if (!query) return;
    const owner = req.authUser!.serviceAccountId;
    const [routines, openProposals, machines] = await Promise.all([
      deps.routineStatusSummaries(owner),
      deps.listProposals(owner, { status: "open", limit: 1 }),
      deps.listMachines(owner)
    ]);
    return res.json({ routines, hasOpenProposals: openProposals.items.length > 0, machines });
  }));

  app.use((_req, _res, next) => {
    next(new AnalyserServiceError(404, "ROUTE_NOT_FOUND", "Route not found"));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    respondError(res, error);
  });

  return app;
}

if (process.env.ANALYSER_SKIP_BOOTSTRAP !== "1") {
  const port = Number(requireEnv("ANALYSER_SERVICE_PORT"));
  const host = requireEnv("ANALYSER_SERVICE_HOST");
  const app = buildApp(realAppDeps);
  void ensureAnalyserSchema().then(() => {
    startRetentionHousekeeping(3_600_000, logger);
    app.listen(port, host, () => logger.info(`[analyser] HTTP service listening on http://${host}:${port}`));
  });
}
