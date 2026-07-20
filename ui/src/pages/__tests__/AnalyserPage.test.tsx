// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { analyserApi, ApiError } from "../../lib/api";
import type {
  AnalyserActivityAggregate,
  AnalyserObservationRecord,
  AnalyserStatusResult
} from "../../types/models";
import { AnalyserPage } from "../AnalyserPage";

const updatedAt = "2026-07-20T04:00:00.000Z";

function statusResult(overrides: Partial<AnalyserStatusResult> = {}): AnalyserStatusResult {
  return {
    routines: [{
      key: "daily-activity",
      enabled: true,
      nextRunAt: "2026-07-21T00:00:00.000Z",
      lastCompletedAt: "2026-07-20T00:00:00.000Z",
      lastFailedAt: "2026-07-19T00:00:00.000Z",
      lastErrorSummary: "Temporary provider error",
      activeRun: {
        id: "run-1",
        holder: "agent-desktop",
        leaseExpiresAt: "2026-07-20T04:05:00.000Z"
      }
    }],
    hasOpenProposals: true,
    machines: [{
      id: "11111111-1111-4111-8111-111111111111",
      machineKey: "desktop-key",
      displayName: "Desktop PC",
      platform: "win32",
      registeredAt: updatedAt,
      lastSeenAt: updatedAt
    }],
    ...overrides
  };
}

function aggregateResult(): AnalyserActivityAggregate {
  return {
    totals: { sampleCount: 10, activeCount: 8, idleCount: 2, apps: { Code: 6, Browser: 4 } },
    days: [{
      date: "2026-07-20",
      machineId: null,
      sampleCount: 10,
      activeCount: 8,
      idleCount: 2,
      apps: { Code: 6, Browser: 4 }
    }]
  };
}

function observation(id: string, overrides: Partial<AnalyserObservationRecord> = {}): AnalyserObservationRecord {
  return {
    seq: id,
    id,
    source: "mcp_access",
    action: "notes.get",
    actorKind: "agent",
    occurredAt: updatedAt,
    resourceRefs: [{ service: "notes", resourceType: "note", resourceId: `note-${id}` }],
    metadata: { tool: "notes.get", result: "success" },
    dedupeKey: `dedupe-${id}`,
    receivedAt: updatedAt,
    expiresAt: "2026-08-19T04:00:00.000Z",
    ...overrides
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(initialEntry = "/analyser") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <AnalyserPage />
    </MemoryRouter>
  );
}

function currentRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  const format = (date: Date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  return { from: format(from), to: format(to) };
}

beforeEach(() => {
  vi.spyOn(analyserApi, "status").mockResolvedValue(statusResult());
  vi.spyOn(analyserApi, "machines").mockResolvedValue({ items: statusResult().machines });
  vi.spyOn(analyserApi, "activityAggregate").mockResolvedValue(aggregateResult());
  vi.spyOn(analyserApi, "observations").mockResolvedValue({ items: [] });
  vi.spyOn(analyserApi, "seedRoutines").mockResolvedValue(undefined);
  vi.spyOn(analyserApi, "projectorFlush").mockResolvedValue({ projected: 0, skipped: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AnalyserPage", () => {
  it("renders Overview routine status and machines", async () => {
    renderPage();

    expect(await screen.findByText("daily-activity")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Temporary provider error")).toBeTruthy();
    expect(screen.getByText("agent-desktop")).toBeTruthy();
    expect(screen.getByText("Desktop PC")).toBeTruthy();
    expect(screen.getByText("win32")).toBeTruthy();
    expect(screen.getByText("Open proposals need review")).toBeTruthy();
  });

  it("shows a friendly state for ANALYSER_NOT_CONFIGURED", async () => {
    vi.mocked(analyserApi.status).mockRejectedValue(new ApiError({
      backend: "core",
      method: "GET",
      path: "/api/analyser/status",
      url: "http://core/api/analyser/status",
      detail: "Analyser service is not configured",
      status: 503,
      code: "ANALYSER_NOT_CONFIGURED"
    }));

    renderPage();

    expect(await screen.findByRole("heading", { name: "Analyser service is not configured" })).toBeTruthy();
    expect(screen.getByText(/Configure the Analyser service/)).toBeTruthy();
  });

  it("switches to Activity through the query param and requests the computed range", async () => {
    const range = currentRange(7);
    renderPage();

    await screen.findByText("daily-activity");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByRole("heading", { name: "Server aggregate" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/analyser?tab=activity");
    await waitFor(() => {
      expect(analyserApi.activityAggregate).toHaveBeenCalledWith({ ...range, machineId: undefined });
      expect(analyserApi.observations).toHaveBeenCalledWith({
        ...range,
        machineId: undefined,
        source: undefined,
        limit: 50
      });
    });
  });

  it("renders observation metadata and references without rendering a body field", async () => {
    const row = {
      ...observation("1", { metadata: { workspace: "Workbench", version: 3 } }),
      body: "Sensitive prose must not render"
    };
    vi.mocked(analyserApi.observations).mockResolvedValue({ items: [row] });

    renderPage("/analyser?tab=activity");

    expect(await screen.findByText("notes.get")).toBeTruthy();
    expect(screen.getByText("workspace:")).toBeTruthy();
    expect(screen.getByText("Workbench")).toBeTruthy();
    expect(screen.getByText("version:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "notes/note/note-1" }).getAttribute("href")).toBe("/notes?noteId=note-1");
    expect(screen.queryByText("Sensitive prose must not render")).toBeNull();
    expect(screen.getByText(/bodies are never stored/i)).toBeTruthy();
  });

  it("appends the next observation page using nextCursor", async () => {
    vi.mocked(analyserApi.observations)
      .mockResolvedValueOnce({ items: [observation("1", { action: "first.action" })], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [observation("2", { action: "second.action" })] });
    const range = currentRange(7);

    renderPage("/analyser?tab=activity");

    expect(await screen.findByText("first.action")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("second.action")).toBeTruthy();
    expect(screen.getByText("first.action")).toBeTruthy();
    expect(analyserApi.observations).toHaveBeenLastCalledWith({
      ...range,
      machineId: undefined,
      source: undefined,
      limit: 50,
      cursor: "cursor-2"
    });
  });
});
