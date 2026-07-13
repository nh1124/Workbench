// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  formatApiErrorMessage,
  tasksApi
} from "../api";
import {
  getWorkbenchAutoLocalFallbackActive,
  setWorkbenchAutoLocalFallbackActive,
  setWorkbenchCoreUrl,
  setWorkbenchLocalDaemonUrl,
  setWorkbenchLocalRoutingMode
} from "../../config/services";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("API error detail and auto routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setWorkbenchCoreUrl("http://127.0.0.1:3000");
    setWorkbenchLocalDaemonUrl("http://127.0.0.1:35780");
    setWorkbenchLocalRoutingMode("auto");
    setWorkbenchAutoLocalFallbackActive(false);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("carries backend, method, path, status, and parsed response message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      message: "LBS account token not provisioned",
      code: "LBS_TOKEN_MISSING"
    }, 403)));

    const error = await tasksApi.completeOccurrence("task 1", "2026-07-13", "done")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      backend: "core",
      method: "POST",
      path: "/api/tasks/task%201/occurrences/complete",
      status: 403,
      responseMessage: "LBS account token not provisioned"
    });
    expect(formatApiErrorMessage("Failed to update occurrence", error)).toBe(
      "Failed to update occurrence (core POST /api/tasks/task%201/occurrences/complete, 403): LBS account token not provisioned"
    );
  });

  it("never falls back to local for mutations", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("core offline"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await tasksApi.completeOccurrence("task-1", "2026-07-13", "done")
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:3000/api/tasks/task-1/occurrences/complete");
    expect(error).toMatchObject({ backend: "core", method: "POST", networkFailure: true });
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(false);
  });

  it("reports local backend details for explicit local failures", async () => {
    setWorkbenchLocalRoutingMode("local");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "daemon rejected request" }, 503)));

    const error = await tasksApi.list().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      backend: "local",
      method: "GET",
      path: "/api/tasks",
      status: 503,
      responseMessage: "daemon rejected request"
    });
  });

  it("adds request detail to raw facade response failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ message: "export unavailable" }, 502)));

    const error = await tasksApi.exportCsv().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      backend: "core",
      method: "GET",
      path: "/api/tasks/export",
      status: 502,
      responseMessage: "export unavailable"
    });
  });

  it("makes a successful GET fallback sticky for later reads", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("core offline"))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.list();
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(true);
    await tasksApi.list();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:3000/api/tasks",
      "http://127.0.0.1:35780/api/tasks",
      "http://127.0.0.1:35780/api/tasks"
    ]);
  });

  it("clears sticky auto fallback after a successful Core mutation", async () => {
    setWorkbenchAutoLocalFallbackActive(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: "task-1", targetDate: "2026-07-13", status: "done" }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.completeOccurrence("task-1", "2026-07-13", "done");
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(false);
    await tasksApi.list();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:3000/api/tasks/task-1/occurrences/complete",
      "http://127.0.0.1:3000/api/tasks"
    ]);
  });
});
