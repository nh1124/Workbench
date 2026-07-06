// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { RECENT_ARTIFACTS_STORAGE_KEY, type RecentArtifact } from "../../artifacts/utils/recents";
import { projectsApi, tasksApi } from "../../lib/api";
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
      </Routes>
    </MemoryRouter>
  );
}

function storeRecents(entries: RecentArtifact[]) {
  window.localStorage.setItem(RECENT_ARTIFACTS_STORAGE_KEY, JSON.stringify(entries));
}

beforeEach(() => {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.spyOn(tasksApi, "list").mockResolvedValue([]);
  vi.spyOn(tasksApi, "projects").mockResolvedValue([]);
  vi.spyOn(tasksApi, "schedule").mockResolvedValue([]);
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

    expect(await screen.findByRole("heading", { name: "Recent Artifacts" })).toBeTruthy();
    expect(screen.getByText("Alpha Note")).toBeTruthy();
    expect(screen.getByText("notes/alpha.md")).toBeTruthy();
    expect(screen.getByText("2h ago")).toBeTruthy();

    const link = screen.getByText("Alpha Note").closest("a");
    expect(link?.getAttribute("href")).toBe("/artifacts?item=note-1");
    fireEvent.click(link!);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/artifacts?item=note-1");
    });
  });

  it("shows a quiet empty state when no recent artifacts are stored", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Recent Artifacts" })).toBeTruthy();
    expect(screen.getByText("No recent artifacts yet")).toBeTruthy();
  });
});
