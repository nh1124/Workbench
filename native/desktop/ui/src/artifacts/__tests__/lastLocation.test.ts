// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACTS_LAST_LOCATION_STORAGE_KEY,
  readArtifactsLastLocation,
  writeArtifactsLastLocation
} from "../utils/lastLocation";

afterEach(() => {
  window.localStorage.removeItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY);
});

describe("artifacts last location storage", () => {
  it("stores and reads an artifacts path with its query", () => {
    writeArtifactsLastLocation("/artifacts?project=project-a&folder=notes");

    expect(readArtifactsLastLocation()).toBe("/artifacts?project=project-a&folder=notes");
  });

  it("ignores malformed and non-artifacts stored locations", () => {
    for (const value of ["https://example.com/artifacts", "/projects", "/artifacts-old?project=a"]) {
      window.localStorage.setItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY, value);
      expect(readArtifactsLastLocation()).toBeNull();
    }
  });
});
