export const ARTIFACTS_LAST_LOCATION_STORAGE_KEY = "workbench.artifacts.lastLocation";

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeArtifactsLocation(value: string): string | null {
  const location = value.trim();
  if (location === "/artifacts" || location.startsWith("/artifacts?")) {
    return location;
  }
  return null;
}

export function readArtifactsLastLocation(): string | null {
  if (!storageAvailable()) return null;
  try {
    const stored = window.localStorage.getItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY);
    return stored ? normalizeArtifactsLocation(stored) : null;
  } catch {
    return null;
  }
}

export function writeArtifactsLastLocation(location: string): void {
  if (!storageAvailable()) return;
  const normalized = normalizeArtifactsLocation(location);
  if (!normalized) return;
  try {
    window.localStorage.setItem(ARTIFACTS_LAST_LOCATION_STORAGE_KEY, normalized);
  } catch {
    // Best effort; restoring the last location should never block navigation.
  }
}
