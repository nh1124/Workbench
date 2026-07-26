import express from "express";
import { projectSyncEventsForUser } from "../analyserProjector.js";
import { exportAnalyserRecord } from "../analyserExport.js";
import { fetchSkillCatalog } from "../analyserSkillCatalog.js";
import { runSkillIntegrityCheck } from "../analyserSkillIntegrity.js";
import { analyserClient, artifactsClient, serviceBaseUrls } from "../internalClients.js";
import {
  requireAuthenticatedContext,
  requireSyncAccessContext,
  type AuthenticatedContext
} from "../middleware/auth.js";
import { ensureAnalyserAccountProvisioned } from "../serviceProvisioning.js";
import { respondInternalError } from "./shared.js";

export function requireAnalyserConfigured(res: express.Response): boolean {
  if (serviceBaseUrls.analyser) return true;
  res.status(503).json({ message: "Analyser service is not configured", code: "ANALYSER_NOT_CONFIGURED" });
  return false;
}

export function pickAnalyserQuery(
  query: express.Request["query"],
  allowedKeys: readonly string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = query[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export async function forwardAnalyserRequest<T>(
  authContext: AuthenticatedContext,
  delegate: (token: string) => Promise<T>,
  provision: (context: AuthenticatedContext) => Promise<void> = ensureAnalyserAccountProvisioned
): Promise<T> {
  await provision(authContext);
  return delegate(authContext.accessToken);
}

type AnalyserFacadeDelegate = (token: string, req: express.Request) => Promise<unknown>;

function analyserFacadeRoute(
  delegate: AnalyserFacadeDelegate,
  options: { syncAccess?: boolean; status?: number; userOnly?: boolean } = {}
): express.RequestHandler {
  return async (req, res) => {
    const authContext = options.syncAccess
      ? await requireSyncAccessContext(req, res)
      : await requireAuthenticatedContext(req, res, { rejectOAuthScopedTokens: options.userOnly });
    if (!authContext || !requireAnalyserConfigured(res)) return;
    try {
      const result = await forwardAnalyserRequest(authContext, (token) => delegate(token, req));
      if (options.status === 204) return res.status(204).send();
      return res.status(options.status ?? 200).json(result);
    } catch (error) {
      return respondInternalError(res, error);
    }
  };
}

export function registerAnalyserRoutes(app: express.Express): void {
app.post(
  "/api/analyser/machines/register",
  analyserFacadeRoute((token, req) => analyserClient.registerMachine(token, req.body ?? {}), { syncAccess: true })
);
app.get("/api/analyser/machines", analyserFacadeRoute((token) => analyserClient.listMachines(token)));
app.get("/api/analyser/settings", analyserFacadeRoute((token) => analyserClient.getSettings(token)));
app.get(
  "/api/analyser/settings/effective",
  analyserFacadeRoute((token, req) => analyserClient.getEffectiveSettings(
    token,
    pickAnalyserQuery(req.query, ["machineId"])
  ))
);
app.put(
  "/api/analyser/settings/collection",
  analyserFacadeRoute((token, req) => analyserClient.updateCollectionPolicy(token, req.body ?? {}), { userOnly: true })
);
app.put(
  "/api/analyser/settings/automation",
  analyserFacadeRoute((token, req) => analyserClient.updateAutomationPolicy(token, req.body ?? {}), { userOnly: true })
);
app.post(
  "/api/analyser/observations/ingest",
  analyserFacadeRoute((token, req) => analyserClient.ingestObservations(token, req.body ?? {}), { syncAccess: true })
);
app.post("/api/analyser/projector/flush", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext || !requireAnalyserConfigured(res)) return;
  try {
    return res.json(await projectSyncEventsForUser(authContext.userId));
  } catch (error) {
    return respondInternalError(res, error);
  }
});
app.get(
  "/api/analyser/observations",
  analyserFacadeRoute((token, req) => analyserClient.listObservations(
    token,
    pickAnalyserQuery(req.query, ["source", "machineId", "projectId", "from", "to", "limit", "cursor"])
  ))
);
app.get(
  "/api/analyser/observations/aggregate",
  analyserFacadeRoute((token, req) => analyserClient.aggregateActivity(
    token,
    pickAnalyserQuery(req.query, ["from", "to", "machineId", "timezone"])
  ))
);
app.get("/api/analyser/routines", analyserFacadeRoute((token) => analyserClient.listRoutines(token)));
app.get("/api/analyser/routines/status", analyserFacadeRoute((token) => analyserClient.routineStatus(token)));
app.get(
  "/api/analyser/skills/catalog",
  analyserFacadeRoute(async (token) => {
    try {
      return await fetchSkillCatalog(token, {
        treeList: (treeToken, options) => artifactsClient.treeList(treeToken, options)
      });
    } catch {
      return { skills: [], unavailable: true };
    }
  })
);
app.post(
  "/api/analyser/skills/integrity/run",
  analyserFacadeRoute((token) => runSkillIntegrityCheck(token, {
    treeList: artifactsClient.treeList,
    listRoutines: analyserClient.listRoutines,
    listSkillSnapshots: analyserClient.listSkillSnapshots,
    setRoutineSkillFlags: analyserClient.setRoutineSkillFlags,
    createProposal: analyserClient.createProposal
  }))
);
app.post(
  "/api/analyser/skills/snapshots",
  analyserFacadeRoute((token, req) => analyserClient.upsertSkillSnapshot(token, req.body ?? {}), { status: 201 })
);
app.get(
  "/api/analyser/skills/snapshots",
  analyserFacadeRoute((token, req) => analyserClient.listSkillSnapshots(
    token,
    pickAnalyserQuery(req.query, ["limit"])
  ))
);
app.get(
  "/api/analyser/skills/snapshots/:key",
  analyserFacadeRoute((token, req) => analyserClient.getSkillSnapshot(token, String(req.params.key)))
);
app.post(
  "/api/analyser/skills/routine-flags",
  analyserFacadeRoute((token, req) => analyserClient.setRoutineSkillFlags(token, req.body ?? {}))
);
app.post(
  "/api/analyser/routines/seed",
  analyserFacadeRoute((token) => analyserClient.seedRoutines(token), { status: 204 })
);
app.post(
  "/api/analyser/routines",
  analyserFacadeRoute((token, req) => analyserClient.createRoutine(token, req.body ?? {}), { status: 201, userOnly: true })
);
app.patch(
  "/api/analyser/routines/:key",
  analyserFacadeRoute((token, req) => analyserClient.updateRoutine(token, String(req.params.key), req.body ?? {}), { userOnly: true })
);
app.delete(
  "/api/analyser/routines/:key",
  analyserFacadeRoute((token, req) => analyserClient.deleteRoutine(token, String(req.params.key)), { status: 204, userOnly: true })
);
app.post(
  "/api/analyser/routines/claim",
  analyserFacadeRoute((token, req) => analyserClient.claimRoutine(token, req.body ?? {}))
);
app.post(
  "/api/analyser/runs/:runId/heartbeat",
  analyserFacadeRoute((token, req) => analyserClient.heartbeatRun(token, String(req.params.runId), req.body ?? {}))
);
app.post(
  "/api/analyser/runs/:runId/pull",
  analyserFacadeRoute((token, req) => analyserClient.pullRun(token, String(req.params.runId), req.body ?? {}))
);
app.post(
  "/api/analyser/runs/:runId/complete",
  analyserFacadeRoute((token, req) => analyserClient.completeRun(token, String(req.params.runId), req.body ?? {}))
);
app.post(
  "/api/analyser/runs/:runId/fail",
  analyserFacadeRoute((token, req) => analyserClient.failRun(token, String(req.params.runId), req.body ?? {}))
);
app.post(
  "/api/analyser/summaries",
  analyserFacadeRoute((token, req) => analyserClient.upsertSummary(token, req.body ?? {}))
);
app.get(
  "/api/analyser/summaries",
  analyserFacadeRoute((token, req) => analyserClient.listSummaries(
    token,
    pickAnalyserQuery(req.query, ["kind", "from", "to", "routineKey", "limit", "cursor"])
  ))
);
app.get(
  "/api/analyser/summaries/:id",
  analyserFacadeRoute((token, req) => analyserClient.getSummary(token, String(req.params.id)))
);
app.post(
  "/api/analyser/captures/derived",
  analyserFacadeRoute((token, req) => analyserClient.ingestDerivedCapture(token, req.body ?? {}))
);
app.get(
  "/api/analyser/captures/derived",
  analyserFacadeRoute((token, req) => analyserClient.listDerivedCaptures(
    token,
    pickAnalyserQuery(req.query, ["kind", "machineId", "from", "to", "limit", "cursor"])
  ))
);
app.get(
  "/api/analyser/captures/derived/:id",
  analyserFacadeRoute((token, req) => analyserClient.getDerivedCapture(token, String(req.params.id)))
);
app.post(
  "/api/analyser/export",
  analyserFacadeRoute((token, req) => exportAnalyserRecord({ accessToken: token }, req.body ?? {}))
);
app.post(
  "/api/analyser/proposals",
  analyserFacadeRoute((token, req) => analyserClient.createProposal(token, req.body ?? {}))
);
app.get(
  "/api/analyser/proposals",
  analyserFacadeRoute((token, req) => analyserClient.listProposals(
    token,
    pickAnalyserQuery(req.query, ["status", "kind", "routineKey", "limit", "cursor"])
  ))
);
app.get(
  "/api/analyser/proposals/:id",
  analyserFacadeRoute((token, req) => analyserClient.getProposal(token, String(req.params.id)))
);
app.patch(
  "/api/analyser/proposals/:id/content",
  analyserFacadeRoute((token, req) => analyserClient.updateProposalContent(
    token,
    String(req.params.id),
    req.body ?? {}
  ))
);
app.post(
  "/api/analyser/proposals/:id/resolve",
  analyserFacadeRoute((token, req) => analyserClient.resolveProposal(token, String(req.params.id), req.body ?? {}), { userOnly: true })
);
app.post(
  "/api/analyser/proposals/:id/supersede",
  analyserFacadeRoute((token, req) => analyserClient.supersedeProposal(token, String(req.params.id), req.body ?? {}), { userOnly: true })
);
app.post(
  "/api/analyser/proposals/:id/executed",
  analyserFacadeRoute((token, req) => analyserClient.markProposalExecuted(token, String(req.params.id), req.body ?? {}))
);
app.post(
  "/api/analyser/operations",
  analyserFacadeRoute((token, req) => analyserClient.recordOperation(token, req.body ?? {}))
);
app.get(
  "/api/analyser/operations",
  analyserFacadeRoute((token, req) => analyserClient.listOperations(
    token,
    pickAnalyserQuery(req.query, ["operationKind", "result", "proposalId", "limit", "cursor"])
  ))
);
app.get(
  "/api/analyser/operations/:id",
  analyserFacadeRoute((token, req) => analyserClient.getOperation(token, String(req.params.id)))
);
app.post(
  "/api/analyser/publications",
  analyserFacadeRoute((token, req) => analyserClient.recordPublication(token, req.body ?? {}))
);
app.get(
  "/api/analyser/publications",
  analyserFacadeRoute((token, req) => analyserClient.listPublications(
    token,
    pickAnalyserQuery(req.query, ["sourceKind", "sourceId", "limit", "cursor"])
  ))
);
app.get(
  "/api/analyser/publications/find",
  analyserFacadeRoute((token, req) => analyserClient.findPublication(
    token,
    pickAnalyserQuery(req.query, ["sourceKind", "sourceId", "targetKind", "contentHash"])
  ))
);
app.get("/api/analyser/status", analyserFacadeRoute((token) => analyserClient.getStatus(token)));
}
