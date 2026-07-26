import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { SyncErrorMetadata } from "./manifestStore.js";
import {
  CoreHttpError,
  assertExpectedDownloadChecksum,
  coreJson
} from "./coreClient.js";
import {
  applyProjectDefaultPushResult,
  retargetOpenProjectOutboxReferences,
  shouldDeferProjectOutboxItem,
  updateLocalProjectDefaultCache
} from "./localProjects.js";
import {
  applyTaskRelationPushResult,
  retargetOpenTaskOutboxReferences,
  shouldDeferTaskOutboxItem
} from "./localTasks.js";
import { artifactKindForOutboxItem } from "./localArtifacts.js";
import {
  LocalProjectContextError,
  PROJECT_CONTEXT_DOMAIN,
  PROJECT_CONTEXT_SCHEMA_VERSION,
  PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY,
  PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY,
  PROJECT_CONTEXT_SUPPORTED_META_KEY,
  cacheProjectContextSnapshot,
  parseProjectContextSnapshot,
  removeStaleProjectContextRows
} from "./projectContextCache.js";
import {
  defaultNotePath,
  hashFile,
  isIgnoredSyncRelativePath,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  normalizeRelativePath,
  resolveSyncRootRelativePath,
  sanitizeFileName,
  sanitizePathSegment
} from "./paths.js";
import {
  asNumber,
  asRecord,
  asString,
  decodeContentBase64,
  refreshManifestStats,
  remoteResourceUpdatedAt,
  resultRecord
} from "./localStore.js";
import type {
  DaemonState,
  RemoteArtifactItem,
  RemoteArtifactKind,
  RemoteSyncEvent,
  SyncPullResponse,
  SyncSnapshotResponse,
  SyncPushResponse
} from "./types.js";
import {
  getRemoteResource,
  getResource,
  hasOpenOutboxForPath,
  listAllRemoteResourcesForDomain,
  listOpenOutboxForResource,
  listOpenOutboxUnderPath,
  listPendingOutbox,
  listResources,
  markOutboxApplied,
  markOutboxFailed,
  markRemoteResourceDeleted,
  recordConflict,
  removeRemoteResource,
  removeResource,
  setMeta,
  upsertRemoteResource,
  upsertResource as upsertManifestResource,
  writeManifestDebugSnapshot,
  type ManifestResource,
  type OutboxItem,
  type RemoteResource,
  type RemoteResourceDomain,
  type SyncErrorCategory
} from "./manifestStore.js";

export type SyncErrorDetails = SyncErrorMetadata & {
  errorMessage: string;
};

export const REMOTE_SYNC_DOMAINS: RemoteResourceDomain[] = ["projects", "notes", "artifacts", "tasks"];
export const REMOTE_SYNC_CURSOR_META_KEY = "remoteSyncCursor";
export const REMOTE_ARTIFACT_CURSOR_META_KEY = "remoteArtifactCursor";
export const REMOTE_SNAPSHOT_PAGE_LIMIT = 100;

export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function findResourceById(state: DaemonState, resourceId: string): ManifestResource | undefined {
  return listResources(state.manifestStore).find((resource) => resource.resourceId === resourceId);
}

export function pathIsSelfOrChild(relativePath: string, parentPath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedParent = normalizeRelativePath(parentPath).replace(/\/+$/, "");
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function resourcesUnderPath(state: DaemonState, relativePath: string): ManifestResource[] {
  return listResources(state.manifestStore).filter((resource) => pathIsSelfOrChild(resource.relativePath, relativePath));
}

export async function localPathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function isLocalArtifactDirty(
  state: DaemonState,
  relativePath: string,
  resource: ManifestResource | undefined
): Promise<boolean> {
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) return true;
  if (resource?.dirty) return true;
  if (!resource) return localPathExists(absolutePath);

  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    return true;
  }
  if (!stat.isFile()) return true;
  if (resource.checksum) {
    return await hashFile(absolutePath) !== resource.checksum;
  }
  if (resource.sizeBytes !== undefined) {
    return stat.size !== resource.sizeBytes;
  }
  return false;
}

export function hasOpenOutboxForRemoteArtifact(state: DaemonState, relativePath?: string, resourceId?: string): boolean {
  if (relativePath && hasOpenOutboxForPath(state.manifestStore, relativePath)) return true;
  if (resourceId && listOpenOutboxForResource(state.manifestStore, resourceId).length > 0) return true;
  return false;
}

export function hasOpenOutboxUnderRemoteFolder(state: DaemonState, relativePath: string, resourceId?: string): boolean {
  if (listOpenOutboxUnderPath(state.manifestStore, relativePath).length > 0) return true;
  if (resourceId && listOpenOutboxForResource(state.manifestStore, resourceId).length > 0) return true;
  return false;
}

export async function directoryHasUntrackedVisibleEntries(
  state: DaemonState,
  relativePath: string,
  trackedResources: ManifestResource[]
): Promise<boolean> {
  if (!resolveSyncRootRelativePath(state.config, relativePath)) return true;
  const trackedPaths = new Set(trackedResources.map((resource) => normalizeRelativePath(resource.relativePath)));
  const stack = [normalizeRelativePath(relativePath)];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const absolutePath = resolveSyncRootRelativePath(state.config, current);
    if (!absolutePath) return true;

    let entries;
    try {
      entries = await fs.readdir(absolutePath, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return true;
    }

    for (const entry of entries) {
      const childRelativePath = normalizeRelativePath(`${current}/${entry.name}`);
      if (isIgnoredSyncRelativePath(childRelativePath)) continue;
      if (entry.isDirectory()) {
        const containsTrackedResource = trackedResources.some((resource) => pathIsSelfOrChild(resource.relativePath, childRelativePath));
        if (!containsTrackedResource) return true;
        stack.push(childRelativePath);
      } else if (!trackedPaths.has(childRelativePath)) {
        return true;
      }
    }
  }

  return false;
}

export async function writeRemoteConflict(
  state: DaemonState,
  input: {
    relativePath: string;
    resourceId?: string;
    action: "create" | "update" | "delete";
    payload: Record<string, unknown>;
    errorMessage: string;
    createdAt: string;
    errorCode?: string;
    errorCategory?: SyncErrorCategory;
    retryable?: boolean;
  }
): Promise<void> {
  const details = classifySyncError({
    message: input.errorMessage,
    code: input.errorCode
  });
  const conflictId = randomUUID();
  const conflictBaseName = sanitizeFileName(input.relativePath.replace(/[\\/]/g, "__")) || "remote-conflict";
  const timestamp = input.createdAt.replace(/[:.]/g, "-");
  const conflictPath = join(state.config.syncRoot, ".workbench", "conflicts", `${timestamp}-${conflictId}-${conflictBaseName}.json`);
  const conflict = recordConflict(state.manifestStore, {
    id: conflictId,
    relativePath: input.relativePath,
    domain: "artifacts",
    action: input.action,
    resourceId: input.resourceId,
    payload: input.payload,
    errorMessage: input.errorMessage,
    errorCode: input.errorCode ?? details.errorCode ?? "LOCAL_SYNC_CONFLICT",
    errorCategory: input.errorCategory ?? details.errorCategory ?? "local_conflict",
    retryable: input.retryable ?? details.retryable ?? false,
    conflictPath,
    status: "open",
    createdAt: input.createdAt
  });
  await fs.mkdir(dirname(conflictPath), { recursive: true });
  await fs.writeFile(conflictPath, `${JSON.stringify({
    conflictId: conflict.id,
    relativePath: input.relativePath,
    action: input.action,
    resourceId: input.resourceId,
    errorMessage: input.errorMessage,
    errorCode: input.errorCode ?? details.errorCode ?? "LOCAL_SYNC_CONFLICT",
    errorCategory: input.errorCategory ?? details.errorCategory ?? "local_conflict",
    retryable: input.retryable ?? details.retryable ?? false,
    remotePayload: input.payload,
    createdAt: input.createdAt
  }, null, 2)}\n`, "utf8");
}

export async function canApplyRemoteArtifact(
  state: DaemonState,
  options: {
    relativePath: string;
    resourceId?: string;
    action: "create" | "update" | "delete";
    payload: Record<string, unknown>;
    createdAt: string;
  }
): Promise<boolean> {
  const pathResource = getResource(state.manifestStore, options.relativePath);
  const idResource = options.resourceId ? findResourceById(state, options.resourceId) : undefined;
  const resource = pathResource ?? idResource;
  if (hasOpenOutboxForRemoteArtifact(state, options.relativePath, options.resourceId)) {
    await writeRemoteConflict(state, {
      ...options,
      errorMessage: "Remote artifact change arrived while local outbox work is open."
    });
    return false;
  }

  if (await isLocalArtifactDirty(state, options.relativePath, pathResource)) {
    await writeRemoteConflict(state, {
      ...options,
      errorMessage: "Remote artifact change conflicts with unsynced local file state."
    });
    return false;
  }

  if (idResource && idResource.relativePath !== options.relativePath) {
    if (hasOpenOutboxForRemoteArtifact(state, idResource.relativePath, options.resourceId)
      || await isLocalArtifactDirty(state, idResource.relativePath, idResource)) {
      await writeRemoteConflict(state, {
        ...options,
        errorMessage: "Remote artifact move conflicts with unsynced local file state."
      });
      return false;
    }
  }

  return !resource?.dirty;
}

export async function canApplyRemoteArtifactFolderDelete(
  state: DaemonState,
  options: {
    relativePath: string;
    resourceId?: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }
): Promise<boolean> {
  if (hasOpenOutboxUnderRemoteFolder(state, options.relativePath, options.resourceId)) {
    await writeRemoteConflict(state, {
      ...options,
      action: "delete",
      errorMessage: "Remote artifact folder delete arrived while local outbox work is open under the folder."
    });
    return false;
  }

  const trackedResources = resourcesUnderPath(state, options.relativePath);
  for (const resource of trackedResources) {
    if (await isLocalArtifactDirty(state, resource.relativePath, resource)) {
      await writeRemoteConflict(state, {
        ...options,
        action: "delete",
        errorMessage: "Remote artifact folder delete conflicts with unsynced local file state under the folder."
      });
      return false;
    }
  }

  if (await directoryHasUntrackedVisibleEntries(state, options.relativePath, trackedResources)) {
    await writeRemoteConflict(state, {
      ...options,
      action: "delete",
      errorMessage: "Remote artifact folder delete conflicts with untracked local files under the folder."
    });
    return false;
  }

  return true;
}

export async function fetchRemoteArtifactBlob(state: DaemonState, artifactId: string): Promise<Buffer | undefined> {
  if (!state.identity) throw new Error("Missing local client identity");
  const response = await fetch(`${state.config.coreUrl}/api/sync/blobs/${encodeURIComponent(`artifact:${artifactId}`)}`, {
    headers: {
      "x-workbench-local-client-id": state.identity.localClientId,
      "x-workbench-local-client-token": state.identity.localClientToken
    }
  });
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > state.config.maxSyncFileBytes) {
    return undefined;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(buffer.toString("utf8") || `HTTP ${response.status}`);
  }
  const checksum = createHash("sha256").update(buffer).digest("hex");
  assertExpectedDownloadChecksum(response.headers.get("x-workbench-content-checksum"), checksum);
  return buffer.byteLength <= state.config.maxSyncFileBytes ? buffer : undefined;
}

export async function remoteArtifactBuffer(
  state: DaemonState,
  item: RemoteArtifactItem,
  relativePath: string,
  createdAt: string,
  payload: Record<string, unknown>
): Promise<Buffer | undefined> {
  if (item.kind === "note") {
    return typeof item.contentMarkdown === "string" ? Buffer.from(item.contentMarkdown, "utf8") : undefined;
  }

  if (typeof item.contentBase64 === "string") {
    const buffer = decodeContentBase64(item.contentBase64);
    if (buffer.byteLength <= state.config.maxSyncFileBytes) return buffer;
    await writeRemoteConflict(state, {
      relativePath,
      resourceId: item.id,
      action: "update",
      payload,
      errorMessage: `Remote artifact file exceeds max sync size of ${state.config.maxSyncFileBytes} bytes.`,
      createdAt
    });
    return undefined;
  }

  if (typeof item.sizeBytes === "number" && item.sizeBytes > state.config.maxSyncFileBytes) {
    await writeRemoteConflict(state, {
      relativePath,
      resourceId: item.id,
      action: "update",
      payload,
      errorMessage: `Remote artifact file exceeds max sync size of ${state.config.maxSyncFileBytes} bytes.`,
      createdAt
    });
    return undefined;
  }

  const buffer = await fetchRemoteArtifactBlob(state, item.id);
  if (buffer) return buffer;
  await writeRemoteConflict(state, {
    relativePath,
    resourceId: item.id,
    action: "update",
    payload,
    errorMessage: `Remote artifact file exceeds max sync size of ${state.config.maxSyncFileBytes} bytes.`,
    createdAt
  });
  return undefined;
}

export async function applyRemoteArtifactItem(
  state: DaemonState,
  item: RemoteArtifactItem,
  options: {
    action: "create" | "update";
    payload: Record<string, unknown>;
    createdAt: string;
  }
): Promise<void> {
  const relativePath = relativePathForRemoteArtifact(item);
  if (!relativePath) return;

  if (item.kind === "folder") {
    const folderPath = resolveSyncRootRelativePath(state.config, relativePath);
    if (!folderPath) return;
    if (hasOpenOutboxForRemoteArtifact(state, relativePath, item.id)) {
      await writeRemoteConflict(state, {
        relativePath,
        resourceId: item.id,
        action: options.action,
        payload: options.payload,
        errorMessage: "Remote artifact folder change arrived while local outbox work is open.",
        createdAt: options.createdAt
      });
      return;
    }
    try {
      const stat = await fs.stat(folderPath);
      if (!stat.isDirectory()) {
        await writeRemoteConflict(state, {
          relativePath,
          resourceId: item.id,
          action: options.action,
          payload: options.payload,
          errorMessage: "Remote artifact folder conflicts with a local file at the same path.",
          createdAt: options.createdAt
        });
        return;
      }
    } catch {
      // Missing directory will be created below.
    }
    const previousById = findResourceById(state, item.id);
    await fs.mkdir(folderPath, { recursive: true });
    const stat = await fs.stat(folderPath);
    upsertManifestResource(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      kind: "folder",
      resourceId: item.id,
      dirty: false,
      lastSeenAt: options.createdAt,
      lastSyncedAt: options.createdAt,
      localUpdatedAt: stat.mtime.toISOString()
    });
    if (previousById && previousById.relativePath !== relativePath) {
      removeResource(state.manifestStore, previousById.relativePath);
    }
    return;
  }

  if (!await canApplyRemoteArtifact(state, {
    relativePath,
    resourceId: item.id,
    action: options.action,
    payload: options.payload,
    createdAt: options.createdAt
  })) {
    return;
  }

  const buffer = await remoteArtifactBuffer(state, item, relativePath, options.createdAt, options.payload);
  if (!buffer) return;

  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) return;
  const previousById = findResourceById(state, item.id);
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  const stat = await fs.stat(absolutePath);
  const now = options.createdAt;
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: item.kind,
    resourceId: item.id,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: stat.size,
    dirty: false,
    lastSeenAt: now,
    lastSyncedAt: now,
    localUpdatedAt: stat.mtime.toISOString()
  });

  if (previousById && previousById.relativePath !== relativePath) {
    const previousPath = resolveSyncRootRelativePath(state.config, previousById.relativePath);
    if (previousPath) {
      await fs.rm(previousPath, { force: true }).catch(() => {
        // Best-effort cleanup after a clean remote move.
      });
    }
    removeResource(state.manifestStore, previousById.relativePath);
  }
}

export async function applyRemoteArtifactDelete(
  state: DaemonState,
  event: RemoteSyncEvent,
  item: RemoteArtifactItem | undefined,
  createdAt: string
): Promise<void> {
  const resourceId = event.resourceId ?? item?.id;
  const existing = resourceId ? findResourceById(state, resourceId) : undefined;
  const relativePath = existing?.relativePath ?? (item ? relativePathForRemoteArtifact(item) : undefined);
  if (!relativePath) return;

  const payload = asRecord(event.payload) ?? {};
  if (item?.kind === "folder") {
    if (!await canApplyRemoteArtifactFolderDelete(state, {
      relativePath,
      resourceId,
      payload,
      createdAt
    })) {
      return;
    }
    const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
    if (absolutePath) {
      await fs.rm(absolutePath, { recursive: true, force: true });
    }
    for (const resource of resourcesUnderPath(state, relativePath)) {
      removeResource(state.manifestStore, resource.relativePath);
    }
    return;
  }

  if (!await canApplyRemoteArtifact(state, {
    relativePath,
    resourceId,
    action: "delete",
    payload,
    createdAt
  })) {
    return;
  }

  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (absolutePath) {
    await fs.rm(absolutePath, { force: true });
  }
  removeResource(state.manifestStore, relativePath);
}

export async function applyRemoteArtifactEvent(state: DaemonState, event: RemoteSyncEvent): Promise<void> {
  if (event.domain !== "artifacts") return;
  const payload = asRecord(event.payload) ?? {};
  if (asString(payload.localClientId) === state.identity?.localClientId) return;
  const createdAt = asString(event.createdAt) ?? new Date().toISOString();
  const item = remoteArtifactFromEvent(event);
  if (isRemoteTombstone(event, item)) {
    await applyRemoteArtifactDelete(state, event, item, createdAt);
    return;
  }
  if (!item) return;
  await applyRemoteArtifactItem(state, item, {
    action: event.action === "create" ? "create" : "update",
    payload,
    createdAt
  });
}

export async function applyRemoteArtifactSnapshotEntry(
  state: DaemonState,
  value: unknown,
  generatedAt: string
): Promise<void> {
  const item = remoteArtifactFromUnknown(value);
  if (!item) return;
  await applyRemoteArtifactItem(state, item, {
    action: "update",
    payload: { source: "sync-snapshot", resource: value },
    createdAt: generatedAt
  });
}

export function remoteResourceRecord(
  domain: RemoteResourceDomain,
  resourceId: string,
  payload: Record<string, unknown>,
  options: { version?: number; deleted?: boolean; timestamp: string }
): RemoteResource {
  return {
    domain,
    resourceId,
    version: options.version,
    deleted: options.deleted ?? false,
    payload,
    updatedAt: remoteResourceUpdatedAt(payload, options.timestamp),
    lastSyncedAt: options.timestamp
  };
}

export function applyRemoteDomainSnapshotEntry(
  state: DaemonState,
  domain: RemoteResourceDomain,
  value: unknown,
  generatedAt: string
): void {
  if (domain === "artifacts") return;
  const payload = remoteResourcePayloadFromSnapshot(value);
  if (!payload) return;
  const resourceId = remoteResourceIdFromUnknown(payload);
  if (!resourceId) return;
  upsertRemoteResource(state.manifestStore, remoteResourceRecord(domain, resourceId, payload, {
    version: asNumber(payload.version),
    timestamp: generatedAt
  }));
}

export function applyRemoteProjectDefaultEvent(
  state: DaemonState,
  event: RemoteSyncEvent,
  payload: Record<string, unknown>,
  createdAt: string
): boolean {
  if (event.domain !== "projects" || normalizedProjectEventMarker(payload.relation) !== "default") {
    return false;
  }
  const selection = asRecord(payload.resource);
  const project = asRecord(selection?.project);
  const projectId = asString(project?.id) ?? asString(payload.projectId) ?? event.resourceId;
  if (!project || !projectId) return false;

  const existing = getRemoteResource(state.manifestStore, "projects", projectId);
  const nextPayload = {
    ...(existing?.payload ?? {}),
    ...project,
    id: projectId,
    isUserDefault: true
  };
  upsertRemoteResource(state.manifestStore, remoteResourceRecord("projects", projectId, nextPayload, {
    version: event.version ?? asNumber(project.version) ?? existing?.version,
    timestamp: createdAt
  }));
  updateLocalProjectDefaultCache(state, projectId, createdAt);
  return true;
}

export function projectContextSnapshotPage(value: unknown): { items: unknown[]; nextCursor?: string } {
  const page = asRecord(value);
  if (!page || !Array.isArray(page.items)) {
    throw new LocalProjectContextError(
      502,
      "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
      "Core returned an invalid Project context snapshot page."
    );
  }
  let nextCursor: string | undefined;
  if (page.nextCursor !== undefined) {
    if (
      typeof page.nextCursor !== "string"
      || page.nextCursor.length === 0
      || page.nextCursor.trim() !== page.nextCursor
    ) {
      throw new LocalProjectContextError(
        502,
        "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
        "Core returned an invalid Project context snapshot cursor."
      );
    }
    nextCursor = page.nextCursor;
  }
  return { items: page.items, nextCursor };
}

export function projectContextEventIsStale(state: DaemonState, event: RemoteSyncEvent): boolean {
  if (event.version === undefined || !event.resourceId) return false;
  const current = getRemoteResource(state.manifestStore, PROJECT_CONTEXT_DOMAIN, event.resourceId);
  return current?.version !== undefined && event.version <= current.version;
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

export async function fetchProjectContextDetail(
  state: DaemonState,
  projectId: string,
  version?: number
): Promise<void> {
  if (!state.identity) throw new Error("Missing local client identity");
  try {
    const detail = await coreJson<unknown>(
      state.config,
      `/api/sync/project-context/${encodeURIComponent(projectId)}`,
      { method: "GET", localIdentity: state.identity }
    );
    const snapshot = parseProjectContextSnapshot(detail);
    if (!snapshot || snapshot.projectId !== projectId) {
      throw new LocalProjectContextError(
        502,
        "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
        "Core returned Project context for a different Project."
      );
    }
    cacheProjectContextSnapshot(state.manifestStore, snapshot, {
      version,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof CoreHttpError && error.status === 404) {
      const deletedAt = new Date().toISOString();
      markRemoteResourceDeleted(state.manifestStore, {
        domain: PROJECT_CONTEXT_DOMAIN,
        resourceId: projectId,
        version,
        payload: { schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION, projectId, deleted: true },
        deletedAt,
        lastSyncedAt: deletedAt
      });
      return;
    }
    throw error;
  }
}

export function applyRemoteDomainEvent(state: DaemonState, event: RemoteSyncEvent): void {
  const domain = parseRemoteResourceDomain(event.domain);
  if (!domain || domain === "artifacts") return;
  if (isLegacyProjectContextEvent(event)) return;
  const payload = asRecord(event.payload) ?? {};
  if (asString(payload.localClientId) === state.identity?.localClientId) return;

  const createdAt = asString(event.createdAt) ?? new Date().toISOString();
  if (applyRemoteProjectDefaultEvent(state, event, payload, createdAt)) return;
  const { payload: recordPayload, merge } = remoteResourcePayloadFromEvent(event);
  const resourceId = event.resourceId ?? remoteResourceIdFromUnknown(recordPayload);
  if (!resourceId) return;

  if (isRemoteResourceTombstone(event)) {
    markRemoteResourceDeleted(state.manifestStore, {
      domain,
      resourceId,
      version: event.version,
      payload: recordPayload,
      deletedAt: createdAt,
      lastSyncedAt: createdAt
    });
    return;
  }

  const existing = getRemoteResource(state.manifestStore, domain, resourceId);
  const nextPayload = merge
    ? {
        ...(existing?.payload ?? { id: resourceId }),
        ...recordPayload
      }
    : recordPayload;
  upsertRemoteResource(state.manifestStore, remoteResourceRecord(domain, resourceId, nextPayload, {
    version: event.version ?? asNumber(nextPayload.version),
    timestamp: createdAt
  }));
}

export async function getSyncPullPage(state: DaemonState, cursor: string | undefined, limit: number): Promise<SyncPullResponse> {
  if (!state.identity) throw new Error("Missing local client identity");
  const query = new URLSearchParams();
  if (cursor !== undefined) {
    query.set("cursor", cursor);
  }
  query.set("limit", String(limit));
  return coreJson<SyncPullResponse>(state.config, `/api/sync/pull?${query.toString()}`, {
    method: "GET",
    localIdentity: state.identity
  });
}

export async function getSyncSnapshot(
  state: DaemonState,
  domains: RemoteResourceDomain[],
  options: { cursor?: string; limit?: number; baselineCursor?: string } = {}
): Promise<SyncSnapshotResponse> {
  if (!state.identity) throw new Error("Missing local client identity");
  const query = new URLSearchParams();
  query.set("domains", domains.join(","));
  if (options.cursor) {
    query.set("cursor", options.cursor);
  }
  if (options.limit) {
    query.set("limit", String(options.limit));
  }
  if (options.baselineCursor) {
    query.set("baselineCursor", options.baselineCursor);
  }
  return coreJson<SyncSnapshotResponse>(state.config, `/api/sync/snapshot?${query.toString()}`, {
    method: "GET",
    localIdentity: state.identity
  });
}

export async function applyRemoteSnapshot(
  state: DaemonState,
  snapshot: SyncSnapshotResponse,
  generatedAt: string
): Promise<void> {
  for (const domain of REMOTE_SYNC_DOMAINS) {
    for (const item of snapshotItems(snapshot.domains?.[domain])) {
      if (domain === "artifacts") {
        await applyRemoteArtifactSnapshotEntry(state, item, generatedAt);
      } else {
        applyRemoteDomainSnapshotEntry(state, domain, item, generatedAt);
      }
    }
  }
}

export async function bootstrapPagedDomainSnapshot(
  state: DaemonState,
  domain: "projects" | "notes" | "tasks",
  firstPage: unknown,
  initialGeneratedAt: string
): Promise<void> {
  let cursor = snapshotNextCursor(firstPage);
  for (let pageIndex = 0; cursor && pageIndex < 100; pageIndex += 1) {
    const page = await getSyncSnapshot(state, [domain], {
      cursor,
      limit: REMOTE_SNAPSHOT_PAGE_LIMIT
    });
    const generatedAt = asString(page.generatedAt) ?? initialGeneratedAt;
    for (const item of snapshotItems(page.domains?.[domain])) {
      applyRemoteDomainSnapshotEntry(state, domain, item, generatedAt);
    }
    const nextCursor = snapshotNextCursor(page.domains?.[domain]);
    if (!nextCursor || nextCursor === cursor) {
      return;
    }
    cursor = nextCursor;
  }
}

export async function bootstrapPagedArtifactSnapshot(
  state: DaemonState,
  firstPage: unknown,
  initialGeneratedAt: string
): Promise<void> {
  let cursor = snapshotNextCursor(firstPage);
  for (let pageIndex = 0; cursor && pageIndex < 100; pageIndex += 1) {
    const page = await getSyncSnapshot(state, ["artifacts"], {
      cursor,
      limit: REMOTE_SNAPSHOT_PAGE_LIMIT
    });
    const generatedAt = asString(page.generatedAt) ?? initialGeneratedAt;
    for (const item of snapshotItems(page.domains?.artifacts)) {
      await applyRemoteArtifactSnapshotEntry(state, item, generatedAt);
    }
    const nextCursor = snapshotNextCursor(page.domains?.artifacts);
    if (!nextCursor || nextCursor === cursor) {
      return;
    }
    cursor = nextCursor;
  }
}

export async function bootstrapPagedDomainSnapshots(
  state: DaemonState,
  snapshot: SyncSnapshotResponse,
  initialGeneratedAt: string
): Promise<void> {
  await bootstrapPagedArtifactSnapshot(state, snapshot.domains?.artifacts, initialGeneratedAt);
  for (const domain of ["projects", "notes", "tasks"] as const) {
    await bootstrapPagedDomainSnapshot(state, domain, snapshot.domains?.[domain], initialGeneratedAt);
  }
}

export function snapshotSupportsProjectContext(snapshot: SyncSnapshotResponse): boolean {
  return Array.isArray(snapshot.supportedDomains)
    && snapshot.supportedDomains.includes(PROJECT_CONTEXT_DOMAIN);
}

export function pruneLegacyProjectContextRows(state: DaemonState, activeProjectIds: Set<string>): void {
  for (const resource of listAllRemoteResourcesForDomain(state.manifestStore, "projects", { includeDeleted: true })) {
    if (activeProjectIds.has(resource.resourceId)) continue;
    if (listOpenOutboxForResource(state.manifestStore, resource.resourceId).length > 0) continue;
    if (!recordHasLegacyProjectContextShape(resource.payload)) continue;
    removeRemoteResource(state.manifestStore, "projects", resource.resourceId);
  }
}

export async function bootstrapProjectContextSnapshot(
  state: DaemonState,
  suppliedBaselineCursor?: string
): Promise<{ supported: boolean; baselineCursor?: string }> {
  const firstPage = await getSyncSnapshot(state, [PROJECT_CONTEXT_DOMAIN], {
    limit: REMOTE_SNAPSHOT_PAGE_LIMIT,
    baselineCursor: suppliedBaselineCursor
  });
  if (!snapshotSupportsProjectContext(firstPage)) {
    throw new LocalProjectContextError(
      502,
      "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
      "Core removed the Project context capability during bootstrap."
    );
  }

  const baselineCursor = suppliedBaselineCursor ?? asString(firstPage.baselineCursor);
  if (
    !baselineCursor
    || !/^\d+$/.test(baselineCursor)
    || (suppliedBaselineCursor && firstPage.baselineCursor !== suppliedBaselineCursor)
  ) {
    throw new LocalProjectContextError(
      502,
      "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
      "Core returned an invalid Project context baseline cursor."
    );
  }

  const activeProjectIds = new Set<string>();
  const pendingSnapshots: Array<{ snapshot: NonNullable<ReturnType<typeof parseProjectContextSnapshot>>; timestamp: string }> = [];
  const acceptPage = (page: SyncSnapshotResponse): string | undefined => {
    const parsedPage = projectContextSnapshotPage(page.domains?.[PROJECT_CONTEXT_DOMAIN]);
    for (const item of parsedPage.items) {
      const snapshot = parseProjectContextSnapshot(item);
      if (!snapshot || snapshot.baselineCursor !== baselineCursor || activeProjectIds.has(snapshot.projectId)) {
        throw new LocalProjectContextError(
          502,
          "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
          "Core returned an incomplete, duplicate, or baseline-mismatched Project context item."
        );
      }
      activeProjectIds.add(snapshot.projectId);
      pendingSnapshots.push({
        snapshot,
        timestamp: asString(page.generatedAt) ?? new Date().toISOString()
      });
    }
    return parsedPage.nextCursor;
  };

  let cursor = acceptPage(firstPage);
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; cursor && pageIndex < 100; pageIndex += 1) {
    if (seenCursors.has(cursor)) {
      throw new LocalProjectContextError(
        502,
        "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
        "Core repeated a Project context snapshot cursor."
      );
    }
    seenCursors.add(cursor);
    const page = await getSyncSnapshot(state, [PROJECT_CONTEXT_DOMAIN], {
      cursor,
      limit: REMOTE_SNAPSHOT_PAGE_LIMIT,
      baselineCursor
    });
    if (!snapshotSupportsProjectContext(page) || page.baselineCursor !== baselineCursor) {
      throw new LocalProjectContextError(
        502,
        "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
        "Core changed the Project context capability or baseline during pagination."
      );
    }
    cursor = acceptPage(page);
  }
  if (cursor) {
    throw new LocalProjectContextError(
      413,
      "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED",
      "Project context snapshot pagination exceeded the daemon safety limit."
    );
  }

  state.manifestStore.db.exec("BEGIN IMMEDIATE");
  try {
    for (const pending of pendingSnapshots) {
      cacheProjectContextSnapshot(state.manifestStore, pending.snapshot, { timestamp: pending.timestamp });
    }
    removeStaleProjectContextRows(state.manifestStore, activeProjectIds);
    pruneLegacyProjectContextRows(state, activeProjectIds);
    setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, "1");
    setMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, "1");
    setMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY, baselineCursor);
    state.manifestStore.db.exec("COMMIT");
  } catch (error) {
    state.manifestStore.db.exec("ROLLBACK");
    throw error;
  }
  return { supported: true, baselineCursor };
}

export function setSyncErrorState(state: DaemonState, details: SyncErrorDetails): void {
  state.lastError = details.errorMessage;
  state.lastErrorCode = details.errorCode;
  state.lastErrorCategory = details.errorCategory;
  state.lastErrorRetryable = details.retryable;
}

export function clearSyncErrorState(state: DaemonState): void {
  state.lastError = undefined;
  state.lastErrorCode = undefined;
  state.lastErrorCategory = undefined;
  state.lastErrorRetryable = undefined;
  state.lastLoggedError = undefined;
}

export function logSyncDaemonErrorOnce(
  state: Pick<DaemonState, "lastLoggedError">,
  message: string,
  warn: (message: string) => void = (value) => console.warn(value)
): boolean {
  if (state.lastLoggedError === message) {
    return false;
  }
  state.lastLoggedError = message;
  warn(`[sync-daemon] ${message}`);
  return true;
}

export async function postSyncPush(state: DaemonState, ops: OutboxItem[]): Promise<SyncPushResponse> {
  if (!state.identity) throw new Error("Missing local client identity");
  const response = await fetch(`${state.config.coreUrl}/api/sync/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-workbench-local-client-id": state.identity.localClientId,
      "x-workbench-local-client-token": state.identity.localClientToken
    },
    body: JSON.stringify({
      ops: ops.map((item) => ({
        clientOpId: item.clientOpId,
        domain: item.domain,
        action: item.action,
        ...(asString(item.payload.relation) ? { relation: asString(item.payload.relation) } : {}),
        resourceId: item.resourceId,
        payload: item.payload
      }))
    })
  });
  const text = await response.text();
  const parsed = text.trim() ? JSON.parse(text) as SyncPushResponse : {};
  if (!response.ok && !parsed.rejected?.length) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  return parsed;
}

export function extractResourceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id === "string" && id.trim()) return id;
  const item = (value as { item?: unknown }).item;
  if (item && typeof item === "object") {
    const itemId = (item as { id?: unknown }).id;
    if (typeof itemId === "string" && itemId.trim()) return itemId;
  }
  return undefined;
}

export async function writeConflictRecord(
  state: DaemonState,
  item: OutboxItem,
  error: SyncErrorDetails,
  createdAt: string
): Promise<void> {
  const conflictId = randomUUID();
  const conflictBaseName = sanitizeFileName(item.relativePath.replace(/[\\/]/g, "__")) || "conflict";
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const conflictPath = join(state.config.syncRoot, ".workbench", "conflicts", `${timestamp}-${conflictId}-${conflictBaseName}.json`);
  const conflict = recordConflict(state.manifestStore, {
    id: conflictId,
    outboxId: item.id,
    clientOpId: item.clientOpId,
    relativePath: item.relativePath,
    domain: item.domain,
    action: item.action,
    resourceId: item.resourceId,
    payload: item.payload,
    errorMessage: error.errorMessage,
    errorCode: error.errorCode,
    errorCategory: error.errorCategory,
    retryable: error.retryable,
    conflictPath,
    status: "open",
    createdAt
  });
  await fs.mkdir(dirname(conflictPath), { recursive: true });
  await fs.writeFile(conflictPath, `${JSON.stringify({
    conflictId: conflict.id,
    relativePath: item.relativePath,
    action: item.action,
    resourceId: item.resourceId,
    clientOpId: item.clientOpId,
    errorMessage: error.errorMessage,
    errorCode: error.errorCode,
    errorCategory: error.errorCategory,
    retryable: error.retryable,
    payload: item.payload,
    createdAt
  }, null, 2)}\n`, "utf8");

  const resource = getResource(state.manifestStore, item.relativePath);
  if (resource) {
    upsertManifestResource(state.manifestStore, {
      ...resource,
      dirty: true,
      lastError: error.errorMessage
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
}

export async function pushOutbox(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  const pending = listPendingOutbox(state.manifestStore, 20).filter((item) =>
    !shouldDeferProjectOutboxItem(state, item) && !shouldDeferTaskOutboxItem(state, item)
  );
  if (pending.length === 0) {
    await refreshManifestStats(state);
    return;
  }

  const result = await postSyncPush(state, pending);
  const applied = result.applied ?? [];
  const rejected = result.rejected ?? [];
  const now = new Date().toISOString();
  if (result.serverCursor) {
    setMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY, result.serverCursor);
    setMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY, result.serverCursor);
    state.remoteArtifactCursor = result.serverCursor;
  }
  for (const appliedItem of applied) {
    const item = pending[appliedItem.index];
    if (!item) continue;
    markOutboxApplied(state.manifestStore, item.id, now);
    if (item.domain === PROJECT_CONTEXT_DOMAIN) {
      // The invalidation emitted by Core will refetch and replace the optimistic context pack.
      // Applying an op-level result as a remote resource would corrupt the snapshot envelope.
      continue;
    }
    const resourceId = appliedItem.resourceId ?? extractResourceId(appliedItem.result);
    if (item.domain !== "artifacts") {
      const domain = item.domain;
      const nextResourceId = resourceId ?? item.resourceId;
      if (!nextResourceId) continue;
      if (applyProjectDefaultPushResult(state, item, appliedItem, now)) {
        continue;
      }
      if (applyTaskRelationPushResult(state, item, appliedItem, now)) {
        continue;
      }
      if (item.resourceId && item.resourceId !== nextResourceId) {
        removeRemoteResource(state.manifestStore, domain, item.resourceId);
        if (domain === "projects") {
          retargetOpenProjectOutboxReferences(state, item.resourceId, nextResourceId, now);
        } else if (domain === "tasks") {
          retargetOpenTaskOutboxReferences(state, item.resourceId, nextResourceId, now);
        }
      }
      if (item.action === "delete") {
        markRemoteResourceDeleted(state.manifestStore, {
          domain,
          resourceId: nextResourceId,
          version: appliedItem.version,
          payload: item.payload,
          deletedAt: now,
          lastSyncedAt: now
        });
      } else {
        const payload = {
          ...item.payload,
          ...(resultRecord(appliedItem.result) ?? {}),
          id: nextResourceId
        };
        upsertRemoteResource(state.manifestStore, {
          domain,
          resourceId: nextResourceId,
          version: appliedItem.version,
          payload,
          updatedAt: remoteResourceUpdatedAt(payload, now),
          lastSyncedAt: now
        });
      }
      continue;
    }
    const existing = getResource(state.manifestStore, item.relativePath);
    if (item.action === "delete") {
      if (existing?.kind === "folder" || item.payload.kind === "folder") {
        for (const resource of resourcesUnderPath(state, item.relativePath)) {
          removeResource(state.manifestStore, resource.relativePath);
        }
      } else {
        removeResource(state.manifestStore, item.relativePath);
      }
    } else {
      upsertManifestResource(state.manifestStore, {
        ...(existing ?? { relativePath: item.relativePath, domain: "artifacts", kind: artifactKindForOutboxItem(item) }),
        resourceId: resourceId ?? existing?.resourceId,
        dirty: false,
        lastSyncedAt: now
      });
    }
  }
  for (const rejectedItem of rejected) {
    const item = pending[rejectedItem.index];
    if (!item) continue;
    const error = classifySyncError({
      code: rejectedItem.code,
      message: rejectedItem.message ?? rejectedItem.code ?? "Sync push rejected"
    });
    markOutboxFailed(state.manifestStore, item.id, error.errorMessage, now, error);
    await writeConflictRecord(state, item, error, now);
  }
  setMeta(state.manifestStore, "lastPushAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}
