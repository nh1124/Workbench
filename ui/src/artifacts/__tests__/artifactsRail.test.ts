// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readArtifactsRailVisible, writeArtifactsRailVisible } from "../ArtifactsPage";

const STORAGE_KEY = "workbench-artifacts-rail-visible";

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("artifacts rail visibility", () => {
  it("is visible by default", () => {
    expect(readArtifactsRailVisible()).toBe(true);
  });

  it("is hidden when zero is stored", () => {
    window.localStorage.setItem(STORAGE_KEY, "0");
    expect(readArtifactsRailVisible()).toBe(false);
  });

  it("is visible when one is stored", () => {
    window.localStorage.setItem(STORAGE_KEY, "1");
    expect(readArtifactsRailVisible()).toBe(true);
  });

  it("round-trips a hidden state", () => {
    writeArtifactsRailVisible(false);
    expect(readArtifactsRailVisible()).toBe(false);
  });
});
