import { describe, expect, it } from "vitest";
import { variantAppName } from "../components/VariantTitleBar";

describe("variantAppName", () => {
  it("names each dedicated app", () => {
    expect(variantAppName("?app=tasks")).toBe("Workbench Tasks");
    expect(variantAppName("?app=notes")).toBe("Workbench Notes");
    expect(variantAppName("?app=artifacts")).toBe("Workbench Artifacts");
  });

  it("falls back to the plain product name", () => {
    expect(variantAppName("")).toBe("Workbench");
    expect(variantAppName("?app=")).toBe("Workbench");
    expect(variantAppName("?app=bogus")).toBe("Workbench");
  });

  it("ignores unrelated query parameters", () => {
    expect(variantAppName("?foo=1&app=notes")).toBe("Workbench Notes");
  });
});
