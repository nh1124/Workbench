import { describe, expect, it } from "vitest";
import { getArtifactsSearchShortcutAction } from "../ArtifactsPage";

describe("getArtifactsSearchShortcutAction", () => {
  it("keeps the main app's directory shortcut behavior", () => {
    expect(
      getArtifactsSearchShortcutAction({ isDedicatedApp: false, hasDetailSelection: false })
    ).toBe("expand");
  });

  it("focuses the always-visible search in the dedicated directory view", () => {
    expect(
      getArtifactsSearchShortcutAction({ isDedicatedApp: true, hasDetailSelection: false })
    ).toBe("focus");
  });

  it("ignores the shortcut in main-app edit mode", () => {
    expect(
      getArtifactsSearchShortcutAction({ isDedicatedApp: false, hasDetailSelection: true })
    ).toBe("ignore");
  });

  it("does not steal the shortcut in dedicated-app edit mode", () => {
    expect(
      getArtifactsSearchShortcutAction({ isDedicatedApp: true, hasDetailSelection: true })
    ).toBe("ignore");
  });
});
