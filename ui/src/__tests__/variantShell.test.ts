import { describe, expect, it } from "vitest";
import { pageFrameClassName } from "../components/VariantShell";

describe("pageFrameClassName", () => {
  it("adds the per-feature modifier so pages keep their own framing", () => {
    expect(pageFrameClassName("/tasks")).toBe("page-frame tasks-page-frame");
    expect(pageFrameClassName("/artifacts")).toBe("page-frame artifacts-page-frame");
    expect(pageFrameClassName("/notes")).toBe("page-frame");
  });

  it("matches nested routes by prefix", () => {
    expect(pageFrameClassName("/tasks/calendar")).toBe("page-frame tasks-page-frame");
    expect(pageFrameClassName("/artifacts/folder/x")).toBe("page-frame artifacts-page-frame");
  });

  it("falls back to the plain frame for unknown routes", () => {
    expect(pageFrameClassName("/")).toBe("page-frame");
    expect(pageFrameClassName("/settings")).toBe("page-frame");
  });
});
