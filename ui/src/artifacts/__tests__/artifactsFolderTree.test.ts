import { describe, expect, it } from "vitest";
import { ancestorFolderPaths } from "../components/ArtifactsFolderTree";

describe("ancestorFolderPaths", () => {
  it("returns every nested folder path", () => {
    expect(ancestorFolderPaths("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("returns a single folder", () => {
    expect(ancestorFolderPaths("notes")).toEqual(["notes"]);
  });

  it("returns no paths for the root", () => {
    expect(ancestorFolderPaths("")).toEqual([]);
  });

  it("normalizes messy separators", () => {
    expect(ancestorFolderPaths("/a\\b//c/")).toEqual(["a", "a/b", "a/b/c"]);
  });
});
