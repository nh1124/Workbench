import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LbsClient } from "../lbsClient.js";

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

const originalFetch = globalThis.fetch;

function installFetchMock(handler: (call: FetchCall) => Promise<Response>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LbsClient", () => {
  it("sends bearer token and query params for listTasks", async () => {
    const calls = installFetchMock(async () =>
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const client = new LbsClient(
      {
        baseUrl: "https://lbs.example.com",
        timezone: "Asia/Tokyo"
      },
      "user-token"
    );

    await client.listTasks("inbox", true);

    assert.equal(calls.length, 1);
    const url = String(calls[0].input);
    assert.match(url, /\/tasks\?/);
    assert.match(url, /context=inbox/);
    assert.match(url, /active=true/);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer user-token");
    assert.equal(headers["X-Timezone"], "Asia/Tokyo");
  });

  it("uses shared API key for allowSharedAuth endpoints", async () => {
    const calls = installFetchMock(async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const client = new LbsClient({
      baseUrl: "https://lbs.example.com",
      timezone: "Asia/Tokyo",
      apiKey: "shared-key"
    });

    await client.authMe();

    assert.equal(calls.length, 1);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["X-API-KEY"], "shared-key");
    assert.equal(headers.Authorization, undefined);
  });

  it("throws clear error when user token is missing for task endpoints", async () => {
    const client = new LbsClient({
      baseUrl: "https://lbs.example.com",
      timezone: "Asia/Tokyo"
    });

    await assert.rejects(
      () => client.listTasks(),
      /LBS user token is missing/
    );
  });

  it("wraps network failures as LBS_UNREACHABLE", async () => {
    installFetchMock(async () => {
      throw new Error("connect ETIMEDOUT");
    });
    const client = new LbsClient(
      {
        baseUrl: "https://lbs.example.com",
        timezone: "Asia/Tokyo"
      },
      "user-token"
    );

    await assert.rejects(
      () => client.listTasks(),
      /LBS_UNREACHABLE/
    );
  });

  it("uploads CSV using multipart form data for LBS compatibility", async () => {
    const calls = installFetchMock(async () =>
      new Response(JSON.stringify({ imported: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    const client = new LbsClient(
      {
        baseUrl: "https://lbs.example.com",
        timezone: "Asia/Tokyo"
      },
      "user-token"
    );

    await client.uploadTasksCsv("task_name,context\nA,inbox\n");

    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].input), "https://lbs.example.com/tasks/upload-csv");
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["Content-Type"], undefined);
    assert.ok(calls[0].init?.body instanceof FormData);
  });
});
