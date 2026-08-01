import { describe, expect, it } from "vitest";
import { resolveVariantStartPage } from "../App";

describe("resolveVariantStartPage", () => {
  it("maps each variant to its route", () => {
    expect(resolveVariantStartPage("tasks")).toBe("/tasks");
    expect(resolveVariantStartPage("notes")).toBe("/notes");
    expect(resolveVariantStartPage("artifacts")).toBe("/artifacts");
  });

  it("returns null for the main app", () => {
    expect(resolveVariantStartPage("main")).toBeNull();
  });

  it("returns null when no variant was injected", () => {
    expect(resolveVariantStartPage(undefined)).toBeNull();
    expect(resolveVariantStartPage(null)).toBeNull();
  });

  it("returns null for an empty injected value", () => {
    expect(resolveVariantStartPage("")).toBeNull();
  });

  it("returns null for an unknown variant so the configured start page wins", () => {
    expect(resolveVariantStartPage("bogus")).toBeNull();
    expect(resolveVariantStartPage("settings")).toBeNull();
  });
});
