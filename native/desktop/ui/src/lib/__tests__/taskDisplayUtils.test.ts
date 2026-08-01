import { describe, expect, it } from "vitest";
import {
  filterProjectOptionsByAllowedIds,
  mergeProjectOptions
} from "../taskDisplayUtils";

describe("project display options", () => {
  it("deduplicates and keeps a non-empty project name", () => {
    expect(
      mergeProjectOptions(
        [{ projectId: "p1" }],
        [{ projectId: "p1", projectName: "Project One" }]
      )
    ).toEqual([{ projectId: "p1", projectName: "Project One" }]);
  });

  it("filters task-derived projects to active project ids", () => {
    const options = [
      { projectId: "active", projectName: "Active" },
      { projectId: "archived", projectName: "Archived" },
      { projectId: "deleted", projectName: "Deleted" }
    ];

    expect(filterProjectOptionsByAllowedIds(options, new Set(["active"]))).toEqual([
      { projectId: "active", projectName: "Active" }
    ]);
  });
});
