// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CORE_URL = "http://127.0.0.1:3000";

function authResponse(accessToken = "access-1") {
  return {
    user: { id: "user-1", username: "alice" },
    accessToken,
    refreshToken: "refresh-1",
    tokenType: "Bearer" as const,
    expiresInSeconds: 900
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * The session cache and the "storage is ready" latch are module state, and the
 * boot path runs once per module instance. Each test therefore needs a fresh
 * import, otherwise a session saved by an earlier test would still be resident.
 */
async function loadApi() {
  vi.resetModules();
  const services = await import("../../config/services");
  services.setWorkbenchCoreUrl(CORE_URL);
  return import("../api");
}

function requestsTo(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).endsWith(suffix));
}

/**
 * Browser sessions must leave nothing durable for an XSS payload to steal: the
 * refresh token lives in an HttpOnly cookie the page cannot read, and the access
 * token stays in memory only.
 */
describe("browser session storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes no token to localStorage when a session is saved", async () => {
    const api = await loadApi();
    await api.saveWorkbenchSession(authResponse());

    const dumped = JSON.stringify(window.localStorage);
    expect(dumped).not.toContain("refresh-1");
    expect(dumped).not.toContain("access-1");
    expect(window.localStorage.getItem("workbench-session")).toBeNull();
  });

  it("keeps the access token usable in memory for the current page", async () => {
    const api = await loadApi();
    await api.saveWorkbenchSession(authResponse());

    expect(api.readWorkbenchSession()?.username).toBe("alice");
    expect(new Headers(api.sessionAuthHeaders()).get("Authorization")).toBe("Bearer access-1");
  });

  it("discards a session written by an older build that stored tokens", async () => {
    window.localStorage.setItem(
      "workbench-session",
      JSON.stringify({ ...authResponse(), issuedAt: new Date().toISOString() })
    );

    const api = await loadApi();
    await api.saveWorkbenchSession(authResponse("access-2"));

    expect(window.localStorage.getItem("workbench-session")).toBeNull();
  });

  it("restores the session on boot by spending the refresh cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(authResponse("access-from-cookie")));
    vi.stubGlobal("fetch", fetchMock);

    const api = await loadApi();
    await api.initializeSessionStorage();

    const refreshCalls = requestsTo(fetchMock, "/auth/refresh");
    expect(refreshCalls).toHaveLength(1);
    const init = refreshCalls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    // The page has no refresh token to send; Core reads the cookie.
    expect(init.body).toBeUndefined();
    expect(api.readWorkbenchSession()?.username).toBe("alice");
  });

  it("stays signed out quietly when no refresh cookie is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "Invalid" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const api = await loadApi();
    await api.initializeSessionStorage();

    expect(api.readWorkbenchSession()).toBeUndefined();
  });

  it("asks Core to drop the cookie on sign-out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await loadApi();
    await api.saveWorkbenchSession(authResponse());
    await api.clearWorkbenchSession();

    expect(requestsTo(fetchMock, "/auth/logout")).toHaveLength(1);
    expect(api.readWorkbenchSession()).toBeUndefined();
  });
});
