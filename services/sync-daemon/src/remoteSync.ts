import type { SyncErrorMetadata } from "./manifestStore.js";
import { PROJECT_CONTEXT_DOMAIN } from "./projectContextCache.js";
import {
  defaultNotePath,
  isIgnoredSyncRelativePath,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  sanitizePathSegment
} from "./paths.js";
import { asNumber, asRecord, asString } from "./localStore.js";
import type {
  RemoteArtifactItem,
  RemoteArtifactKind,
  RemoteSyncEvent
} from "./types.js";
import type { RemoteResourceDomain } from "./manifestStore.js";

export type SyncErrorDetails = SyncErrorMetadata & {
  errorMessage: string;
};

export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function errorCodeFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return stringFromUnknown(code);
}

export function statusFromUnknown(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = (value as { status?: unknown; statusCode?: unknown }).status
    ?? (value as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

export function classifySyncError(input: unknown): SyncErrorDetails {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  const errorMessage = stringFromUnknown(record?.message)
    ?? (input instanceof Error ? input.message : undefined)
    ?? stringFromUnknown(input)
    ?? "Sync operation failed";
  const errorCode = stringFromUnknown(record?.code) ?? errorCodeFromUnknown(input);
  const status = typeof record?.status === "number" ? record.status : statusFromUnknown(input);
  const normalizedCode = errorCode?.toUpperCase() ?? "";
  const normalizedMessage = errorMessage.toLowerCase();

  if (normalizedCode === "SYNC_VERSION_CONFLICT" || normalizedCode === "VERSION_CONFLICT" || status === 409) {
    return { errorMessage, errorCode, errorCategory: "version_conflict", retryable: false };
  }
  if (normalizedCode.includes("CHECKSUM")) {
    return { errorMessage, errorCode, errorCategory: "checksum", retryable: false };
  }
  if (normalizedCode.includes("CAPABILITY")) {
    return { errorMessage, errorCode, errorCategory: "capability", retryable: false };
  }
  if (status === 401 || status === 403 || normalizedCode.includes("UNAUTHORIZED") || normalizedCode.includes("AUTH")) {
    return { errorMessage, errorCode, errorCategory: "auth", retryable: false };
  }
  if (
    normalizedCode.includes("PATH")
    || normalizedCode.includes("TRAVERSAL")
    || normalizedMessage.includes("unsafe path")
    || normalizedMessage.includes("invalid local artifact path")
    || normalizedMessage.includes("outside the sync root")
    || normalizedMessage.includes(".workbench")
  ) {
    return { errorMessage, errorCode, errorCategory: "path_rejection", retryable: false };
  }
  if (normalizedCode.includes("NOT_SUPPORTED") || normalizedCode.includes("UNSUPPORTED")) {
    return { errorMessage, errorCode, errorCategory: "unsupported", retryable: false };
  }
  if (normalizedMessage.includes("conflict") || normalizedMessage.includes("unsynced local")) {
    return { errorMessage, errorCode, errorCategory: "local_conflict", retryable: false };
  }
  if (
    normalizedCode.includes("INVALID")
    || normalizedCode.includes("VALIDATION")
    || normalizedCode.includes("NOT_FOUND")
    || normalizedCode.includes("BASE64")
    || normalizedMessage.includes("exceeds max sync size")
    || status === 404
    || status === 400
  ) {
    return { errorMessage, errorCode, errorCategory: "validation", retryable: false };
  }
  if (
    normalizedCode.includes("TUNNEL")
    || normalizedMessage.includes("cloudflare tunnel is offline")
    || normalizedMessage.includes("cloudflare tunnel unavailable")
  ) {
    return { errorMessage, errorCode, errorCategory: "network", retryable: true };
  }
  if (
    normalizedCode === "SYNC_PUSH_OPERATION_FAILED"
    || (typeof status === "number" && status >= 500)
  ) {
    return { errorMessage, errorCode, errorCategory: "server", retryable: true };
  }
  if (
    normalizedMessage.includes("fetch failed")
    || normalizedMessage.includes("network")
    || normalizedMessage.includes("econnrefused")
    || normalizedMessage.includes("econnreset")
    || normalizedMessage.includes("enotfound")
    || normalizedMessage.includes("etimedout")
    || normalizedCode === "ECONNREFUSED"
    || normalizedCode === "ECONNRESET"
    || normalizedCode === "ENOTFOUND"
    || normalizedCode === "ETIMEDOUT"
    || normalizedCode.startsWith("UND_ERR_")
  ) {
    return { errorMessage, errorCode, errorCategory: "network", retryable: true };
  }
  return { errorMessage, errorCode, errorCategory: "unknown", retryable: false };
}

export function parseRemoteResourceDomain(value: unknown): RemoteResourceDomain | undefined {
  return value === "projects"
    || value === "notes"
    || value === "artifacts"
    || value === "tasks"
    || value === PROJECT_CONTEXT_DOMAIN
    ? value
    : undefined;
}

export function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return undefined;
}

export function remoteResourceIdFromUnknown(value: unknown, fallbackResourceId?: string): string | undefined {
  const record = asRecord(value);
  return asString(record?.id)
    ?? asString(record?._id)
    ?? asString(record?.resourceId)
    ?? fallbackResourceId;
}

export function remoteResourcePayloadFromEvent(event: RemoteSyncEvent): { payload: Record<string, unknown>; merge: boolean } {
  const payload = asRecord(event.payload) ?? {};
  const resource = firstRecord(payload.resource, payload.result);
  if (resource) {
    return { payload: resource, merge: false };
  }
  const patch = asRecord(payload.patch);
  if (patch) {
    return { payload: patch, merge: true };
  }
  return { payload, merge: true };
}

export function remoteResourcePayloadFromSnapshot(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

export function isRemoteResourceTombstone(event: RemoteSyncEvent): boolean {
  const payload = asRecord(event.payload) ?? {};
  return event.action === "delete"
    || payload.deleted === true
    || payload.tombstone === true
    || typeof payload.deletedAt === "string";
}

const LEGACY_PROJECT_CONTEXT_MARKERS = new Set([
  "brief",
  "context",
  "context-summary",
  "index",
  "link",
  "links",
  "membership",
  "memory",
  "project-brief",
  "project-context",
  "project-index",
  "project-link",
  "project-membership",
  "project-memory",
  "project-relation",
  "relation",
  "relations",
  "secondary-membership",
  "secondary_membership",
  "summary"
]);

export function normalizedProjectEventMarker(value: unknown): string | undefined {
  return asString(value)?.toLowerCase().replaceAll("_", "-");
}

export function recordHasLegacyProjectContextShape(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.contentMarkdown === "string"
    || typeof record.bodyMarkdown === "string"
    || asString(record.memoryId) !== undefined
    || asString(record.relationId) !== undefined
    || asString(record.artifactItemId) !== undefined
    || asString(record.associationKind) !== undefined
    || (asString(record.sourceService) !== undefined && asString(record.resourceType) !== undefined)
    || (asString(record.targetService) !== undefined && asString(record.targetResourceType) !== undefined)
    || (asString(record.sourceProjectId) !== undefined && asString(record.targetProjectId) !== undefined);
}

export function isLegacyProjectContextEvent(event: RemoteSyncEvent): boolean {
  if (event.domain !== "projects") return false;
  const payload = asRecord(event.payload) ?? {};
  const relation = normalizedProjectEventMarker(payload.relation);

  // Project default selection is the sole supported relation in the legacy
  // projects sync domain. All other relation markers belong to Project context
  // read models and must not mutate or create base Project cache rows.
  if (relation && relation !== "default") return true;

  for (const value of [payload.kind, payload.type, payload.entityType, payload.resourceType]) {
    const marker = normalizedProjectEventMarker(value);
    if (marker && LEGACY_PROJECT_CONTEXT_MARKERS.has(marker)) return true;
  }

  return asString(payload.memoryId) !== undefined
    || asString(payload.relationId) !== undefined
    || asString(payload.artifactItemId) !== undefined
    || recordHasLegacyProjectContextShape(payload.resource)
    || recordHasLegacyProjectContextShape(payload.patch);
}

export function snapshotItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["items", "data", "results", "projects", "notes", "tasks", "artifacts"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

export function snapshotNextCursor(value: unknown): string | undefined {
  const record = asRecord(value);
  return asString(record?.nextCursor);
}

export function parseRemoteArtifactKind(value: unknown): RemoteArtifactKind | undefined {
  return value === "folder" || value === "note" || value === "file" ? value : undefined;
}

export function remoteArtifactFromUnknown(value: unknown, fallbackResourceId?: string): RemoteArtifactItem | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = asString(record.id) ?? fallbackResourceId;
  const kind = parseRemoteArtifactKind(record.kind);
  if (!id || !kind) return undefined;
  return {
    id,
    kind,
    title: asString(record.title),
    path: asString(record.path),
    parentPath: asString(record.parentPath),
    mimeType: asString(record.mimeType),
    sizeBytes: asNumber(record.sizeBytes),
    version: asNumber(record.version),
    updatedAt: asString(record.updatedAt),
    contentMarkdown: typeof record.contentMarkdown === "string" ? record.contentMarkdown : undefined,
    contentBase64: typeof record.contentBase64 === "string" ? record.contentBase64 : undefined
  };
}

export function remoteArtifactFromEvent(event: RemoteSyncEvent): RemoteArtifactItem | undefined {
  const payload = asRecord(event.payload) ?? {};
  const resource = remoteArtifactFromUnknown(payload.resource, event.resourceId);
  if (resource) return resource;

  const patch = remoteArtifactFromUnknown({
    ...asRecord(payload.patch),
    id: event.resourceId,
    kind: asRecord(payload.patch)?.kind ?? asRecord(payload.patch)?.type
  }, event.resourceId);
  if (patch) return patch;

  return remoteArtifactFromUnknown(payload, event.resourceId);
}

export function isRemoteTombstone(event: RemoteSyncEvent, item?: RemoteArtifactItem): boolean {
  const payload = asRecord(event.payload) ?? {};
  return event.action === "delete"
    || payload.deleted === true
    || payload.tombstone === true
    || typeof payload.deletedAt === "string"
    || (item ? (asRecord(item)?.deleted === true || asRecord(item)?.tombstone === true) : false);
}

export function fallbackRemoteArtifactLeaf(item: RemoteArtifactItem): string {
  if (item.kind === "note") {
    return defaultNotePath(item.title ?? item.id);
  }
  if (item.kind === "file") {
    return sanitizePathSegment(item.title ?? item.id, "file");
  }
  return sanitizePathSegment(item.title ?? item.id, "folder");
}

export function relativePathForRemoteArtifact(item: RemoteArtifactItem): string | undefined {
  if (item.kind === "folder") {
    const requested = item.path ?? (item.parentPath ? `${item.parentPath}/${item.title ?? item.id}` : item.title ?? item.id);
    const relativePath = normalizeArtifactFolderPath(requested);
    return relativePath && !isIgnoredSyncRelativePath(relativePath) ? relativePath : undefined;
  }

  const requested = item.path ?? (item.parentPath ? `${item.parentPath}/${fallbackRemoteArtifactLeaf(item)}` : fallbackRemoteArtifactLeaf(item));
  const relativePath = normalizeArtifactRelativePath(requested, fallbackRemoteArtifactLeaf(item));
  return relativePath && !isIgnoredSyncRelativePath(relativePath) ? relativePath : undefined;
}
