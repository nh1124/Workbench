import type { SyncEventMetadata } from "./syncStore.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function artifactEventMetadata(
  before: unknown,
  after?: unknown,
  fallbackResourceType?: string
): SyncEventMetadata {
  const beforeRecord = asRecord(before);
  const afterRecord = asRecord(after);
  const beforePath = nonEmptyText(beforeRecord.path);
  const afterPath = nonEmptyText(afterRecord.path);
  const resourceType = nonEmptyText(afterRecord.kind)
    ?? nonEmptyText(beforeRecord.kind)
    ?? nonEmptyText(afterRecord.type)
    ?? nonEmptyText(beforeRecord.type)
    ?? nonEmptyText(fallbackResourceType);
  const projectId = nonEmptyText(afterRecord.projectId) ?? nonEmptyText(beforeRecord.projectId);
  const path = afterPath ?? beforePath;

  return {
    ...(projectId ? { projectId } : {}),
    ...(resourceType ? { resourceType } : {}),
    ...(path ? { path } : {}),
    ...(beforePath && afterPath && beforePath !== afterPath ? { previousPath: beforePath } : {})
  };
}

export function artifactDeletionSnapshotRoot(snapshot: unknown): unknown {
  const snapshotRecord = asRecord(snapshot);
  const rootArtifactItemId = nonEmptyText(snapshotRecord.rootArtifactItemId);
  const items = Array.isArray(snapshotRecord.items) ? snapshotRecord.items : [];
  for (const entry of items) {
    const item = asRecord(asRecord(entry).item);
    if (!rootArtifactItemId || nonEmptyText(item.id) === rootArtifactItemId) return item;
  }
  return undefined;
}
