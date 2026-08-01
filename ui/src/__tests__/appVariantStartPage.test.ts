import { describe, expect, it } from "vitest";
import { resolveVariantStartPage } from "../App";

describe("resolveVariantStartPage", () => {
  it("maps each variant to its route", () => {
    expect(resolveVariantStartPage("?app=tasks")).toBe("/tasks");
    expect(resolveVariantStartPage("?app=notes")).toBe("/notes");
    expect(resolveVariantStartPage("?app=artifacts")).toBe("/artifacts");
  });

  it("returns null when the app parameter is absent", () => {
    expect(resolveVariantStartPage("")).toBeNull();
    expect(resolveVariantStartPage("?quick-note-window=1")).toBeNull();
  });

  it("returns null for an empty app parameter", () => {
    expect(resolveVariantStartPage("?app=")).toBeNull();
  });

  it("returns null for an unknown variant so the configured start page wins", () => {
    expect(resolveVariantStartPage("?app=bogus")).toBeNull();
    expect(resolveVariantStartPage("?app=settings")).toBeNull();
  });

  it("ignores other query parameters", () => {
    expect(resolveVariantStartPage("?foo=1&app=notes&bar=2")).toBe("/notes");
  });
});
