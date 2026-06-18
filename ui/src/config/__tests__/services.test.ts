import { describe, expect, it } from "vitest";
import { resolveWorkbenchLocalRoutingTarget } from "../services";

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
