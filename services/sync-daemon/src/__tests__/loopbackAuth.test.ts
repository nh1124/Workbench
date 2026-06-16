import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  LOOPBACK_AUTH_ERROR_CODE,
  LOOPBACK_AUTH_ERROR_MESSAGE,
  LOOPBACK_CORS_ERROR_CODE,
  LOOPBACK_CORS_ERROR_MESSAGE,
  isLoopbackOriginAllowed,
  loopbackAuthBypassed,
  parseLoopbackAllowedOrigins,
  requestHasValidLoopbackToken
} from "../index.js";

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
