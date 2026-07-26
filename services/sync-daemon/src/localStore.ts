import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import type { DaemonConfig } from "./config.js";
import {
  enqueueOutbox as enqueueManifestOutboxRaw,
  getMeta,
  getRemoteResource,
  listOpenOutboxForPath,
  listRemoteResources,
  markOutboxSuperseded,
  readManifestStats,
  type ManifestResource,
  type ManifestStore,
  type OutboxItem,
  type RemoteResourceDomain
} from "./manifestStore.js";
import {
  directoryPathFor,
  normalizeArtifactRelativePath,
  normalizeRelativePath,
  resolveSyncRootRelativePath
} from "./paths.js";
import type { DaemonState } from "./types.js";

export const CLIENT_OP_ID_HEADER = "x-workbench-client-op-id";
export const localWriteContext = new AsyncLocalStorage<{ clientOpId?: string }>();

type EnqueueManifestOutboxInput = Parameters<typeof enqueueManifestOutboxRaw>[1];

export function enqueueManifestOutbox(store: ManifestStore, item: EnqueueManifestOutboxInput): OutboxItem {
  return enqueueManifestOutboxRaw(store, item, localWriteContext.getStore()?.clientOpId);
}

export function runWithClientOpId<T>(clientOpId: string | undefined, operation: () => T): T {
  const normalized = clientOpId?.trim() || undefined;
  return localWriteContext.run({ clientOpId: normalized }, operation);
}

export async function refreshManifestStats(state: DaemonState): Promise<void> {
  const stats = readManifestStats(state.manifestStore);
  state.outboxPending = stats.outboxPending;
  state.outboxFailed = stats.outboxFailed;
  state.conflictsOpen = stats.conflictsOpen;
  state.lastScanAt = stats.lastScanAt ?? state.lastScanAt;
  state.lastPushAt = stats.lastPushAt ?? state.lastPushAt;
  state.lastRemotePullAt = getMeta(state.manifestStore, "lastRemotePullAt") ?? state.lastRemotePullAt;
  state.remoteArtifactCursor = getMeta(state.manifestStore, "remoteArtifactCursor") ?? state.remoteArtifactCursor;
}

export async function uniqueRelativePath(
  config: DaemonConfig,
  requestedRelativePath: string,
  excludeRelativePath?: string,
  fallbackLeaf = "untitled.md"
): Promise<string> {
  const normalized = normalizeArtifactRelativePath(requestedRelativePath, fallbackLeaf);
  if (!normalized) return "";
  const parent = directoryPathFor(normalized);
  const leaf = basename(normalized);
  const parsed = leaf.match(/^(.*?)(\.[^.]+)?$/);
  const base = parsed?.[1] || "untitled";
  const ext = parsed?.[2] || "";
  for (let index = 0; index < 1000; index += 1) {
    const candidateLeaf = index === 0 ? `${base}${ext}` : `${base} (${index})${ext}`;
    const candidate = parent ? `${parent}/${candidateLeaf}` : candidateLeaf;
    if (excludeRelativePath && normalizeRelativePath(excludeRelativePath) === candidate) {
      return candidate;
    }
    const absolutePath = resolveSyncRootRelativePath(config, candidate);
    if (!absolutePath) continue;
    try {
      await fs.access(absolutePath);
    } catch {
      return candidate;
    }
  }
  return parent ? `${parent}/${base}-${Date.now()}${ext}` : `${base}-${Date.now()}${ext}`;
}

export function localProjectId(state: DaemonState): string {
  return `local:${state.config.syncRootId}`;
}

export function localProjectName(state: DaemonState): string {
  return state.config.syncRootLabel;
}

export function localItemId(kind: "folder" | "note" | "file", relativePath: string): string {
  return `local-${kind}:${Buffer.from(normalizeRelativePath(relativePath), "utf8").toString("base64url")}`;
}

export function decodeLocalItemId(id: string): { kind: "folder" | "note" | "file"; relativePath: string } | undefined {
  const match = id.match(/^local-(folder|note|file):(.+)$/);
  if (!match) return undefined;
  try {
    return {
      kind: match[1] as "folder" | "note" | "file",
      relativePath: normalizeRelativePath(Buffer.from(match[2], "base64url").toString("utf8"))
    };
  } catch {
    return undefined;
  }
}

export function itemUpdatedAt(resource: ManifestResource): string {
  return resource.localUpdatedAt ?? resource.lastSeenAt ?? resource.lastSyncedAt ?? new Date(0).toISOString();
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function remoteResourceUpdatedAt(payload: Record<string, unknown>, fallback: string): string {
  return asString(payload.updatedAt)
    ?? asString(payload.updated_at)
    ?? asString(payload.modifiedAt)
    ?? asString(payload.createdAt)
    ?? fallback;
}

export function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function listLocalRemoteDomainItems(
  state: DaemonState,
  domain: Exclude<RemoteResourceDomain, "artifacts">,
  options: { includeDeleted?: boolean; limit?: number } = {}
): Record<string, unknown>[] {
  return listRemoteResources(state.manifestStore, {
    domain,
    includeDeleted: options.includeDeleted,
    limit: options.limit
  }).map((resource) => ({
    ...resource.payload,
    id: asString(resource.payload.id) ?? resource.resourceId,
    version: asNumber(resource.payload.version) ?? resource.version,
    deleted: resource.deleted ? true : resource.payload.deleted,
    updatedAt: asString(resource.payload.updatedAt) ?? resource.updatedAt,
    lastSyncedAt: resource.lastSyncedAt
  }));
}

export function localRemoteDomainItem(
  state: DaemonState,
  domain: Exclude<RemoteResourceDomain, "artifacts">,
  resourceId: string,
  options: { includeDeleted?: boolean } = {}
): Record<string, unknown> | undefined {
  const resource = getRemoteResource(state.manifestStore, domain, resourceId);
  if (!resource || (resource.deleted && !options.includeDeleted)) return undefined;
  return {
    ...resource.payload,
    id: asString(resource.payload.id) ?? resource.resourceId,
    version: asNumber(resource.payload.version) ?? resource.version,
    deleted: resource.deleted ? true : resource.payload.deleted,
    updatedAt: asString(resource.payload.updatedAt) ?? resource.updatedAt,
    lastSyncedAt: resource.lastSyncedAt
  };
}

export function supersedeOpenOutboxForPath(
  state: DaemonState,
  relativePath: string,
  predicate: (item: OutboxItem) => boolean,
  reason: string,
  updatedAt: string
): OutboxItem[] {
  const superseded: OutboxItem[] = [];
  for (const item of listOpenOutboxForPath(state.manifestStore, relativePath)) {
    if (!predicate(item)) continue;
    markOutboxSuperseded(state.manifestStore, item.id, reason, updatedAt);
    superseded.push(item);
  }
  return superseded;
}
