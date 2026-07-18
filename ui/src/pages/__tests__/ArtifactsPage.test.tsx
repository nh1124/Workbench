// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { RECENT_ARTIFACTS_STORAGE_KEY } from "../../artifacts/utils/recents";
import { ARTIFACTS_LAST_LOCATION_STORAGE_KEY } from "../../artifacts/utils/lastLocation";
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
        <Route path="/artifacts" element={<ArtifactsPageHarness />} />
      </Routes>
    </MemoryRouter>
  );
}

function ArtifactsPageHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <ArtifactsPage />
      <output data-testid="artifacts-location">{location.search}</output>
      <button type="button" onClick={() => navigate("/artifacts?project=project-a&new=note")}>
        Request project note
      </button>
    </>
  );
}

beforeEach(() => {
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  window.localStorage.removeItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY);
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
  window.localStorage.removeItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY);
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("ArtifactsPage recents and deep links", () => {
  it("records opened note and file items in recent artifacts", async () => {
    renderPage("/artifacts?view=all");

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

  it("consumes a mounted new-note request for the project root", async () => {
    renderPage();
    await screen.findByRole("button", { name: /All Projects/ });

    fireEvent.click(screen.getByRole("button", { name: "Request project note" }));

    expect(await screen.findByDisplayValue("New Note")).toBeTruthy();
    expect(screen.getByTitle("new-note.md")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("artifacts-location").textContent).toBe("?project=project-a");
      expect(window.localStorage.getItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY)).toBe("/artifacts?project=project-a");
    });
  });

  it("falls back to a browser window when native new-window opening is unavailable", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderPage("/artifacts?view=all");

    fireEvent.contextMenu(await screen.findByRole("button", { name: /Alpha Note/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in New Window" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("/artifacts?item=note-1", "_blank", "noopener");
    });
  });
});

describe("ArtifactsPage project cards and search", () => {
  it("shows project cards first and uses Home to return from the merged directory", async () => {
    renderPage();

    const allProjects = await screen.findByRole("button", { name: /All Projects.*2 items/ });
    expect(screen.getByRole("button", { name: /Finance.*2 items/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Upload/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New Folder/ })).toBeNull();

    fireEvent.click(allProjects);

    expect(await screen.findByRole("button", { name: /Alpha Note/ })).toBeTruthy();
    expect(screen.getByTestId("artifacts-location").textContent).toBe("?view=all");

    fireEvent.click(screen.getByRole("button", { name: "Home" }));

    expect(await screen.findByRole("button", { name: /All Projects/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("artifacts-location").textContent).toBe(""));
  });

  it("opens slash search, filters loaded items, and clears on Escape", async () => {
    renderPage();
    await screen.findByRole("button", { name: /All Projects/ });

    fireEvent.keyDown(window, { key: "/" });
    const searchInput = await screen.findByRole("searchbox", { name: "Search artifacts" });
    fireEvent.change(searchInput, { target: { value: "beta beta.md" } });

    expect(await screen.findByRole("button", { name: /Beta Note.*beta\.md.*Finance/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alpha Note/ })).toBeNull();

    fireEvent.keyDown(searchInput, { key: "Escape" });

    expect(screen.queryByRole("searchbox", { name: "Search artifacts" })).toBeNull();
    expect(await screen.findByRole("button", { name: /All Projects/ })).toBeTruthy();
  });

  it("uploads background drops to the current folder and keeps that location in the URL", async () => {
    const file = new File(["uploaded"], "uploaded.txt", { type: "text/plain" });
    const uploadedItem = artifactItem({
      id: "file-uploaded",
      kind: "file",
      title: "uploaded.txt",
      path: "reports/uploaded.txt",
      parentPath: "reports",
      contentMarkdown: "",
      mimeType: "text/plain"
    });
    const uploadSpy = vi.spyOn(artifactsApi, "uploadFile").mockResolvedValue(uploadedItem);
    vi.mocked(artifactsApi.getItem).mockImplementation((id) => {
      const item = [noteItem, otherItem, uploadedItem].find((entry) => entry.id === id);
      return item ? Promise.resolve(item) : Promise.reject(new Error("missing"));
    });

    const { container } = renderPage("/artifacts?project=project-a&folder=reports");
    await screen.findByRole("button", { name: /Upload/ });
    const directoryPane = container.querySelector<HTMLElement>(".va-directory-pane");
    expect(directoryPane).toBeTruthy();

    fireEvent.dragOver(directoryPane!, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "none" }
    });
    expect(directoryPane!.classList.contains("drop-target-root")).toBe(true);

    fireEvent.drop(directoryPane!, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "copy" }
    });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-a",
        directoryPath: "reports",
        file
      }));
      expect(screen.getByTestId("artifacts-location").textContent).toContain("folder=reports");
      expect(screen.getByTestId("artifacts-location").textContent).toContain("item=file-uploaded");
    });
  });

  it("accepts file drops only on project cards in the project-card view", async () => {
    const file = new File(["uploaded"], "uploaded.txt", { type: "text/plain" });
    const uploadedItem = artifactItem({
      id: "card-uploaded",
      kind: "file",
      title: "uploaded.txt",
      path: "uploaded.txt",
      contentMarkdown: "",
      mimeType: "text/plain"
    });
    const uploadSpy = vi.spyOn(artifactsApi, "uploadFile").mockResolvedValue(uploadedItem);
    vi.mocked(artifactsApi.getItem).mockImplementation((id) => {
      const item = [noteItem, otherItem, uploadedItem].find((entry) => entry.id === id);
      return item ? Promise.resolve(item) : Promise.reject(new Error("missing"));
    });

    const { container } = renderPage();
    const allProjectsCard = await screen.findByRole("button", { name: /All Projects/ });
    const projectCard = screen.getByRole("button", { name: /Finance.*2 items/ });
    const directoryPane = container.querySelector<HTMLElement>(".va-directory-pane");
    expect(directoryPane).toBeTruthy();

    fireEvent.drop(directoryPane!, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "none" }
    });
    fireEvent.drop(allProjectsCard, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "none" }
    });
    expect(uploadSpy).not.toHaveBeenCalled();

    fireEvent.dragOver(projectCard, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "none" }
    });
    expect(projectCard.classList.contains("drop-target")).toBe(true);
    fireEvent.drop(projectCard, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "copy" }
    });

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-a",
        directoryPath: undefined,
        file
      }));
      expect(screen.getByTestId("artifacts-location").textContent).toContain("project=project-a");
      expect(screen.getByTestId("artifacts-location").textContent).toContain("item=card-uploaded");
    });
  });
});
