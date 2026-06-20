import { describe, expect, it } from "vitest";
import { shouldReloadArtifactMemberships } from "../utils/membership";

describe("shouldReloadArtifactMemberships", () => {
  it("rejects a completed mutation after selection switches to another Artifact", () => {
    expect(shouldReloadArtifactMemberships("artifact-a", "artifact-b", true)).toBe(false);
    expect(shouldReloadArtifactMemberships("artifact-a", "artifact-a", true)).toBe(true);
    expect(shouldReloadArtifactMemberships("artifact-a", "artifact-a", false)).toBe(false);
  });
});
