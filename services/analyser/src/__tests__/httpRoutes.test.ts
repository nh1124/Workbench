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
process.env.JWT_SECRET ??= "analyser-http-route-test-secret";
process.env.JWT_ISSUER ??= "analyser-http-route-tests";
process.env.INTERNAL_API_KEY_ANALYSER ??= "analyser-http-route-test-key";

const { buildApp } = await import("../httpServer.js");
type AppDeps = import("../httpServer.js").AppDeps;

const authenticated: RequestHandler = (req, _res, next) => {
  req.authUser = {
    serviceAccountId: "owner-1",
    coreUserId: "core-user-1",
    usernameSnapshot: "route-user"
  };
  next();
};

const passThrough: RequestHandler = (_req, _res, next) => next();

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected route dependency call");
  };
  const deps = {
    requireUserAuth: authenticated,
    requireInternalApiKey: passThrough,
    provisionServiceAccount: unexpected,
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
  } as unknown as AppDeps;
  return Object.assign(deps, overrides);
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
  options: { method?: string; body?: unknown } = {}
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { response, body: await response.json() };
}

describe("analyser HTTP routes", () => {
  it("requires an auth context even when the injected middleware passes through", async () => {
    await withServer(makeDeps({ requireUserAuth: passThrough }), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/machines");
      assert.equal(response.status, 401);
      assert.deepEqual(body, { message: "Missing auth context" });
    });
  });

  it("returns the observation ingest store result", async () => {
    let received: unknown;
    const result = { ingested: 1, duplicates: 0, rejected: {} };
    await withServer(makeDeps({
      ingestObservations: (async (owner, observations, options) => {
        received = { owner, observations, options };
        return result;
      }) as AppDeps["ingestObservations"]
    }), async (baseUrl) => {
      const observation = {
        source: "pc_activity",
        action: "foreground_sample",
        actorKind: "user",
        occurredAt: "2026-07-20T00:00:00.000Z",
        dedupeKey: "event-1"
      };
      const machineId = "11111111-1111-4111-8111-111111111111";
      const { response, body } = await requestJson(baseUrl, "/observations/ingest", {
        method: "POST",
        body: { machineId, observations: [observation] }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, result);
      assert.deepEqual(received, {
        owner: "owner-1",
        observations: [observation],
        options: { machineId }
      });
    });
  });

  it("rejects producer-exclusive sources on the public ingest route", async () => {
    let ingestCalled = false;
    await withServer(makeDeps({
      ingestObservations: (async () => {
        ingestCalled = true;
        return { ingested: 0, duplicates: 0, rejected: {} };
      }) as AppDeps["ingestObservations"]
    }), async (baseUrl) => {
      for (const source of ["workbench_change", "mcp_access", "ui_access"]) {
        const { response, body } = await requestJson(baseUrl, "/observations/ingest", {
          method: "POST",
          body: {
            observations: [{
              source,
              action: "x",
              actorKind: "system",
              occurredAt: "2026-07-20T00:00:00.000Z",
              dedupeKey: `event-${source}`
            }]
          }
        });
        assert.equal(response.status, 400, `expected 400 for source ${source}`);
        assert.equal((body as { code?: string }).code, "INVALID_INPUT");
      }
      assert.equal(ingestCalled, false);
    });
  });

  it("wraps an empty routine claim as claim null", async () => {
    await withServer(makeDeps({
      claimDueRoutine: (async () => null) as AppDeps["claimDueRoutine"]
    }), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/routines/claim", {
        method: "POST",
        body: { holder: "agent-1" }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, { claim: null });
    });
  });

  it("uses the authenticated username as proposal resolver", async () => {
    let received: unknown;
    const proposal = { id: "22222222-2222-4222-8222-222222222222", status: "approved" };
    await withServer(makeDeps({
      resolveProposal: (async (owner, id, input) => {
        received = { owner, id, input };
        return proposal as never;
      }) as AppDeps["resolveProposal"]
    }), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, `/proposals/${proposal.id}/resolve`, {
        method: "POST",
        body: { status: "approved", provenance: "ui", expectedVersion: 3 }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(body, proposal);
      assert.deepEqual(received, {
        owner: "owner-1",
        id: proposal.id,
        input: {
          status: "approved",
          provenance: "ui",
          expectedVersion: 3,
          resolvedBy: "route-user"
        }
      });
    });
  });

  it("rejects an invalid run UUID before pulling", async () => {
    let called = false;
    await withServer(makeDeps({
      pullForRun: (async () => {
        called = true;
        return { items: [], pendingReadCursor: "0" };
      }) as AppDeps["pullForRun"]
    }), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/runs/not-a-uuid/pull", {
        method: "POST",
        body: { holder: "agent-1" }
      });
      assert.equal(response.status, 400);
      assert.equal((body as { code: string }).code, "INVALID_INPUT");
      assert.equal(called, false);
    });
  });

  it("returns JSON for an unknown route through the error handler", async () => {
    await withServer(makeDeps(), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/not-a-route");
      assert.equal(response.status, 404);
      assert.deepEqual(body, { message: "Route not found", code: "ROUTE_NOT_FOUND" });
    });
  });

  it("returns INVALID_INPUT for a zod body rejection", async () => {
    await withServer(makeDeps(), async (baseUrl) => {
      const { response, body } = await requestJson(baseUrl, "/machines/register", {
        method: "POST",
        body: { machineKey: "" }
      });
      assert.equal(response.status, 400);
      assert.equal((body as { code: string }).code, "INVALID_INPUT");
    });
  });
});
