import { describe, expect, it } from "vitest";
import { buildArtifactsHref } from "../components/ArtifactsQuickAccess";

describe("buildArtifactsHref", () => {
  it("returns the artifacts root when no parameters are present", () => {
    expect(buildArtifactsHref({})).toBe("/artifacts");
  });

  it("adds a project parameter", () => {
    expect(buildArtifactsHref({ projectId: "p1" })).toBe("/artifacts?project=p1");
  });

  it("adds an item parameter", () => {
    expect(buildArtifactsHref({ itemId: "i1" })).toBe("/artifacts?item=i1");
  });

  it("adds the new note mode after the project", () => {
    expect(buildArtifactsHref({ projectId: "p1", newNote: true })).toBe("/artifacts?project=p1&new=note");
  });

  it("URL-encodes folder paths", () => {
    expect(buildArtifactsHref({ projectId: "p1", folderPath: "a/b" })).toBe(
      "/artifacts?project=p1&folder=a%2Fb"
    );
  });
});
