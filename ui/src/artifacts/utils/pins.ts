import type { ArtifactItem } from "../../types/models";

export const PINNED_ARTIFACTS_STORAGE_KEY = "workbench.pinnedArtifacts";
export const PINNED_ARTIFACTS_CHANGED_EVENT = "workbench-pinned-artifacts-changed";

export interface PinnedArtifact {
  itemId: string;
  title: string;
  kind: "note" | "file" | "folder";
  path: string;
  projectId?: string;
  at: string;
}

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isPinnedArtifact(value: unknown): value is PinnedArtifact {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PinnedArtifact>;
  return (
    typeof entry.itemId === "string" &&
    typeof entry.title === "string" &&
    (entry.kind === "note" || entry.kind === "file" || entry.kind === "folder") &&
    typeof entry.path === "string" &&
    typeof entry.at === "string" &&
    (entry.projectId === undefined || typeof entry.projectId === "string")
  );
}

function normalizePinnedArtifacts(entries: PinnedArtifact[]): PinnedArtifact[] {
  const byId = new Map<string, PinnedArtifact>();
  for (const entry of entries) {
    const previous = byId.get(entry.itemId);
    if (!previous || Date.parse(entry.at) >= Date.parse(previous.at)) {
      byId.set(entry.itemId, entry);
    }
  }

  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function readPinnedArtifacts(): PinnedArtifact[] {
  if (!storageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(PINNED_ARTIFACTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizePinnedArtifacts(parsed.filter(isPinnedArtifact));
  } catch {
    return [];
  }
}

export function writePinnedArtifacts(entries: PinnedArtifact[]): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(
      PINNED_ARTIFACTS_STORAGE_KEY,
      JSON.stringify(normalizePinnedArtifacts(entries))
    );
    window.dispatchEvent(new Event(PINNED_ARTIFACTS_CHANGED_EVENT));
  } catch {
    // Best effort; pinned artifacts should never block artifact actions.
  }
}

export function togglePinnedArtifact(item: ArtifactItem, at = new Date().toISOString()): boolean {
  const current = readPinnedArtifacts();
  if (current.some((entry) => entry.itemId === item.id)) {
    writePinnedArtifacts(current.filter((entry) => entry.itemId !== item.id));
    return false;
  }

  writePinnedArtifacts([
    {
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      path: item.path,
      projectId: item.projectId || undefined,
      at
    },
    ...current
  ]);
  return true;
}
