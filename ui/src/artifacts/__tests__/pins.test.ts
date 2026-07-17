// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "../../types/models";
import {
  PINNED_ARTIFACTS_CHANGED_EVENT,
  PINNED_ARTIFACTS_STORAGE_KEY,
  readPinnedArtifacts,
  togglePinnedArtifact,
  writePinnedArtifacts
} from "../utils/pins";

function artifactItem(id: string, kind: ArtifactItem["kind"] = "note"): ArtifactItem {
  return {
    id,
    projectId: "project-a",
    projectName: "Finance",
    kind,
    title: id,
    path: kind === "folder" ? `folders/${id}` : `notes/${id}.md`,
    parentPath: kind === "folder" ? "folders" : "notes",
    scope: "private",
    tags: [],
    version: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  };
}

afterEach(() => {
  window.localStorage.removeItem(PINNED_ARTIFACTS_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("pinned artifact storage", () => {
  it("stores newest first, de-dupes by item id, and supports folders", () => {
    writePinnedArtifacts([
      { itemId: "note-1", title: "Old", kind: "note", path: "notes/note-1.md", at: "2026-07-06T00:00:00.000Z" },
      { itemId: "folder-1", title: "Folder", kind: "folder", path: "folders/folder-1", at: "2026-07-06T00:01:00.000Z" },
      { itemId: "note-1", title: "New", kind: "note", path: "notes/note-1.md", at: "2026-07-06T00:02:00.000Z" }
    ]);

    expect(readPinnedArtifacts()).toEqual([
      expect.objectContaining({ itemId: "note-1", title: "New" }),
      expect.objectContaining({ itemId: "folder-1", kind: "folder" })
    ]);
  });

  it("toggles entries and dispatches the changed event", () => {
    const changed = vi.fn();
    window.addEventListener(PINNED_ARTIFACTS_CHANGED_EVENT, changed);
    const folder = artifactItem("folder-1", "folder");

    expect(togglePinnedArtifact(folder, "2026-07-06T00:00:00.000Z")).toBe(true);
    expect(readPinnedArtifacts()).toHaveLength(1);
    expect(togglePinnedArtifact(folder)).toBe(false);
    expect(readPinnedArtifacts()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);

    window.removeEventListener(PINNED_ARTIFACTS_CHANGED_EVENT, changed);
  });
});
