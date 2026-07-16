// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  artifactsApi,
  formatApiErrorMessage,
  localDaemonSupportsWriteRequest,
  projectsApi,
  taskSubtasksApi,
  tasksApi
} from "../api";
import {
  clearNotifications,
  getNotifications
} from "../notificationService";
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
    clearNotifications();
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

  it("rejects empty occurrence-date path segments before building subtask requests", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => taskSubtasksApi.list("task-1", "")).toThrow("Subtask occurrence date must be a valid YYYY-MM-DD date.");
    expect(() => taskSubtasksApi.create("task-1", "   ", "Child")).toThrow("Subtask occurrence date must be a valid YYYY-MM-DD date.");
    expect(() => taskSubtasksApi.update("task-1", "", "subtask-1", { isDone: true })).toThrow("Subtask occurrence date must be a valid YYYY-MM-DD date.");
    expect(() => taskSubtasksApi.remove("task-1", "", "subtask-1")).toThrow("Subtask occurrence date must be a valid YYYY-MM-DD date.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty occurrence mutation dates before sending a request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => tasksApi.completeOccurrence("task-1", "", "done")).toThrow("Occurrence target date must be a valid YYYY-MM-DD date.");
    expect(() => tasksApi.moveOccurrence("task-1", "", "2026-07-14")).toThrow("Occurrence source date must be a valid YYYY-MM-DD date.");
    expect(() => tasksApi.skipOccurrenceException("task-1", " ")).toThrow("Occurrence target date must be a valid YYYY-MM-DD date.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches daemon-supported writes by method and pathname only", () => {
    expect(localDaemonSupportsWriteRequest("/api/notes?projectId=project-1", { method: "POST" })).toBe(true);
    expect(localDaemonSupportsWriteRequest("/api/artifacts/items/item-1?version=2", { method: "PATCH" })).toBe(true);
    expect(localDaemonSupportsWriteRequest("/api/tasks/today/task-1?scheduledDate=2026-07-13", { method: "DELETE" })).toBe(true);
    expect(localDaemonSupportsWriteRequest("/api/tasks/task-1/attachments", { method: "POST" })).toBe(true);
    expect(localDaemonSupportsWriteRequest("/api/tasks/task-1/attachments/attachment-1", { method: "PUT" })).toBe(true);
    expect(localDaemonSupportsWriteRequest("/api/artifacts/items/item-1/content-patch", { method: "PATCH" })).toBe(false);
    expect(localDaemonSupportsWriteRequest("/api/artifacts/items/item-1/projects", { method: "POST" })).toBe(false);
    expect(localDaemonSupportsWriteRequest("/api/artifacts/items/item-1/projects/project-1", { method: "DELETE" })).toBe(false);
    expect(localDaemonSupportsWriteRequest("/api/projects/project-1/brief", { method: "PUT" })).toBe(false);
  });

  it("routes allowlisted mutations directly to local while offline and dedupes save notifications", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    let now = 4_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      taskId: "task-1",
      targetDate: "2026-07-13",
      status: "done"
    })));
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.completeOccurrence("task-1", "2026-07-13", "done");
    now += 6_000;
    await tasksApi.completeOccurrence("task-1", "2026-07-14", "done");

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:35780/api/tasks/task-1/occurrences/complete",
      "http://127.0.0.1:35780/api/tasks/task-1/occurrences/complete"
    ]);
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(true);
    expect(getNotifications()).toMatchObject([{
      title: "Offline Save",
      message: "Saved locally. Changes will sync when the server is reachable.",
      level: "info"
    }]);
  });

  it("does not show an info notification for writes accepted in explicit local mode", async () => {
    setWorkbenchLocalRoutingMode("local");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      taskId: "task-1",
      targetDate: "2026-07-13",
      status: "done"
    })));

    await tasksApi.completeOccurrence("task-1", "2026-07-13", "done");

    expect(getNotifications()).toEqual([]);
  });

  it("falls back to local for an allowlisted mutation after a Core network failure", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("core offline"))
      .mockResolvedValueOnce(jsonResponse({ taskId: "task-1", targetDate: "2026-07-13", status: "done" }));
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.completeOccurrence("task-1", "2026-07-13", "done");

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:3000/api/tasks/task-1/occurrences/complete",
      "http://127.0.0.1:35780/api/tasks/task-1/occurrences/complete"
    ]);
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(true);
  });

  it("keeps allowlist-excluded mutations on Core while offline", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("core offline"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await projectsApi.addRelation("project-1", {
      targetProjectId: "project-2",
      relationType: "related",
      directionality: "bidirectional"
    })
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://127.0.0.1:3000/api/projects/project-1/relations"
    );
    expect(error).toMatchObject({ backend: "core", method: "POST", networkFailure: true });
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(false);
  });

  it("does not fall back for an allowlisted mutation when Core returns 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: "Core failed" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const error = await tasksApi.completeOccurrence("task-1", "2026-07-13", "done")
      .catch((caught: unknown) => caught);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "http://127.0.0.1:3000/api/tasks/task-1/occurrences/complete"
    );
    expect(error).toMatchObject({ backend: "core", method: "POST", status: 500, networkFailure: false });
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

  it("makes a successful local mutation sticky for later reads after the browser is online", async () => {
    let online = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taskId: "task-1", targetDate: "2026-07-13", status: "done" }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await tasksApi.completeOccurrence("task-1", "2026-07-13", "done");
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(true);
    online = true;
    await tasksApi.list();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:35780/api/tasks/task-1/occurrences/complete",
      "http://127.0.0.1:35780/api/tasks"
    ]);
  });

  it("clears sticky auto fallback after a successful Core-only mutation", async () => {
    setWorkbenchAutoLocalFallbackActive(true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ itemId: "item-1", projects: [] }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await artifactsApi.linkProject("item-1", { projectId: "project-1" });
    expect(getWorkbenchAutoLocalFallbackActive()).toBe(false);
    await tasksApi.list();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:3000/api/artifacts/items/item-1/projects",
      "http://127.0.0.1:3000/api/tasks"
    ]);
  });
});
