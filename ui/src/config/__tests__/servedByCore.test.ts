// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { isServedByWorkbenchCore } from "../services";

function setLocation(href: string): void {
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL(href)
  });
}

afterEach(() => {
  setLocation("http://localhost:3000/");
});

describe("isServedByWorkbenchCore", () => {
  it("is false in the packaged native app", () => {
    // The native app serves its own assets here; Core lives at the stored URL.
    setLocation("http://tauri.localhost/");
    expect(isServedByWorkbenchCore()).toBe(false);
  });

  it("is false for the native dev server", () => {
    setLocation("http://127.0.0.1:5174/");
    expect(isServedByWorkbenchCore()).toBe(false);
  });

  it("is true when Core itself serves the page", () => {
    setLocation("https://workbench.example.com/");
    expect(isServedByWorkbenchCore()).toBe(true);
  });

  it("still treats a plain localhost deployment as Core-served", () => {
    setLocation("http://localhost/");
    expect(isServedByWorkbenchCore()).toBe(true);
  });
});
