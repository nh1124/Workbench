import { describe, expect, it } from "vitest";
import { serverLabel } from "../components/VariantAccountBar";

describe("serverLabel", () => {
  it("shows the host so the account row stays readable at small sizes", () => {
    expect(serverLabel("https://workbench.visionark.jp")).toBe("workbench.visionark.jp");
    expect(serverLabel("http://127.0.0.1:4100")).toBe("127.0.0.1:4100");
  });

  it("keeps the port when one is set", () => {
    expect(serverLabel("https://example.com:8443/")).toBe("example.com:8443");
  });

  it("falls back to the raw value when it is not a URL", () => {
    expect(serverLabel("not a url")).toBe("not a url");
    expect(serverLabel("")).toBe("");
  });
});
