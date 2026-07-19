import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { RequestHandler } from "express";

process.env.ANALYSER_SKIP_BOOTSTRAP = "1";
process.env.ANALYSER_DB_HOST ??= "127.0.0.1";
process.env.ANALYSER_DB_PORT ??= "5551";
process.env.ANALYSER_DB_NAME ??= "test";
process.env.ANALYSER_DB_USER ??= "test";
process.env.ANALYSER_DB_PASSWORD ??= "test";
process.env.JWT_SECRET ??= "analyser-internal-ingest-test-secret";
process.env.JWT_ISSUER ??= "analyser-internal-ingest-tests";
process.env.INTERNAL_API_KEY_ANALYSER ??= "analyser-internal-ingest-test-key";

const { buildApp } = await import("../httpServer.js");
type AppDeps = import("../httpServer.js").AppDeps;

const passThrough: RequestHandler = (_req, _res, next) => next();

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected route dependency call");
  };
  return Object.assign({
    requireUserAuth: passThrough,
    requireInternalApiKey: passThrough,
    provisionServiceAccount: unexpected,
    findServiceAccountByCoreUserId: unexpected,
    registerMachine: unexpected,
    listMachines: unexpected,
    getEffectiveCollectionSettings: unexpected,
    getCollectionPolicyRows: unexpected,
    getEffectiveAutomationPolicy: unexpected,
    upsertCollectionPolicy: unexpected,
    upsertAutomationPolicy: unexpected,
    ingestObservations: unexpected,
    listObservations: unexpected,
    aggregateActivity: unexpected,
    listRoutines: unexpected,
    routineStatusSummaries: unexpected,
    seedRoutines: unexpected,
    updateRoutine: unexpected,
    claimDueRoutine: unexpected,
    heartbeatRun: unexpected,
    pullForRun: unexpected,
    completeRun: unexpected,
    failRun: unexpected,
    upsertSummary: unexpected,
    listSummaries: unexpected,
    getSummary: unexpected,
    createProposal: unexpected,
    listProposals: unexpected,
    getProposal: unexpected,
    updateProposalContent: unexpected,
    resolveProposal: unexpected,
    supersedeProposal: unexpected,
    markProposalExecuted: unexpected,
    recordOperation: unexpected,
    listOperations: unexpected,
    getOperation: unexpected,
    recordPublication: unexpected,
    listPublications: unexpected,
    findPublication: unexpected
  } as unknown as AppDeps, overrides);
}

async function withServer(deps: AppDeps, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(buildApp(deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; apiKey?: string } = {}
): Promise<{ response: Response; body: unknown }> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.apiKey) headers.set("x-api-key", options.apiKey);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { response, body: await response.json() };
}

const observation = {
  source: "workbench_change",
  action: "notes.update",
  actorKind: "user",
  occurredAt: "2026-07-20T00:00:00.000Z",
  dedupeKey: "workbench_change:42"
};

describe("analyser internal ingest routes", () => {
  it("returns ACCOUNT_NOT_FOUND for an unknown core user", async () => {
    await withServer(makeDeps({
      findServiceAccountByCoreUserId: (async () => undefined) as AppDeps["findServiceAccountByCoreUserId"]
    }), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/internal/observations/ingest", {
        method: "POST",
        apiKey: "test-key",
        body: { coreUserId: "missing-user", observations: [observation] }
      });
      assert.equal(response.status, 404);
      assert.deepEqual(body, {
        message: "Analyser service account not found",
        code: "ACCOUNT_NOT_FOUND"
      });
    });
  });

  it("resolves the account and forwards the account id, observations, and machine", async () => {
    const machineId = "11111111-1111-4111-8111-111111111111";
    const result = { ingested: 1, duplicates: 0, rejected: {} };
    let received: unknown;
    await withServer(makeDeps({
      findServiceAccountByCoreUserId: (async (coreUserId) => ({
        id: "account-1",
        coreUserId,
        usernameSnapshot: "projector"
      })) as AppDeps["findServiceAccountByCoreUserId"],
      ingestObservations: (async (owner, observations, options) => {
        received = { owner, observations, options };
        return result;
      }) as AppDeps["ingestObservations"]
    }), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/internal/observations/ingest", {
        method: "POST",
        apiKey: "test-key",
        body: { coreUserId: "core-user-1", machineId, observations: [observation] }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, result);
      assert.deepEqual(received, {
        owner: "account-1",
        observations: [observation],
        options: { machineId }
      });
    });
  });

  it("applies the injected internal API-key middleware to both internal routes", async () => {
    let invocations = 0;
    const guard: RequestHandler = (req, res, next) => {
      invocations += 1;
      if (req.header("x-api-key") !== "allowed") {
        res.status(403).json({ message: "Forbidden" });
        return;
      }
      next();
    };
    await withServer(makeDeps({ requireInternalApiKey: guard }), async (baseUrl) => {
      const ingest = await requestJson(baseUrl, "/internal/observations/ingest", {
        method: "POST",
        body: { coreUserId: "core-user-1", observations: [observation] }
      });
      const settings = await requestJson(baseUrl, "/internal/settings/effective?coreUserId=core-user-1");
      assert.equal(ingest.response.status, 403);
      assert.equal(settings.response.status, 403);
      assert.equal(invocations, 2);
    });
  });
});
