// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeWorkbenchCoreUrl, resolveWorkbenchLocalRoutingTarget } from "../services";

const LOCAL_MODE_ENABLED_STORAGE_KEY = "workbench-local-mode-enabled";
const LOCAL_ROUTING_MODE_STORAGE_KEY = "workbench-local-routing-mode";

async function readRoutingModeFromFreshModule() {
  vi.resetModules();
  const { getWorkbenchLocalRoutingMode } = await import("../services");
  return getWorkbenchLocalRoutingMode();
}

beforeEach(() => {
  window.localStorage.clear();
  delete window.__TAURI_INTERNALS__;
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

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

  it("defaults to Core in the browser", async () => {
    expect(await readRoutingModeFromFreshModule()).toBe("core");
  });

  it("defaults to auto in the Tauri desktop shell", async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };

    expect(await readRoutingModeFromFreshModule()).toBe("auto");
  });

  it("prefers the legacy local flag over the platform default", async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    window.localStorage.setItem(LOCAL_MODE_ENABLED_STORAGE_KEY, "true");

    expect(await readRoutingModeFromFreshModule()).toBe("local");
  });

  it("prefers a stored routing mode over the legacy flag and platform default", async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    window.localStorage.setItem(LOCAL_MODE_ENABLED_STORAGE_KEY, "true");
    window.localStorage.setItem(LOCAL_ROUTING_MODE_STORAGE_KEY, "core");

    expect(await readRoutingModeFromFreshModule()).toBe("core");
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
