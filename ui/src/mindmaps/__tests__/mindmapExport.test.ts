// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  extensionForExportFormat,
  isRasterExportFormat,
  splitArtifactUploadPath,
  svgDimensions,
  withFileExtension
} from "../utils/mindmapExport";

/**
 * The export helpers decide the filename, the artifact destination path and the
 * raster canvas size. They had no coverage while they lived inside the page
 * component; extracting them made them directly testable.
 */

describe("isRasterExportFormat", () => {
  it("separates the formats that need rasterising from the text ones", () => {
    expect(isRasterExportFormat("png")).toBe(true);
    expect(isRasterExportFormat("jpeg")).toBe(true);
    expect(isRasterExportFormat("svg")).toBe(false);
    expect(isRasterExportFormat("markdown")).toBe(false);
  });
});

describe("extensionForExportFormat", () => {
  it("maps markdown to its conventional short extension", () => {
    expect(extensionForExportFormat("markdown")).toBe("md");
  });

  it("uses the format itself everywhere else", () => {
    expect(extensionForExportFormat("svg")).toBe("svg");
    expect(extensionForExportFormat("png")).toBe("png");
    expect(extensionForExportFormat("jpeg")).toBe("jpeg");
  });
});

describe("withFileExtension", () => {
  it("replaces an existing extension rather than appending to it", () => {
    expect(withFileExtension("diagram.svg", "png")).toBe("diagram.png");
  });

  it("adds one when the name has none", () => {
    expect(withFileExtension("diagram", "md")).toBe("diagram.md");
  });

  it("falls back to a default name when given nothing usable", () => {
    expect(withFileExtension("", "png")).toBe("mindmap-export.png");
    expect(withFileExtension("   ", "png")).toBe("mindmap-export.png");
  });

  it("only strips the final extension, keeping dotted names intact", () => {
    expect(withFileExtension("my.map.v2.svg", "png")).toBe("my.map.v2.png");
  });
});

describe("splitArtifactUploadPath", () => {
  it("splits a path into its directory and filename", () => {
    expect(splitArtifactUploadPath("mindmaps/plans/roadmap.md")).toEqual({
      directoryPath: "mindmaps/plans",
      filename: "roadmap.md"
    });
  });

  it("reports no directory for a bare filename", () => {
    expect(splitArtifactUploadPath("roadmap.md")).toEqual({
      directoryPath: undefined,
      filename: "roadmap.md"
    });
  });

  it("normalises backslashes and a leading slash", () => {
    expect(splitArtifactUploadPath("/mindmaps\\plans\\roadmap.md")).toEqual({
      directoryPath: "mindmaps/plans",
      filename: "roadmap.md"
    });
  });

  it("returns nothing for an absent or blank path, so the caller can default", () => {
    expect(splitArtifactUploadPath(undefined)).toEqual({});
    expect(splitArtifactUploadPath("   ")).toEqual({});
  });
});

describe("svgDimensions", () => {
  it("prefers the explicit width and height attributes", () => {
    expect(svgDimensions('<svg width="640" height="480" viewBox="0 0 100 100"></svg>')).toEqual({
      width: 640,
      height: 480
    });
  });

  it("falls back to the viewBox when there are no attributes", () => {
    expect(svgDimensions('<svg viewBox="0 0 300 200"></svg>')).toEqual({ width: 300, height: 200 });
  });

  it("falls back to a default canvas when the SVG declares no size at all", () => {
    expect(svgDimensions("<svg></svg>")).toEqual({ width: 1200, height: 800 });
  });

  it("rounds fractional sizes up, since a canvas needs whole pixels", () => {
    expect(svgDimensions('<svg width="100.2" height="50.7"></svg>')).toEqual({ width: 101, height: 51 });
  });

  it("ignores a non-positive size rather than producing an empty canvas", () => {
    expect(svgDimensions('<svg width="0" height="-5" viewBox="0 0 120 90"></svg>')).toEqual({
      width: 120,
      height: 90
    });
  });
});
