// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { coreApi, localDaemonApi, maintenanceApi, notesApi, projectsApi } from "../../lib/api";
import type {
  MaintenanceQueueItem,
  MaintenanceQueueReason,
  MaintenanceQueueResult,
  ProjectMemoryEntry
} from "../../types/models";
import { MaintenancePage } from "../MaintenancePage";

const updatedAt = "2026-07-06T00:00:00.000Z";

function queueItem(overrides: Partial<MaintenanceQueueItem> = {}): MaintenanceQueueItem {
  return {
    id: "memory:memory-1",
    kind: "memory",
    projectId: "project-a",
    projectName: "Finance",
    resourceId: "memory-1",
    title: "Raw memory",
    excerpt: "Needs review before it becomes durable context.",
    reasons: ["raw"],
    authority: "agent_observed",
    lifecycleState: "raw",
    updatedAt,
    suggestedActions: ["confirm"],
    ...overrides
  };
}

function queueResult(
  items: MaintenanceQueueItem[],
  byReason?: Partial<Record<MaintenanceQueueReason, number>>
): MaintenanceQueueResult {
  return {
    items,
    totals: {
      byReason: byReason ?? { raw: items.length }
    }
  };
}

function memoryEntry(overrides: Partial<ProjectMemoryEntry> = {}): ProjectMemoryEntry {
  return {
    id: "memory-1",
    projectId: "project-a",
    kind: "observation",
    bodyMarkdown: "Confirmed durable context.",
    authority: "user_confirmed",
    status: "active",
    lifecycleState: "verified",
    createdByKind: "user",
    createdAt: updatedAt,
    updatedAt,
    ...overrides
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(initialEntry = "/maintenance") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <MaintenancePage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.spyOn(maintenanceApi, "queue").mockResolvedValue(queueResult([queueItem()]));
  vi.spyOn(maintenanceApi, "confirmMemory").mockResolvedValue(memoryEntry());
  vi.spyOn(maintenanceApi, "snoozeMemory").mockResolvedValue(memoryEntry());
  vi.spyOn(maintenanceApi, "confirmNote").mockResolvedValue({
    id: "note-1",
    title: "Curated note",
    content: "Confirmed note.",
    projectId: "project-a",
    projectName: "Finance",
    tags: [],
    lifecycleState: "curated",
    createdAt: updatedAt,
    updatedAt
  });
  vi.spyOn(maintenanceApi, "snoozeNote").mockResolvedValue({
    id: "note-1",
    title: "Snoozed note",
    content: "Snoozed note.",
    projectId: "project-a",
    projectName: "Finance",
    tags: [],
    lifecycleState: "triaged",
    reviewAfter: "2026-07-13T00:00:00.000Z",
    createdAt: updatedAt,
    updatedAt
  });
  vi.spyOn(maintenanceApi, "flag").mockResolvedValue(memoryEntry());
  vi.spyOn(projectsApi, "appendMemory").mockResolvedValue(memoryEntry());
  vi.spyOn(projectsApi, "archiveMemory").mockResolvedValue(memoryEntry({ status: "archived" }));
  vi.spyOn(projectsApi, "rebuildIndex").mockResolvedValue({
    projectId: "project-a",
    indexed: 1,
    primary: 1,
    secondary: 0,
    tombstoned: 0,
    staleLinksRemoved: 0
  });
  vi.spyOn(notesApi, "remove").mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__TAURI_INTERNALS__;
});

describe("MaintenancePage", () => {
  it("switches Analyser tabs while preserving the Activity URL query", async () => {
    renderPage("/analyser");

    expect(screen.getByRole("heading", { name: "Analyser" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByRole("heading", { name: "Activity is available in Workbench desktop" })).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/analyser?tab=activity");

    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getByTestId("location").textContent).toBe("/analyser");
  });

  it("lists capture summaries and publishes a selected day to Notes", async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(coreApi, "maintenanceUsageSummary").mockResolvedValue({
      since: "2026-06-09T00:00:00.000Z",
      until: "2026-07-09T00:00:00.000Z",
      truncation: { count: 2, bySection: [] },
      zeroHitQueries: [{ queryText: "unmatched", count: 3 }],
      topResources: [{ sourceService: "notes", resourceType: "note", resourceId: "note-1", count: 5 }]
    });
    vi.spyOn(localDaemonApi, "listCaptureSummaries").mockResolvedValue({
      items: [{
        summaryDate: "2026-07-09",
        generatedAt: "2026-07-09T18:00:00.000Z",
        sampleCount: 4,
        published: false
      }]
    });
    vi.spyOn(localDaemonApi, "publishCaptureSummary").mockResolvedValue({
      summaryDate: "2026-07-09",
      generatedAt: "2026-07-09T18:00:00.000Z",
      sampleCount: 4,
      published: true,
      noteResourceId: "note-capture-1",
      action: "create"
    });

    renderPage("/analyser?tab=activity");

    expect(await screen.findByRole("button", { name: "Open summary 2026-07-09" })).toBeTruthy();
    expect(screen.getByText("Truncation events")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save to Notes" }));

    await waitFor(() => expect(localDaemonApi.publishCaptureSummary).toHaveBeenCalledWith("2026-07-09"));
    expect(await screen.findByText("Published")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update Note" })).toBeTruthy();
  });

  it("shows the all-clear empty state when no queue items are waiting", async () => {
    vi.mocked(maintenanceApi.queue).mockResolvedValue(queueResult([], {}));
    renderPage();

    expect(await screen.findByRole("heading", { name: "All clear" })).toBeTruthy();
    expect(screen.getByText("No maintenance work is waiting right now.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Refresh" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Review memory, notes, briefs, and index drift across active Projects.")).toBeNull();
  });

  it("shows a filtered empty state and can clear filters", async () => {
    vi.mocked(maintenanceApi.queue).mockResolvedValue(queueResult([], {}));
    renderPage();

    expect(await screen.findByRole("heading", { name: "All clear" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "raw" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("heading", { name: "No matching items" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(maintenanceApi.queue).toHaveBeenLastCalledWith({
        kind: undefined,
        reason: undefined,
        projectId: undefined,
        cursor: undefined,
        limit: 20
      });
    });
  });

  it("loads queue items and sends filter query options to the API", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Raw memory" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "memory" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "raw" } });
    fireEvent.change(screen.getByLabelText("Project ID"), { target: { value: "project-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(maintenanceApi.queue).toHaveBeenLastCalledWith({
        kind: "memory",
        reason: "raw",
        projectId: "project-a",
        cursor: undefined,
        limit: 20
      });
    });
  });

  it("offers every maintenance reason in the filter", async () => {
    renderPage();

    const reasonSelect = screen.getByLabelText("Reason");
    const optionValues = Array.from(reasonSelect.querySelectorAll("option")).map((option) => option.value);

    expect(optionValues).toEqual([
      "",
      "raw",
      "expired",
      "unconfirmed",
      "conflict",
      "manual",
      "source_changed",
      "unused",
      "brief_unmaintained",
      "brief_oversized"
    ]);
  });

  it("removes a confirmed item optimistically", async () => {
    renderPage();

    const row = await screen.findByRole("article", { name: "Raw memory" });
    fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("article", { name: "Raw memory" })).toBeNull());
    expect(maintenanceApi.confirmMemory).toHaveBeenCalledWith("memory-1", {});
  });

  it("rolls the row back when an optimistic action fails", async () => {
    vi.mocked(maintenanceApi.confirmMemory).mockRejectedValueOnce(new Error("confirm failed"));
    renderPage();

    const row = await screen.findByRole("article", { name: "Raw memory" });
    fireEvent.click(within(row).getByRole("button", { name: "Confirm" }));

    expect((await screen.findByRole("alert")).textContent).toContain("confirm failed");
    expect(screen.getByRole("article", { name: "Raw memory" })).toBeTruthy();
  });

  it("visually distinguishes agent observed memory from user confirmed memory", async () => {
    vi.mocked(maintenanceApi.queue).mockResolvedValueOnce(queueResult([
      queueItem({
        id: "memory:agent-memory",
        resourceId: "agent-memory",
        title: "Agent memory",
        authority: "agent_observed"
      }),
      queueItem({
        id: "memory:user-memory",
        resourceId: "user-memory",
        title: "User memory",
        authority: "user_confirmed",
        lifecycleState: "verified"
      })
    ], { raw: 2 }));
    renderPage();

    await screen.findByRole("heading", { name: "Agent memory" });
    const agentBadge = screen.getByText("agent observed");
    const userBadge = screen.getByText("user confirmed");

    expect(agentBadge.className).toContain("authority-agent_observed");
    expect(userBadge.className).toContain("authority-user_confirmed");
    expect(agentBadge.className).not.toEqual(userBadge.className);
  });
});
