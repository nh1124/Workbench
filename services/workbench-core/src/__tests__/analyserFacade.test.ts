import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

process.env.NOTES_SERVICE_URL ||= "http://notes.test";
process.env.ARTIFACTS_SERVICE_URL ||= "http://artifacts.test";
process.env.TASKS_SERVICE_URL ||= "http://tasks.test";
process.env.IMAGES_SERVICE_URL ||= "http://images.test";
process.env.MINDMAPS_SERVICE_URL ||= "http://mindmaps.test";
process.env.WBS_SERVICE_URL ||= "http://wbs.test";
process.env.ANALYSER_SERVICE_URL ||= "http://analyser.test";
process.env.INTERNAL_API_KEY_NOTES ||= "notes-test-key";
process.env.INTERNAL_API_KEY_ARTIFACTS ||= "artifacts-test-key";
process.env.INTERNAL_API_KEY_IMAGES ||= "images-test-key";
process.env.INTERNAL_API_KEY_MINDMAPS ||= "mindmaps-test-key";
process.env.INTERNAL_API_KEY_WBS ||= "wbs-test-key";
process.env.INTERNAL_API_KEY_ANALYSER ||= "analyser-test-key";
process.env.JWT_SECRET ||= "test-secret-that-is-long-enough";
process.env.JWT_ISSUER ||= "workbench-test";
process.env.JWT_EXPIRY_SECONDS ||= "3600";
process.env.CORE_DB_HOST ||= "127.0.0.1";
process.env.CORE_DB_PORT ||= "5432";
process.env.CORE_DB_NAME ||= "workbench-test-unused";
process.env.CORE_DB_USER ||= "workbench-test-unused";
process.env.CORE_DB_PASSWORD ||= "workbench-test-unused";

const [
  { analyserClient, InternalServiceError, serviceBaseUrls },
  { forwardAnalyserRequest, pickAnalyserQuery, requireAnalyserConfigured }
] = await Promise.all([
  import("../internalClients.js"),
  import("../httpServer.js")
]);

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

after(() => {
  globalThis.fetch = originalFetch;
});

describe("analyser internal client", () => {
  it("constructs claim, run pull, and publication lookup requests with bearer auth", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      return jsonResponse({ status: "ok" });
    };

    await analyserClient.claimRoutine("claim-token", { holder: "agent" });
    await analyserClient.pullRun("pull-token", "run/id", { holder: "agent", limit: 25 });
    await analyserClient.findPublication("find-token", {
      sourceKind: "summary",
      sourceId: "summary-1",
      targetKind: "note",
      contentHash: "abcdef12"
    });

    assert.equal(requests[0]?.url.href, "http://analyser.test/routines/claim");
    assert.equal(requests[0]?.init?.method, "POST");
    assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), "Bearer claim-token");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { holder: "agent" });

    assert.equal(requests[1]?.url.href, "http://analyser.test/runs/run%2Fid/pull");
    assert.equal(new Headers(requests[1]?.init?.headers).get("authorization"), "Bearer pull-token");

    assert.equal(requests[2]?.url.pathname, "/publications/find");
    assert.deepEqual(Object.fromEntries(requests[2]?.url.searchParams ?? []), {
      sourceKind: "summary",
      sourceId: "summary-1",
      targetKind: "note",
      contentHash: "abcdef12"
    });
    assert.equal(new Headers(requests[2]?.init?.headers).get("authorization"), "Bearer find-token");
  });

  it("uses the analyser internal key for provisioning and preserves downstream errors", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: new URL(String(input)), init });
      if (requests.length === 2) return jsonResponse({ message: "conflict", code: "VERSION_CONFLICT" }, 409);
      return jsonResponse({ status: "ok", service: "analyser" }, 201);
    };

    await analyserClient.provisionAccount({ coreUserId: "user-1", username: "user@example.test" });
    assert.equal(requests[0]?.url.href, "http://analyser.test/internal/accounts");
    assert.equal(new Headers(requests[0]?.init?.headers).get("x-api-key"), "analyser-test-key");
    assert.equal(new Headers(requests[0]?.init?.headers).has("authorization"), false);

    await assert.rejects(
      analyserClient.updateRoutine("token", "routine", { expectedVersion: 1 }),
      (error: unknown) => error instanceof InternalServiceError
        && error.service === "analyser"
        && error.status === 409
        && error.body.includes("VERSION_CONFLICT")
    );
  });
});

describe("analyser HTTP facade helpers", () => {
  it("returns the analyser-specific 503 response when the service is not configured", () => {
    const mutableBaseUrls = serviceBaseUrls as { analyser?: string };
    const originalAnalyserUrl = mutableBaseUrls.analyser;
    let status: number | undefined;
    let body: unknown;
    const response = {
      status(value: number) {
        status = value;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      }
    };

    try {
      mutableBaseUrls.analyser = undefined;
      assert.equal(requireAnalyserConfigured(response as never), false);
      assert.equal(status, 503);
      assert.deepEqual(body, {
        message: "Analyser service is not configured",
        code: "ANALYSER_NOT_CONFIGURED"
      });
    } finally {
      mutableBaseUrls.analyser = originalAnalyserUrl;
    }
  });

  it("provisions before delegation and forwards the auth context access token", async () => {
    const events: string[] = [];
    const authContext = {
      userId: "user-1",
      username: "user@example.test",
      accessToken: "forwarded-token"
    };

    const result = await forwardAnalyserRequest(
      authContext,
      async (token) => {
        events.push(`delegate:${token}`);
        return { status: "ok" };
      },
      async (context) => {
        events.push(`provision:${context.userId}`);
      }
    );

    assert.deepEqual(events, ["provision:user-1", "delegate:forwarded-token"]);
    assert.deepEqual(result, { status: "ok" });
  });

  it("only copies whitelisted string query parameters", () => {
    const query = pickAnalyserQuery({
      sourceKind: "summary",
      sourceId: "summary-1",
      targetKind: "note",
      contentHash: "abcdef12",
      unknown: "must-not-pass",
      limit: ["10", "20"]
    } as never, ["sourceKind", "sourceId", "targetKind", "contentHash", "limit"]);

    assert.deepEqual(query, {
      sourceKind: "summary",
      sourceId: "summary-1",
      targetKind: "note",
      contentHash: "abcdef12"
    });
  });
});
