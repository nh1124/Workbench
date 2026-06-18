import { describe, expect, it } from "vitest";
import { normalizeWorkbenchCoreUrl, resolveWorkbenchLocalRoutingTarget } from "../services";

describe("Workbench local routing", () => {
  it("uses Core online and daemon offline in auto mode", () => {
    expect(resolveWorkbenchLocalRoutingTarget("auto", true)).toBe("core");
    expect(resolveWorkbenchLocalRoutingTarget("auto", false)).toBe("local");
  });

  it("keeps explicit Core and Local modes stable regardless of network state", () => {
    expect(resolveWorkbenchLocalRoutingTarget("core", true)).toBe("core");
    expect(resolveWorkbenchLocalRoutingTarget("core", false)).toBe("core");
    expect(resolveWorkbenchLocalRoutingTarget("local", true)).toBe("local");
    expect(resolveWorkbenchLocalRoutingTarget("local", false)).toBe("local");
  });
});

describe("Workbench Core URL security", () => {
  it("requires HTTPS for remote Core URLs", () => {
    expect(normalizeWorkbenchCoreUrl("https://core.example.com/")).toBe("https://core.example.com");
    expect(() => normalizeWorkbenchCoreUrl("http://core.example.com")).toThrow(/https/);
  });

  it("allows HTTP only for local development Core URLs", () => {
    expect(normalizeWorkbenchCoreUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeWorkbenchCoreUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
    expect(normalizeWorkbenchCoreUrl("http://[::1]:3000/")).toBe("http://[::1]:3000");
  });
});
