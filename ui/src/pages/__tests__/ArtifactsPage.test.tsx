// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RECENT_ARTIFACTS_STORAGE_KEY } from "../../artifacts/utils/recents";
import { artifactsApi, projectsApi } from "../../lib/api";
import type { ArtifactItem } from "../../types/models";
import { ArtifactsPage } from "../ArtifactsPage";

const timestamp = "2026-07-06T00:00:00.000Z";

function artifactItem(overrides: Partial<ArtifactItem> = {}): ArtifactItem {
  return {
    id: "note-1",
    projectId: "project-a",
    projectName: "Finance",
    kind: "note",
    title: "Alpha Note",
    path: "alpha.md",
    parentPath: "",
    scope: "private",
    tags: [],
    version: 1,
    contentMarkdown: "# Alpha",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}

const noteItem = artifactItem();
const otherItem = artifactItem({
  id: "note-2",
  title: "Beta Note",
  path: "beta.md",
  contentMarkdown: "# Beta"
});

function renderPage(initialEntry = "/artifacts") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/artifacts" element={<ArtifactsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  vi.spyOn(projectsApi, "getDefault").mockResolvedValue({
    project: {
      id: "project-a",
      name: "Finance",
      description: "",
      status: "active",
      ownerAccountId: "owner-a",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  });
  vi.spyOn(projectsApi, "list").mockResolvedValue({
    items: [{
      id: "project-a",
      name: "Finance",
      description: "",
      status: "active",
      ownerAccountId: "owner-a",
      createdAt: timestamp,
      updatedAt: timestamp
    }]
  });
  vi.spyOn(artifactsApi, "projects").mockResolvedValue([]);
  vi.spyOn(artifactsApi, "tree").mockResolvedValue([noteItem, otherItem]);
  vi.spyOn(artifactsApi, "getItem").mockImplementation((id) => {
    const item = [noteItem, otherItem].find((entry) => entry.id === id);
    return item ? Promise.resolve(item) : Promise.reject(new Error("missing"));
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("ArtifactsPage recents and deep links", () => {
  it("records opened note and file items in recent artifacts", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Alpha Note/ }));

    await waitFor(() => expect(artifactsApi.getItem).toHaveBeenCalledWith("note-1"));
    const stored = JSON.parse(window.localStorage.getItem(RECENT_ARTIFACTS_STORAGE_KEY) ?? "[]") as Array<{
      itemId: string;
      title: string;
      kind: string;
      path: string;
      projectId?: string;
    }>;

    expect(stored[0]).toMatchObject({
      itemId: "note-1",
      title: "Alpha Note",
      kind: "note",
      path: "alpha.md",
      projectId: "project-a"
    });
  });

  it("opens the requested item from the item query parameter", async () => {
    renderPage("/artifacts?item=note-2");

    await waitFor(() => expect(artifactsApi.getItem).toHaveBeenCalledWith("note-2"));
    expect(await screen.findByDisplayValue("Beta Note")).toBeTruthy();
  });

  it("falls back to a browser window when native new-window opening is unavailable", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderPage();

    fireEvent.contextMenu(await screen.findByRole("button", { name: /Alpha Note/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in New Window" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("/artifacts?item=note-1", "_blank", "noopener");
    });
  });
});
