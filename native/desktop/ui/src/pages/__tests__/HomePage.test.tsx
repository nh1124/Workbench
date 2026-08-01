// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RECENT_ARTIFACTS_STORAGE_KEY, type RecentArtifact } from "../../artifacts/utils/recents";
import { projectsApi, tasksApi } from "../../lib/api";
import type { TodayTask } from "../../types/models";
import { HomePage } from "../HomePage";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/artifacts" element={<div>Artifacts page</div>} />
        <Route path="/tasks" element={<div>Tasks page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function storeRecents(entries: RecentArtifact[]) {
  window.localStorage.setItem(RECENT_ARTIFACTS_STORAGE_KEY, JSON.stringify(entries));
}

function makeTodayTask(overrides: Partial<TodayTask> = {}): TodayTask {
  return {
    id: "task-1",
    title: "Refine project context retrieval",
    notes: "",
    context: "project-a",
    contextName: "Workbench",
    status: "todo",
    isLocked: false,
    baseLoadScore: 1,
    recurrence: "ONCE",
    active: true,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
    occurrenceDate: "2026-07-25",
    scheduledDate: "2026-07-25",
    startTime: "10:00",
    ...overrides
  };
}

beforeEach(() => {
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  vi.spyOn(tasksApi, "list").mockResolvedValue([]);
  vi.spyOn(tasksApi, "todayList").mockResolvedValue([]);
  vi.spyOn(tasksApi, "projects").mockResolvedValue([]);
  vi.spyOn(projectsApi, "list").mockResolvedValue({ items: [] });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      current: { temperature_2m: 22, weather_code: 0 },
      hourly: { time: [], temperature_2m: [], weather_code: [] }
    })
  } as Response));
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HomePage recent artifacts", () => {
  it("renders the latest recent artifacts and links to the artifact deep link", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    storeRecents([
      {
        itemId: "note-1",
        title: "Alpha Note",
        kind: "note",
        path: "notes/alpha.md",
        projectId: "project-a",
        at: twoHoursAgo
      }
    ]);

    renderPage();

    expect(await screen.findByRole("heading", { name: "Recent work" })).toBeTruthy();
    expect(screen.getByText("Alpha Note")).toBeTruthy();
    expect(screen.getByText("notes/alpha.md")).toBeTruthy();
    expect(screen.getByText("2h")).toBeTruthy();

    const link = screen.getByText("Alpha Note").closest("a");
    expect(link?.getAttribute("href")).toBe("/artifacts?item=note-1");
    fireEvent.click(link!);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/artifacts?item=note-1");
    });
  });

  it("shows a quiet empty state when no recent artifacts are stored", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Recent work" })).toBeTruthy();
    expect(screen.getByText("No recent work")).toBeTruthy();
  });
});

describe("HomePage focus", () => {
  it("puts the first unfinished Today task in the primary focus card", async () => {
    vi.mocked(tasksApi.todayList).mockResolvedValue([
      makeTodayTask(),
      makeTodayTask({ id: "task-2", title: "Review analyser proposals", startTime: "11:30" })
    ]);

    renderPage();

    expect(await screen.findByRole("heading", { name: "Your focus" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Refine project context retrieval" })).toBeTruthy();
    expect(screen.getByText("2 remaining")).toBeTruthy();
    expect(screen.getByText("Review analyser proposals")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open task" }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/tasks");
    });
  });

  it("shows the clear state when Today has no unfinished tasks", async () => {
    vi.mocked(tasksApi.todayList).mockResolvedValue([
      makeTodayTask({ status: "done" })
    ]);

    renderPage();

    expect(await screen.findByRole("heading", { name: "You're clear today." })).toBeTruthy();
    expect(screen.getByText("0 remaining")).toBeTruthy();
  });
});
