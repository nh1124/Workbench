// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RECENT_ARTIFACTS_STORAGE_KEY } from "../utils/recents";
import { ARTIFACTS_LAST_LOCATION_STORAGE_KEY } from "../utils/lastLocation";
import { artifactsApi, projectsApi } from "../../lib/api";
import type { ArtifactItem } from "../../types/models";
import { ArtifactsPage } from "../ArtifactsPage";

/**
 * Characterization tests for the ArtifactsPage editing surface.
 *
 * The page is one component with 66 hooks and its existing suite only covered
 * navigation, recents, search and drops — nothing that mutates an artifact.
 * These pin the create/save/delete/folder behaviour so the component can be
 * decomposed into hooks without silently changing what the user sees.
 *
 * They assert observable behaviour (what is rendered, which API is called with
 * what) rather than internals, so they stay valid across that refactor.
 */

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
const folderItem = artifactItem({
  id: "folder-1",
  kind: "folder",
  title: "Reports",
  path: "reports",
  contentMarkdown: undefined
});

const project = {
  id: "project-a",
  name: "Finance",
  description: "",
  status: "active" as const,
  ownerAccountId: "owner-a",
  createdAt: timestamp,
  updatedAt: timestamp
};

function renderPage(initialEntry = "/artifacts?project=project-a") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/artifacts" element={<ArtifactsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

let treeItems: ArtifactItem[] = [];

beforeEach(() => {
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
  window.localStorage.removeItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY);
  treeItems = [noteItem, otherItem, folderItem];

  vi.spyOn(projectsApi, "getDefault").mockResolvedValue({ project });
  vi.spyOn(projectsApi, "list").mockResolvedValue({ items: [project] });
  vi.spyOn(artifactsApi, "projects").mockResolvedValue([]);
  vi.spyOn(artifactsApi, "tree").mockImplementation(() => Promise.resolve(treeItems));
  vi.spyOn(artifactsApi, "getItem").mockImplementation((id) => {
    const item = treeItems.find((entry) => entry.id === id);
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

/** Opens an existing item so the editor pane and its toolbar are mounted. */
async function openItem(title: string) {
  const entry = await screen.findByText(title);
  fireEvent.click(entry);
  await screen.findByLabelText("Save item");
}

describe("ArtifactsPage saving", () => {
  it("updates an existing note through updateItem, not createNote", async () => {
    const updateItem = vi.spyOn(artifactsApi, "updateItem").mockResolvedValue(noteItem);
    const createNote = vi.spyOn(artifactsApi, "createNote").mockResolvedValue(noteItem);

    renderPage();
    await openItem("Alpha Note");

    const title = screen.getByLabelText("Artifact title");
    fireEvent.change(title, { target: { value: "Alpha Renamed" } });
    fireEvent.click(screen.getByLabelText("Save item"));

    await waitFor(() => expect(updateItem).toHaveBeenCalled());
    expect(createNote).not.toHaveBeenCalled();
    expect(updateItem.mock.calls[0]?.[0]).toBe("note-1");
    expect((updateItem.mock.calls[0]?.[1] as { title?: string }).title).toBe("Alpha Renamed");
  });

  it("refuses to save a note whose title is empty", async () => {
    const updateItem = vi.spyOn(artifactsApi, "updateItem").mockResolvedValue(noteItem);

    renderPage();
    await openItem("Alpha Note");

    fireEvent.change(screen.getByLabelText("Artifact title"), { target: { value: "   " } });
    const save = screen.getByLabelText("Save item") as HTMLButtonElement;

    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it("reloads the tree after a successful save so the list reflects the change", async () => {
    vi.spyOn(artifactsApi, "updateItem").mockResolvedValue(noteItem);
    const tree = artifactsApi.tree as unknown as ReturnType<typeof vi.fn>;

    renderPage();
    await openItem("Alpha Note");
    const before = tree.mock.calls.length;

    fireEvent.change(screen.getByLabelText("Artifact title"), { target: { value: "Alpha Two" } });
    fireEvent.click(screen.getByLabelText("Save item"));

    await waitFor(() => expect(tree.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("ArtifactsPage deleting", () => {
  it("asks for confirmation before deleting and does nothing if cancelled", async () => {
    const remove = vi.spyOn(artifactsApi, "removeItem").mockResolvedValue(undefined as never);

    renderPage();
    await openItem("Alpha Note");
    fireEvent.click(screen.getByLabelText("Delete item"));

    const dialog = await screen.findByRole("dialog");
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes the open item once the dialog is confirmed", async () => {
    const remove = vi.spyOn(artifactsApi, "removeItem").mockResolvedValue(undefined as never);

    renderPage();
    await openItem("Alpha Note");
    fireEvent.click(screen.getByLabelText("Delete item"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("note-1"));
  });
});

describe("ArtifactsPage folders", () => {
  it("creates a folder under the current location", async () => {
    const createFolder = vi.spyOn(artifactsApi, "createFolder").mockResolvedValue(folderItem);

    renderPage();
    await screen.findByText("Alpha Note");

    fireEvent.click(screen.getByRole("button", { name: /new folder/i }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Invoices" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createFolder).toHaveBeenCalled());
    const payload = createFolder.mock.calls[0]?.[0] as { path?: string; title?: string };
    expect(JSON.stringify(payload)).toContain("Invoices");
  });

  it("does not create a folder when the name is blank", async () => {
    const createFolder = vi.spyOn(artifactsApi, "createFolder").mockResolvedValue(folderItem);

    renderPage();
    await screen.findByText("Alpha Note");

    fireEvent.click(screen.getByRole("button", { name: /new folder/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeNull());
    expect(createFolder).not.toHaveBeenCalled();
  });
});

describe("ArtifactsPage editor state", () => {
  it("keeps the editor on the opened item when the tree reloads", async () => {
    renderPage();
    await openItem("Alpha Note");

    expect((screen.getByLabelText("Artifact title") as HTMLInputElement).value).toBe("Alpha Note");

    // A background reload must not swap the editor to a different item.
    treeItems = [noteItem, otherItem, folderItem];
    await waitFor(() => {
      expect((screen.getByLabelText("Artifact title") as HTMLInputElement).value).toBe("Alpha Note");
    });
  });

  it("switches the editor when a different item is opened", async () => {
    renderPage();
    await openItem("Alpha Note");
    expect((screen.getByLabelText("Artifact title") as HTMLInputElement).value).toBe("Alpha Note");

    fireEvent.click(screen.getByLabelText("Back to directory"));
    await openItem("Beta Note");

    await waitFor(() => {
      expect((screen.getByLabelText("Artifact title") as HTMLInputElement).value).toBe("Beta Note");
    });
  });
});
