import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";

process.env.JWT_SECRET ||= "test-secret";
process.env.JWT_ISSUER ||= "workbench-core-test";
process.env.JWT_EXPIRY_SECONDS ||= "900";

const {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  clearRefreshCookie,
  readRefreshCookie,
  requestIsHttps,
  setRefreshCookie
} = await import("../refreshCookie.js");

function req(headers: IncomingHttpHeaders, secure = false) {
  return { headers, secure } as { headers: IncomingHttpHeaders; secure: boolean };
}

describe("refresh cookie", () => {
  it("reads the refresh token out of a cookie header", () => {
    assert.equal(
      readRefreshCookie(req({ cookie: `${REFRESH_COOKIE_NAME}=abc123` })),
      "abc123"
    );
  });

  it("finds the cookie among unrelated ones regardless of position", () => {
    assert.equal(
      readRefreshCookie(req({ cookie: `theme=dark; ${REFRESH_COOKIE_NAME}=abc123; other=1` })),
      "abc123"
    );
    assert.equal(
      readRefreshCookie(req({ cookie: `other=1; ${REFRESH_COOKIE_NAME}=abc123` })),
      "abc123"
    );
  });

  it("does not confuse a cookie whose name merely ends with the same text", () => {
    assert.equal(readRefreshCookie(req({ cookie: `not_${REFRESH_COOKIE_NAME}=nope` })), undefined);
  });

  it("returns nothing when the cookie is absent or empty", () => {
    assert.equal(readRefreshCookie(req({})), undefined);
    assert.equal(readRefreshCookie(req({ cookie: "theme=dark" })), undefined);
    assert.equal(readRefreshCookie(req({ cookie: `${REFRESH_COOKIE_NAME}=` })), undefined);
  });

  it("decodes percent-encoded values without throwing on malformed input", () => {
    assert.equal(readRefreshCookie(req({ cookie: `${REFRESH_COOKIE_NAME}=a%20b` })), "a b");
    assert.equal(readRefreshCookie(req({ cookie: `${REFRESH_COOKIE_NAME}=100%` })), "100%");
  });

  it("treats a forwarded https proto as secure so the cookie keeps its Secure flag behind a proxy", () => {
    assert.equal(requestIsHttps(req({})), false);
    assert.equal(requestIsHttps(req({}, true)), true);
    assert.equal(requestIsHttps(req({ "x-forwarded-proto": "https" })), true);
    assert.equal(requestIsHttps(req({ "x-forwarded-proto": "https, http" })), true);
    assert.equal(requestIsHttps(req({ "x-forwarded-proto": "http" })), false);
  });

  it("issues an HttpOnly, path-scoped cookie so script cannot read it", () => {
    const calls: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    setRefreshCookie(
      req({ "x-forwarded-proto": "https" }),
      { cookie: (name: string, value: string, options: Record<string, unknown>) => calls.push({ name, value, options }) } as never,
      "refresh-token"
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, REFRESH_COOKIE_NAME);
    assert.equal(calls[0]?.value, "refresh-token");
    assert.equal(calls[0]?.options.httpOnly, true);
    assert.equal(calls[0]?.options.sameSite, "lax");
    assert.equal(calls[0]?.options.secure, true);
    assert.equal(calls[0]?.options.path, REFRESH_COOKIE_PATH);
    assert.ok(Number(calls[0]?.options.maxAge) > 0);
  });

  it("clears with matching attributes so the browser actually drops it", () => {
    const calls: Array<{ name: string; options: Record<string, unknown> }> = [];
    clearRefreshCookie(
      req({ "x-forwarded-proto": "https" }),
      { clearCookie: (name: string, options: Record<string, unknown>) => calls.push({ name, options }) } as never
    );

    assert.equal(calls[0]?.name, REFRESH_COOKIE_NAME);
    assert.equal(calls[0]?.options.path, REFRESH_COOKIE_PATH);
    assert.equal(calls[0]?.options.httpOnly, true);
    assert.equal(calls[0]?.options.secure, true);
  });
});
