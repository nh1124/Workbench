// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { maintenanceApi, notesApi, projectsApi } from "../../lib/api";
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/maintenance"]}>
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
});

describe("MaintenancePage", () => {
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
