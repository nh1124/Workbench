import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  LOOPBACK_AUTH_ERROR_CODE,
  LOOPBACK_AUTH_ERROR_MESSAGE,
  loopbackAuthBypassed,
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
});
