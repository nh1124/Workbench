// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactItem } from "../../types/models";
import {
  RECENT_ARTIFACTS_STORAGE_KEY,
  readRecentArtifacts,
  recordRecentArtifact
} from "../utils/recents";

function artifactItem(id: string, title = id): ArtifactItem {
  return {
    id,
    projectId: "project-a",
    projectName: "Finance",
    kind: "note",
    title,
    path: `notes/${id}.md`,
    parentPath: "notes",
    scope: "private",
    tags: [],
    version: 1,
    contentMarkdown: `# ${title}`,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z"
  };
}

afterEach(() => {
  window.localStorage.removeItem(RECENT_ARTIFACTS_STORAGE_KEY);
});

describe("recent artifact storage", () => {
  it("records latest first, de-dupes by item id, and keeps the newest 20 entries", () => {
    for (let index = 0; index < 21; index += 1) {
      recordRecentArtifact(
        artifactItem(`item-${index}`),
        `2026-07-06T00:${String(index).padStart(2, "0")}:00.000Z`
      );
    }

    recordRecentArtifact(
      artifactItem("item-5", "Updated item 5"),
      "2026-07-06T01:00:00.000Z"
    );

    const recents = readRecentArtifacts();

    expect(recents).toHaveLength(20);
    expect(recents[0]).toMatchObject({
      itemId: "item-5",
      title: "Updated item 5",
      path: "notes/item-5.md"
    });
    expect(recents.filter((entry) => entry.itemId === "item-5")).toHaveLength(1);
    expect(recents.some((entry) => entry.itemId === "item-0")).toBe(false);
  });
});
