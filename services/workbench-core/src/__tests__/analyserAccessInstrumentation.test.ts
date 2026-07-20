import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, it } from "node:test";
import type express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.NOTES_SERVICE_URL ??= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ??= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ??= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ??= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ??= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ??= "http://wbs.test";
process.env.ANALYSER_SERVICE_URL ??= "http://analyser.test";
process.env.INTERNAL_API_KEY_ANALYSER ??= "analyser-test-key";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ??= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ??= "3600";

const instrumentation = await import("../analyserAccessInstrumentation.js");
const { InternalServiceError } = await import("../internalClients.js");
type InstrumentationDeps = import("../analyserAccessInstrumentation.js").AnalyserAccessInstrumentationDeps;

type ToolHandler = (...args: unknown[]) => unknown;
type ToolConfig = { annotations?: { readOnlyHint?: boolean } };
type IngestBody = { coreUserId: string; observations: unknown[] };

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _config: ToolConfig, handler: ToolHandler): Record<string, never> {
    this.handlers.set(name, handler);
    return {};
  }
}

function makeDeps(options: {
  mcpAccess?: "off" | "mutations" | "reads_and_mutations";
  uiAccess?: "off" | "mutations" | "reads_and_mutations";
  ingest?: (body: IngestBody) => Promise<void>;
  getSettings?: InstrumentationDeps["getEffectiveSettings"];
  resolveCoreUserId?: InstrumentationDeps["resolveCoreUserId"];
} = {}): { deps: Partial<InstrumentationDeps>; ingests: IngestBody[]; errors: string[] } {
  const ingests: IngestBody[] = [];
  const errors: string[] = [];
  let uuid = 0;
  const deps: Partial<InstrumentationDeps> = {
    analyserBaseUrl: "http://analyser.test",
    getEffectiveSettings: options.getSettings ?? (async () => ({
      settings: {
        mcpAccess: options.mcpAccess ?? "reads_and_mutations",
        uiAccess: options.uiAccess ?? "reads_and_mutations"
      }
    })),
    ingestObservations: async (body) => {
      ingests.push(body as IngestBody);
      await options.ingest?.(body as IngestBody);
      return { ingested: body.observations.length, duplicates: 0, rejected: {} };
    },
    logger: {
      error: (_message, details) => { errors.push(String(details?.message)); }
    },
    randomUUID: () => `uuid-${++uuid}`,
    resolveCoreUserId: options.resolveCoreUserId ?? (() => "user-1")
  };
  return { deps, ingests, errors };
}

function instrumentFakeServer(
  deps: Partial<InstrumentationDeps>,
  coreUserId = "user-1"
): FakeMcpServer {
  const server = new FakeMcpServer();
  const returned = instrumentation.instrumentMcpServer(
    server as unknown as McpServer,
    { accessToken: "access-token", coreUserId },
    deps
  );
  assert.equal(returned, server as unknown as McpServer);
  return server;
}

async function runHttp(
  deps: Partial<InstrumentationDeps>,
  method: string,
  path: string,
  statusCode = 200
): Promise<void> {
  const middleware = instrumentation.analyserHttpAccessMiddleware(deps);
  const req = {
    method,
    path,
    header: () => undefined
  } as unknown as express.Request;
  const res = new EventEmitter() as express.Response & EventEmitter;
  res.statusCode = statusCode;
  let nextCalls = 0;
  middleware(req, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  res.emit("finish");
}

function observations(ingests: IngestBody[]): Record<string, unknown>[] {
  return ingests.flatMap((body) => body.observations) as Record<string, unknown>[];
}

beforeEach(() => instrumentation._resetForTests());
afterEach(() => instrumentation._resetForTests());

describe("MCP access instrumentation", () => {
  it("observes reads, mutations, and unchanged errors while excluding analyser/auth/insights tools", async () => {
    const { deps, ingests } = makeDeps();
    const server = instrumentFakeServer(deps);
    const expectedError = new TypeError("boom");
    server.registerTool("notes.get", { annotations: { readOnlyHint: true } }, async () => ({ ok: true }));
    server.registerTool("notes.update", {}, async () => ({ ok: true }));
    server.registerTool("tasks.fail", {}, async () => { throw expectedError; });
    server.registerTool("analyser.status.get", { annotations: { readOnlyHint: true } }, async () => ({}));
    server.registerTool("auth.login", {}, async () => ({}));
    server.registerTool("insights.activity", {}, async () => ({}));

    await server.handlers.get("notes.get")?.({
      projectId: "project-1",
      body: "must not be observed",
      token: "secret"
    });
    await server.handlers.get("notes.update")?.({ payload: { private: true } });
    await assert.rejects(
      Promise.resolve(server.handlers.get("tasks.fail")?.({ request: "private" })),
      (error) => error === expectedError
    );
    await server.handlers.get("analyser.status.get")?.({});
    await server.handlers.get("auth.login")?.({});
    await server.handlers.get("insights.activity")?.({});
    await instrumentation.flushAccessObservationsNow();

    const captured = observations(ingests);
    assert.equal(captured.length, 3);
    assert.deepEqual(captured.map((item) => item.action), [
      "tool:notes.get",
      "tool:notes.update",
      "tool:tasks.fail"
    ]);
    assert.equal(captured[0].projectId, "project-1");
    const readMetadata = captured[0].metadata as Record<string, unknown>;
    assert.equal(readMetadata.kind, "read");
    assert.deepEqual(Object.keys(readMetadata).sort(), ["durationMs", "kind", "ok", "tool"]);
    assert.equal(JSON.stringify(readMetadata).includes("private"), false);
    assert.equal(JSON.stringify(readMetadata).includes("secret"), false);
    const mutationMetadata = captured[1].metadata as Record<string, unknown>;
    assert.equal(mutationMetadata.kind, "mutation");
    const errorMetadata = captured[2].metadata as Record<string, unknown>;
    assert.equal(errorMetadata.ok, false);
    assert.equal(errorMetadata.errorClass, "TypeError");
    assert.deepEqual(Object.keys(errorMetadata).sort(), ["durationMs", "errorClass", "kind", "ok", "tool"]);
  });

  it("honors mutations-only and off MCP settings", async () => {
    const mutationsOnly = makeDeps({ mcpAccess: "mutations" });
    const server = instrumentFakeServer(mutationsOnly.deps, "mutations-user");
    server.registerTool("notes.get", { annotations: { readOnlyHint: true } }, async () => ({}));
    server.registerTool("notes.create", {}, async () => ({}));
    await server.handlers.get("notes.get")?.({});
    await server.handlers.get("notes.create")?.({});
    await instrumentation.flushAccessObservationsNow();
    assert.deepEqual(observations(mutationsOnly.ingests).map((item) => item.action), ["tool:notes.create"]);

    const off = makeDeps({ mcpAccess: "off" });
    const offServer = instrumentFakeServer(off.deps, "off-user");
    offServer.registerTool("notes.create", {}, async () => ({}));
    await offServer.handlers.get("notes.create")?.({});
    await instrumentation.flushAccessObservationsNow();
    assert.equal(off.ingests.length, 0);
  });
});

describe("HTTP access instrumentation", () => {
  it("observes authenticated API access with normalized paths and exact metadata", async () => {
    const { deps, ingests } = makeDeps();
    await runHttp(deps, "GET", "/api/notes/123e4567-e89b-42d3-a456-426614174000", 200);
    await instrumentation.flushAccessObservationsNow();

    const captured = observations(ingests);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, "http:GET /api/notes/:id");
    assert.equal(captured[0].actorKind, "user");
    assert.deepEqual(captured[0].metadata, {
      route: "/api/notes/:id",
      method: "GET",
      kind: "read",
      status: 200,
      ok: true,
      durationMs: (captured[0].metadata as Record<string, unknown>).durationMs
    });
    assert.deepEqual(Object.keys(captured[0].metadata as Record<string, unknown>).sort(), [
      "durationMs", "kind", "method", "ok", "route", "status"
    ]);
  });

  it("skips excluded routes and OPTIONS", async () => {
    const { deps, ingests } = makeDeps();
    await runHttp(deps, "GET", "/api/analyser/status");
    await runHttp(deps, "GET", "/health");
    await runHttp(deps, "OPTIONS", "/api/notes");
    await runHttp(deps, "GET", "/api/account/token/rotate");
    await instrumentation.flushAccessObservationsNow();
    assert.equal(ingests.length, 0);
  });

  it("honors the UI access gate and skips unauthenticated requests", async () => {
    const mutationsOnly = makeDeps({ uiAccess: "mutations" });
    await runHttp(mutationsOnly.deps, "GET", "/api/notes");
    await runHttp(mutationsOnly.deps, "POST", "/api/notes", 201);
    await instrumentation.flushAccessObservationsNow();
    assert.deepEqual(observations(mutationsOnly.ingests).map((item) => item.action), ["http:POST /api/notes"]);

    const unauthenticated = makeDeps({ resolveCoreUserId: () => undefined });
    await runHttp(unauthenticated.deps, "POST", "/api/notes", 201);
    await instrumentation.flushAccessObservationsNow();
    assert.equal(unauthenticated.ingests.length, 0);
  });
});

describe("access observation queue", () => {
  it("flushes a per-user batch at 50 observations", async () => {
    const { deps, ingests } = makeDeps();
    const server = instrumentFakeServer(deps);
    server.registerTool("notes.update", {}, async () => ({}));
    for (let index = 0; index < 50; index += 1) {
      await server.handlers.get("notes.update")?.({ index });
    }
    await instrumentation.flushAccessObservationsNow();
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0].observations.length, 50);
  });

  it("drops a failed ingest batch without throwing or retrying", async () => {
    const setup = makeDeps({ ingest: async () => { throw new Error("ingest unavailable"); } });
    const server = instrumentFakeServer(setup.deps);
    server.registerTool("notes.update", {}, async () => ({}));
    await server.handlers.get("notes.update")?.({});
    await instrumentation.flushAccessObservationsNow();
    await instrumentation.flushAccessObservationsNow();
    assert.equal(setup.ingests.length, 1);
    assert.deepEqual(setup.errors, ["ingest unavailable"]);
  });

  it("caches a 404 no-account marker and suppresses events", async () => {
    let settingsCalls = 0;
    const setup = makeDeps({
      getSettings: async () => {
        settingsCalls += 1;
        throw new InternalServiceError("analyser", 404, "account missing");
      }
    });
    const server = instrumentFakeServer(setup.deps);
    server.registerTool("notes.update", {}, async () => ({}));
    await server.handlers.get("notes.update")?.({});
    await server.handlers.get("notes.update")?.({});
    await instrumentation.flushAccessObservationsNow();
    assert.equal(settingsCalls, 1);
    assert.equal(setup.ingests.length, 0);
    assert.equal(setup.errors.length, 0);
  });
});
