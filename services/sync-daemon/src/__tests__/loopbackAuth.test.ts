import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  LOOPBACK_AUTH_ERROR_CODE,
  LOOPBACK_AUTH_ERROR_MESSAGE,
  LOOPBACK_CORS_ERROR_CODE,
  LOOPBACK_CORS_ERROR_MESSAGE,
  isLoopbackOriginAllowed,
  isLocalProjectContextMutation,
  isSupportedLocalProjectContextWrite,
  loopbackAuthBypassed,
  parseLoopbackAllowedOrigins,
  requestHasValidLoopbackToken
} from "../index.js";
import { normalizeCoreUrl } from "../coreUrl.js";

function requestWithHeaders(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("loopback API token auth", () => {
  it("keeps loopback endpoints open when no token is configured", () => {
    assert.equal(requestHasValidLoopbackToken(requestWithHeaders({}), undefined), true);
    assert.equal(requestHasValidLoopbackToken(requestWithHeaders({}), ""), true);
  });

  it("accepts x-workbench-daemon-token when a token is configured", () => {
    assert.equal(
      requestHasValidLoopbackToken(requestWithHeaders({ "x-workbench-daemon-token": "secret" }), "secret"),
      true
    );
  });

  it("accepts Authorization bearer tokens when configured", () => {
    assert.equal(
      requestHasValidLoopbackToken(requestWithHeaders({ authorization: "Bearer secret" }), "secret"),
      true
    );
  });

  it("rejects missing or incorrect tokens when configured", () => {
    assert.equal(requestHasValidLoopbackToken(requestWithHeaders({}), "secret"), false);
    assert.equal(
      requestHasValidLoopbackToken(requestWithHeaders({ "x-workbench-daemon-token": "wrong" }), "secret"),
      false
    );
    assert.equal(
      requestHasValidLoopbackToken(requestWithHeaders({ authorization: "Bearer wrong" }), "secret"),
      false
    );
  });

  it("bypasses auth only for health and preflight requests", () => {
    assert.equal(loopbackAuthBypassed("/health", "GET"), true);
    assert.equal(loopbackAuthBypassed("/status", "GET"), false);
    assert.equal(loopbackAuthBypassed("/api/sync/status", "GET"), false);
    assert.equal(loopbackAuthBypassed("/conflicts", "OPTIONS"), true);
  });

  it("exposes a stable 401 payload contract", () => {
    assert.equal(LOOPBACK_AUTH_ERROR_CODE, "WORKBENCH_DAEMON_UNAUTHORIZED");
    assert.equal(LOOPBACK_AUTH_ERROR_MESSAGE, "Local daemon API token is required.");
  });

  it("keeps unsupported Project-context writes read-only and allows the E2 routes", () => {
    for (const [method, pathname] of [
      ["POST", "/api/projects/project-1/links"],
      ["DELETE", "/api/project-links/link-1"],
      ["POST", "/api/projects/project-1/index/rebuild"],
      ["POST", "/api/projects/project-1/context-summary/refresh"],
      ["POST", "/api/artifacts/items/item-1/projects"],
      ["DELETE", "/api/artifacts/items/item-1/projects/project-2"]
    ]) {
      assert.equal(isLocalProjectContextMutation(pathname, method), true, `${method} ${pathname}`);
    }
    for (const [method, pathname] of [
      ["PUT", "/api/projects/project-1/brief"],
      ["POST", "/api/projects/project-1/memories"],
      ["PATCH", "/api/project-memories/memory-1"],
      ["POST", "/api/projects/project-1/relations"],
      ["PATCH", "/api/project-relations/relation-1"],
      ["DELETE", "/api/project-relations/relation-1"]
    ]) {
      assert.equal(isSupportedLocalProjectContextWrite(pathname, method), true, `${method} ${pathname}`);
      assert.equal(isLocalProjectContextMutation(pathname, method), false, `${method} ${pathname}`);
    }
    assert.equal(isLocalProjectContextMutation("/api/projects/project-1/context", "GET"), false);
    assert.equal(isLocalProjectContextMutation("/api/projects/project-1", "PATCH"), false);
  });

  it("allows local browser origins by default and rejects remote origins", () => {
    assert.equal(isLoopbackOriginAllowed(undefined), true);
    assert.equal(isLoopbackOriginAllowed("http://localhost:5173"), true);
    assert.equal(isLoopbackOriginAllowed("http://127.0.0.1:1420"), true);
    assert.equal(isLoopbackOriginAllowed("http://[::1]:35780"), true);
    assert.equal(isLoopbackOriginAllowed("tauri://localhost"), true);
    assert.equal(isLoopbackOriginAllowed("http://tauri.localhost"), true);
    assert.equal(isLoopbackOriginAllowed("https://app.example.com"), false);
    assert.equal(isLoopbackOriginAllowed("null"), false);
  });

  it("supports explicit CORS origin allowlists", () => {
    const allowed = parseLoopbackAllowedOrigins("https://app.example.com/, http://localhost:5173");
    assert.deepEqual(allowed, ["https://app.example.com", "http://localhost:5173"]);
    assert.equal(isLoopbackOriginAllowed("https://app.example.com", allowed), true);
    assert.equal(isLoopbackOriginAllowed("http://localhost:5173", allowed), true);
    assert.equal(isLoopbackOriginAllowed("http://localhost:1420", allowed), false);
  });

  it("supports wildcard CORS origin allowlists when explicitly configured", () => {
    const allowed = parseLoopbackAllowedOrigins("*");
    assert.deepEqual(allowed, ["*"]);
    assert.equal(isLoopbackOriginAllowed("https://app.example.com", allowed), true);
    assert.equal(LOOPBACK_CORS_ERROR_CODE, "WORKBENCH_DAEMON_CORS_DENIED");
    assert.equal(LOOPBACK_CORS_ERROR_MESSAGE, "Origin is not allowed for the local daemon API.");
  });
});

describe("Core URL security", () => {
  it("requires HTTPS for remote Core URLs", () => {
    assert.equal(normalizeCoreUrl("https://core.example.com/"), "https://core.example.com");
    assert.throws(() => normalizeCoreUrl("http://core.example.com"), /https/);
  });

  it("allows HTTP only for local development Core URLs", () => {
    assert.equal(normalizeCoreUrl("http://localhost:3000/"), "http://localhost:3000");
    assert.equal(normalizeCoreUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
    assert.equal(normalizeCoreUrl("http://[::1]:3000/"), "http://[::1]:3000");
  });
});
