import { describe, expect, it } from "vitest";
import type { ProjectDeletionImpact, ProjectIndexEntry, ProjectRelation } from "../../types/models";
import {
  assessGeneratedSummaryFreshness,
  isProjectDeletionBlocked,
  isProjectIndexEntryStale,
  projectRelationViewDirection,
  selectStableProjectDeletionTargets,
  selectStableProjectRenameTargets
} from "../projectContextUtils";

describe("assessGeneratedSummaryFreshness", () => {
  it("does not claim unloaded sources are current", () => {
    expect(assessGeneratedSummaryFreshness(undefined, [])).toEqual({
      state: "unknown",
      message: "Freshness is unknown because the summary has no valid update time."
    });
    expect(assessGeneratedSummaryFreshness("2026-06-21T00:00:00.000Z", ["2026-06-20T00:00:00.000Z"])).toEqual({
      state: "no_newer_loaded_section",
      message: "No newer timestamp was found in the loaded context; complete source freshness cannot be verified."
    });
    expect(assessGeneratedSummaryFreshness("2026-06-20T00:00:00.000Z", ["2026-06-21T00:00:00.000Z"]).state)
      .toBe("possibly_stale");
  });
});

const relation: ProjectRelation = {
  id: "rel-1",
  version: 1,
  sourceProjectId: "project-a",
  targetProjectId: "project-b",
  relationType: "supports",
  directionality: "directed",
  origin: "manual",
  createdByKind: "user",
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z"
};

describe("projectRelationViewDirection", () => {
  it("distinguishes incoming, outgoing, and bidirectional relations", () => {
    expect(projectRelationViewDirection(relation, "project-a")).toBe("outgoing");
    expect(projectRelationViewDirection(relation, "project-b")).toBe("incoming");
    expect(projectRelationViewDirection({ ...relation, directionality: "bidirectional" }, "project-a")).toBe("bidirectional");
  });
});

describe("isProjectDeletionBlocked", () => {
  it("blocks deletion while primary Artifacts remain", () => {
    const impact: ProjectDeletionImpact = {
      projectId: "project-a",
      primaryArtifactCount: 1,
      secondaryArtifactCount: 3,
      canDelete: false
    };
    expect(isProjectDeletionBlocked(impact)).toBe(true);
    expect(isProjectDeletionBlocked({ ...impact, primaryArtifactCount: 0, canDelete: true })).toBe(false);
  });
});

describe("isProjectIndexEntryStale", () => {
  it("compares source and index timestamps", () => {
    const entry = {
      sourceUpdatedAt: "2026-06-20T02:00:00.000Z",
      indexedAt: "2026-06-20T01:00:00.000Z"
    } as ProjectIndexEntry;
    expect(isProjectIndexEntryStale(entry)).toBe(true);
    expect(isProjectIndexEntryStale({ ...entry, indexedAt: "2026-06-20T03:00:00.000Z" })).toBe(false);
  });
});

describe("selectStableProjectDeletionTargets", () => {
  it("never selects same-name resources owned by a different stable Project ID", () => {
    const notes = [
      { id: "note-owned", projectId: "project-a", projectName: "Shared name" },
      { id: "note-other", projectId: "project-b", projectName: "Shared name" }
    ];
    const tasks = [
      { id: "task-owned", context: "project-a", contextName: "Shared name" },
      { id: "task-other", context: "project-b", contextName: "Shared name" },
      { id: "task-legacy-name-only", context: "Shared name", contextName: "Shared name" }
    ];
    const artifacts = [
      { id: "artifact-owned", projectId: "project-a", projectName: "Shared name" },
      { id: "artifact-other", projectId: "project-b", projectName: "Shared name" },
      { id: "artifact-legacy-name-only", projectId: "Shared name", projectName: "Shared name" }
    ];

    const result = selectStableProjectDeletionTargets("project-a", notes, tasks, artifacts);

    expect(result.notes.map((item) => item.id)).toEqual(["note-owned"]);
    expect(result.tasks.map((item) => item.id)).toEqual(["task-owned"]);
    expect(result.artifacts.map((item) => item.id)).toEqual(["artifact-owned"]);
  });
});

describe("selectStableProjectRenameTargets", () => {
  it("does not rename same-name resources or Artifact items from another Project ID", () => {
    const result = selectStableProjectRenameTargets(
      "project-a",
      [
        { id: "note-owned", projectId: "project-a", projectName: "Shared name" },
        { id: "note-other", projectId: "project-b", projectName: "Shared name" }
      ],
      [
        { id: "task-owned", context: "project-a", contextName: "Shared name" },
        { id: "task-other", context: "project-b", contextName: "Shared name" }
      ],
      [
        { id: "legacy-owned", projectId: "project-a", projectName: "Shared name" },
        { id: "legacy-other", projectId: "project-b", projectName: "Shared name" }
      ],
      [
        { id: "item-owned", projectId: "project-a", projectName: "Shared name" },
        { id: "item-other", projectId: "project-b", projectName: "Shared name" }
      ]
    );

    expect(result.notes.map((item) => item.id)).toEqual(["note-owned"]);
    expect(result.tasks.map((item) => item.id)).toEqual(["task-owned"]);
    expect(result.artifacts.map((item) => item.id)).toEqual(["legacy-owned"]);
    expect(result.artifactItems.map((item) => item.id)).toEqual(["item-owned"]);
  });
});
