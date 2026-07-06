import type { ArtifactItem } from "../../types/models";

export const RECENT_ARTIFACTS_STORAGE_KEY = "workbench.recentArtifacts";
export const RECENT_ARTIFACTS_LIMIT = 20;

export interface RecentArtifact {
  itemId: string;
  title: string;
  kind: "note" | "file";
  path: string;
  projectId?: string;
  at: string;
}

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isRecentArtifact(value: unknown): value is RecentArtifact {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RecentArtifact>;
  return (
    typeof entry.itemId === "string" &&
    typeof entry.title === "string" &&
    (entry.kind === "note" || entry.kind === "file") &&
    typeof entry.path === "string" &&
    typeof entry.at === "string" &&
    (entry.projectId === undefined || typeof entry.projectId === "string")
  );
}

function normalizeRecentArtifacts(entries: RecentArtifact[], limit = RECENT_ARTIFACTS_LIMIT): RecentArtifact[] {
  const byId = new Map<string, RecentArtifact>();
  for (const entry of entries) {
    const previous = byId.get(entry.itemId);
    if (!previous || Date.parse(entry.at) >= Date.parse(previous.at)) {
      byId.set(entry.itemId, entry);
    }
  }

  return [...byId.values()]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}

export function readRecentArtifacts(limit = RECENT_ARTIFACTS_LIMIT): RecentArtifact[] {
  if (!storageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ARTIFACTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeRecentArtifacts(parsed.filter(isRecentArtifact), limit);
  } catch {
    return [];
  }
}

export function writeRecentArtifacts(entries: RecentArtifact[]): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(
      RECENT_ARTIFACTS_STORAGE_KEY,
      JSON.stringify(normalizeRecentArtifacts(entries))
    );
    window.dispatchEvent(new Event("workbench-recent-artifacts-changed"));
  } catch {
    // Best effort; recent artifacts should never block opening an item.
  }
}

export function recordRecentArtifact(item: ArtifactItem, at = new Date().toISOString()): void {
  if (item.kind !== "note" && item.kind !== "file") {
    return;
  }

  const current = readRecentArtifacts();
  writeRecentArtifacts([
    {
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      path: item.path,
      projectId: item.projectId || undefined,
      at
    },
    ...current.filter((entry) => entry.itemId !== item.id)
  ]);
}
