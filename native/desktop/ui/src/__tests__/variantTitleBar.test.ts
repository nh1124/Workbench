import { describe, expect, it } from "vitest";
import { variantAppName } from "../components/VariantTitleBar";

describe("variantAppName", () => {
  it("names each dedicated app", () => {
    expect(variantAppName("tasks")).toBe("Workbench Tasks");
    expect(variantAppName("notes")).toBe("Workbench Notes");
    expect(variantAppName("artifacts")).toBe("Workbench Artifacts");
  });

  it("falls back to the plain product name", () => {
    expect(variantAppName("main")).toBe("Workbench");
    expect(variantAppName("bogus")).toBe("Workbench");
  });

  it("falls back when no variant was injected", () => {
    expect(variantAppName(undefined)).toBe("Workbench");
    expect(variantAppName(null)).toBe("Workbench");
  });
});
