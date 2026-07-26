import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  readIdentity
} from "./identityStorage.js";
import {
  ensureDirs,
  ensureLoopbackApiToken,
  env,
  readConfig,
  type DaemonConfig
} from "./config.js";
import {
  artifactKindForPath,
  defaultNotePath,
  isIgnoredSyncPath,
  isIgnoredSyncRelativePath,
  isPathInsideDirectory,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  normalizeRelativePath,
  relativeSyncPath,
  sanitizeFileName,
  sanitizePathSegment,
  sleep,
} from "./paths.js";
import {
  applyProjectDefaultPushResult,
  createLocalProject,
  createLocalProjectMemory,
  createLocalProjectRelation,
  deleteLocalProject,
  deleteLocalProjectRelation,
  finishLocalProjectContextWrite,
  invalidLocalProjectContextWrite,
  isLocalProjectId,
  LOCAL_PROJECT_ID_PREFIX,
  localDefaultProjectSelection,
  localRelationPatch,
  localProjectDefaultSelection,
  normalizeLocalProjectPayload,
  pendingLocalProjectContextResource,
  projectContextOutboxPath,
  projectDefaultOutboxPath,
  projectDefaultRelationPayload,
  projectOutboxPath,
  retargetOpenProjectOutboxReferences,
  setLocalDefaultProject,
  shouldDeferProjectOutboxItem,
  supersedeOpenProjectDefaultForResource,
  updateLocalProject,
  updateLocalProjectBrief,
  updateLocalProjectDefaultCache,
  updateLocalProjectMemory,
  updateLocalProjectRelation
} from "./localProjects.js";
import {
  createLocalNote,
  deleteLocalNote,
  isLocalNoteId,
  LOCAL_NOTE_ID_PREFIX,
  localNoteProjectSummaries,
  normalizeStringArray,
  noteOutboxPath,
  updateLocalNote
} from "./localNotes.js";
import {
  addLocalTaskToToday,
  applyTaskRelationPushResult,
  createLocalTask,
  createLocalTaskAttachment,
  createLocalTaskSubtask,
  deleteLocalTask,
  deleteLocalTaskAttachment,
  deleteLocalTaskSubtask,
  exportLocalTasksCsv,
  importLocalTasksCsv,
  localScheduleCalendar,
  localTaskHistory,
  localTaskPayloadForUpdate,
  localTaskPinnedIds,
  localTaskProjectSummaries,
  localTaskSchedule,
  localTodayTasks,
  recordLocalTaskOccurrence,
  removeLocalTaskFromToday,
  removeLocalTaskScheduleItem,
  retargetOpenTaskOutboxReferences,
  scheduleItemId,
  setLocalTaskPin,
  shouldDeferTaskOutboxItem,
  taskAttachments,
  taskScheduleItems,
  taskSubtasks,
  updateLocalTask,
  updateLocalTaskAttachment,
  updateLocalTaskScheduleItem,
  updateLocalTaskSubtask
} from "./localTasks.js";
import {
  artifactKindForOutboxItem,
  createLocalArtifactFile,
  createLocalArtifactFolder,
  createLocalArtifactNote,
  deleteLocalArtifactItem,
  getLocalArtifactItemById,
  listLocalArtifactItems,
  patchLocalArtifactNoteContent,
  updateLocalArtifactItem,
  updateLocalArtifactNoteSection,
  scanSyncFolder
} from "./localArtifacts.js";
import {
  LOOPBACK_CORS_ERROR_CODE,
  LOOPBACK_CORS_ERROR_MESSAGE,
  existingClientOpWriteResult,
  getFormDataString,
  isLocalProjectContextMutation,
  isSupportedLocalProjectContextWrite,
  optionalNumberQuery,
  parseBooleanQuery,
  parseConflictResolution,
  parseConflictStatus,
  readRequestFormData,
  readRequestJson,
  readRequestText,
  requestClientOpId,
  requestString,
  requireLoopbackAuth,
  sendLocalArtifactDownload,
  setLoopbackCorsHeaders,
  writeCaptureError,
  writeJson,
  writeLocalProjectContextError,
  writeProjectContextExportError
} from "./httpApi.js";
import {
  applyRemoteArtifactEvent,
  applyRemoteArtifactSnapshotEntry,
  applyRemoteDomainEvent,
  applyRemoteDomainSnapshotEntry,
  classifySyncError,
  fetchProjectContextDetail,
  firstRecord,
  isLegacyProjectContextEvent,
  isRemoteResourceTombstone,
  isRemoteTombstone,
  normalizedProjectEventMarker,
  parseRemoteResourceDomain,
  projectContextEventIsStale,
  projectContextSnapshotPage,
  recordHasLegacyProjectContextShape,
  relativePathForRemoteArtifact,
  remoteArtifactFromEvent,
  remoteArtifactFromUnknown,
  remoteResourceIdFromUnknown,
  remoteResourcePayloadFromEvent,
  remoteResourcePayloadFromSnapshot,
  resourcesUnderPath,
  snapshotItems,
  snapshotNextCursor,
  type SyncErrorDetails
} from "./remoteSync.js";
import {
  CoreHttpError,
  claimJobs,
  coreJson,
  downloadJobFile,
  ensureIdentity,
  heartbeat
} from "./coreClient.js";

export { readIdentity } from "./identityStorage.js";
export type { ClientIdentity, SecureIdentityMode } from "./identityStorage.js";
export {
  ensureIdentity,
  registerIfNeeded
} from "./coreClient.js";
export {
  DAEMON_TOKEN_FILE,
  ensureDirs,
  ensureLoopbackApiToken,
  env,
  envBoolean,
  normalizeConfiguredOrigin,
  parseLocalJobConfirmationPolicy,
  parseLoopbackAllowedOrigins,
  readConfig
} from "./config.js";
export type { DaemonConfig, LocalJobConfirmationPolicy } from "./config.js";
export {
  artifactKindForPath,
  defaultNotePath,
  directoryPathFor,
  hashFile,
  isIgnoredSyncPath,
  isIgnoredSyncRelativePath,
  isPathInsideDirectory,
  isReservedWindowsName,
  mimeTypeForPath,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  normalizeRelativePath,
  normalizeSha256Checksum,
  parseContentDispositionFilename,
  pathContainsReservedSegment,
  pathHasUnsafeRootOrTraversal,
  relativeSyncPath,
  resolveSyncRootRelativePath,
  sanitizeFileName,
  sanitizePathSegment,
  sleep,
  titleFor,
  uniquePath,
  waitForStableFile,
  walkSyncDirectories,
  walkSyncFiles
} from "./paths.js";
export {
  applyProjectDefaultPushResult,
  createLocalProject,
  createLocalProjectMemory,
  createLocalProjectRelation,
  deleteLocalProject,
  deleteLocalProjectRelation,
  finishLocalProjectContextWrite,
  invalidLocalProjectContextWrite,
  isLocalProjectId,
  localDefaultProjectSelection,
  localRelationPatch,
  localProjectDefaultSelection,
  normalizeLocalProjectPayload,
  normalizeProjectStatus,
  pendingLocalProjectContextResource,
  projectContextOutboxPath,
  projectDefaultOutboxPath,
  projectDefaultRelationPayload,
  projectOutboxPath,
  retargetOpenProjectOutboxReferences,
  setLocalDefaultProject,
  shouldDeferProjectOutboxItem,
  supersedeOpenProjectDefaultForResource,
  updateLocalProject,
  updateLocalProjectBrief,
  updateLocalProjectDefaultCache,
  updateLocalProjectMemory,
  updateLocalProjectRelation
} from "./localProjects.js";
export {
  createLocalNote,
  deleteLocalNote,
  isLocalNoteId,
  localNoteProjectSummaries,
  normalizeLocalNotePayload,
  normalizeStringArray,
  noteOutboxPath,
  updateLocalNote
} from "./localNotes.js";
// Explicit list, not `export *`: a wildcard would promote helpers that were
// private to index.ts before the split into this module's public API.
export {
  addLocalTaskToToday,
  createLocalTask,
  createLocalTaskAttachment,
  createLocalTaskSubtask,
  deleteLocalTask,
  deleteLocalTaskAttachment,
  deleteLocalTaskSubtask,
  exportLocalTasksCsv,
  importLocalTasksCsv,
  localScheduleCalendar,
  localTaskHistory,
  localTaskSchedule,
  localTodayTasks,
  recordLocalTaskOccurrence,
  removeLocalTaskFromToday,
  removeLocalTaskScheduleItem,
  setLocalTaskPin,
  updateLocalTask,
  updateLocalTaskAttachment,
  updateLocalTaskScheduleItem,
  updateLocalTaskSubtask
} from "./localTasks.js";
export {
  artifactKindForOutboxItem,
  buildLocalArtifactItem,
  buildLocalFolderItem,
  buildOutboxPayloadForFile,
  buildOutboxPayloadForFolder,
  createLocalArtifactFile,
  createLocalArtifactFolder,
  createLocalArtifactNote,
  deleteLocalArtifactItem,
  getLocalArtifactItemById,
  listLocalArtifactItems,
  patchLocalArtifactNoteContent,
  scanSyncFolder,
  updateLocalArtifactItem,
  updateLocalArtifactNoteSection
} from "./localArtifacts.js";
export {
  applyRemoteArtifactDelete,
  applyRemoteArtifactEvent,
  applyRemoteArtifactItem,
  applyRemoteArtifactSnapshotEntry,
  applyRemoteDomainEvent,
  applyRemoteDomainSnapshotEntry,
  applyRemoteProjectDefaultEvent,
  canApplyRemoteArtifact,
  canApplyRemoteArtifactFolderDelete,
  classifySyncError,
  directoryHasUntrackedVisibleEntries,
  fallbackRemoteArtifactLeaf,
  fetchProjectContextDetail,
  fetchRemoteArtifactBlob,
  findResourceById,
  firstRecord,
  hasOpenOutboxForRemoteArtifact,
  hasOpenOutboxUnderRemoteFolder,
  isLegacyProjectContextEvent,
  isLocalArtifactDirty,
  isRemoteResourceTombstone,
  isRemoteTombstone,
  localPathExists,
  normalizedProjectEventMarker,
  parseRemoteArtifactKind,
  parseRemoteResourceDomain,
  pathIsSelfOrChild,
  projectContextEventIsStale,
  projectContextSnapshotPage,
  recordHasLegacyProjectContextShape,
  relativePathForRemoteArtifact,
  remoteArtifactBuffer,
  remoteArtifactFromEvent,
  remoteArtifactFromUnknown,
  remoteResourceRecord,
  remoteResourceIdFromUnknown,
  remoteResourcePayloadFromEvent,
  remoteResourcePayloadFromSnapshot,
  resourcesUnderPath,
  snapshotItems,
  snapshotNextCursor,
  writeRemoteConflict
} from "./remoteSync.js";
// Re-export only what index.ts exposed before the split. A wildcard would
// promote helpers that were private to this file into the module's public API.
export {
  LOOPBACK_AUTH_ERROR_CODE,
  LOOPBACK_AUTH_ERROR_MESSAGE,
  LOOPBACK_CORS_ERROR_CODE,
  LOOPBACK_CORS_ERROR_MESSAGE,
  existingClientOpWriteResult,
  isLocalProjectContextMutation,
  isLoopbackOriginAllowed,
  isSupportedLocalProjectContextWrite,
  loopbackAuthBypassed,
  requestHasValidLoopbackToken
} from "./httpApi.js";

import {
  getMeta,
  getRemoteResource,
  getResource,
  listAllRemoteResourcesForDomain,
  listRemoteResources,
  listConflicts,
  listOpenOutboxForResource,
  listPendingOutbox,
  markOutboxApplied,
  markOutboxFailed,
  markOutboxSuperseded,
  migrateLegacyManifestJson,
  openManifestStore,
  recordConflict,
  recordLocalJob,
  markRemoteResourceDeleted,
  removeRemoteResource,
  removeResource,
  resolveConflict,
  setMeta,
  upsertRemoteResource,
  upsertResource as upsertManifestResource,
  writeManifestDebugSnapshot,
  type ManifestStore,
  type OutboxItem,
  type RemoteResource,
  type RemoteResourceDomain
} from "./manifestStore.js";
import {
  asNumber,
  asRecord,
  asString,
  listLocalRemoteDomainItems,
  localRemoteDomainItem,
  refreshManifestStats,
  remoteResourceUpdatedAt,
  resultRecord,
  runWithClientOpId
} from "./localStore.js";
export {
  asNumber,
  asRecord,
  asString,
  CLIENT_OP_ID_HEADER,
  decodeLocalItemId,
  listLocalRemoteDomainItems,
  localRemoteDomainItem,
  supersedeOpenOutboxForPath,
  runWithClientOpId
} from "./localStore.js";
import {
  cacheProjectContextSnapshot,
  getLocalProjectBrief,
  getLocalProjectContext,
  listLocalProjectMemories,
  listLocalProjectRelations,
  LocalProjectContextError,
  parseProjectContextSnapshot,
  PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY,
  PROJECT_CONTEXT_DOMAIN,
  PROJECT_CONTEXT_SCHEMA_VERSION,
  PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY,
  PROJECT_CONTEXT_SUPPORTED_META_KEY,
  removeStaleProjectContextRows
} from "./projectContextCache.js";
import {
  exportProjectContext,
  PROJECT_CONTEXT_EXPORT_CODES
} from "./projectContextExport.js";
import {
  CAPTURE_UPLOAD_META_KEYS,
  CaptureError,
  CaptureManager,
  CaptureServerPolicyProvider,
  CaptureUploader
} from "./capture/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: resolve(__dirname, "../.env") });

export type { DaemonState, LocalJob } from "./types.js";
import type {
  DaemonState,
  LocalArtifactItem,
  LocalJob,
  PendingLocalJobConfirmation,
  RemoteArtifactItem,
  RemoteSyncEvent,
  SyncPullResponse,
  SyncSnapshotResponse,
  SyncPushResponse
} from "./types.js";

const REMOTE_SYNC_DOMAINS: RemoteResourceDomain[] = ["projects", "notes", "artifacts", "tasks"];
const REMOTE_SYNC_CURSOR_META_KEY = "remoteSyncCursor";
const REMOTE_ARTIFACT_CURSOR_META_KEY = "remoteArtifactCursor";
const REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY = "remoteArtifactSnapshotComplete";
const LAST_REMOTE_PULL_AT_META_KEY = "lastRemotePullAt";
const REMOTE_PULL_LIMIT = 100;
const REMOTE_SNAPSHOT_PAGE_LIMIT = 100;
const REMOTE_CURSOR_DRAIN_LIMIT = 500;

function markProjectContextRescanRequired(state: DaemonState): void {
  setMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY, undefined);
  setMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  if (state.tickRunning) {
    state.tickQueued = true;
  } else {
    scheduleTick(state, 0);
  }
}

async function applyRemoteProjectContextEvent(state: DaemonState, event: RemoteSyncEvent): Promise<void> {
  if (event.domain !== PROJECT_CONTEXT_DOMAIN) return;
  const projectId = event.resourceId;
  if (!projectId || projectContextEventIsStale(state, event)) return;
  const payload = asRecord(event.payload) ?? {};
  if (asString(payload.localClientId) === state.identity?.localClientId) return;
  const createdAt = asString(event.createdAt) ?? new Date().toISOString();

  if (isRemoteResourceTombstone(event)) {
    markRemoteResourceDeleted(state.manifestStore, {
      domain: PROJECT_CONTEXT_DOMAIN,
      resourceId: projectId,
      version: event.version,
      payload,
      deletedAt: createdAt,
      lastSyncedAt: createdAt
    });
    return;
  }

  if (payload.schemaVersion !== PROJECT_CONTEXT_SCHEMA_VERSION) {
    markProjectContextRescanRequired(state);
    return;
  }
  if (payload.kind !== "invalidate") return;
  if (asString(payload.projectId) !== projectId) {
    markProjectContextRescanRequired(state);
    return;
  }
  await fetchProjectContextDetail(state, projectId, event.version);
}

async function applyRemoteSyncEvent(state: DaemonState, event: RemoteSyncEvent): Promise<void> {
  if (event.domain === PROJECT_CONTEXT_DOMAIN) {
    await applyRemoteProjectContextEvent(state, event);
    return;
  }
  if (event.domain === "artifacts") {
    await applyRemoteArtifactEvent(state, event);
    return;
  }
  applyRemoteDomainEvent(state, event);
}

async function getSyncPullPage(state: DaemonState, cursor: string | undefined, limit: number): Promise<SyncPullResponse> {
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

async function getSyncSnapshot(
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

async function applyRemoteSnapshot(
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

async function bootstrapPagedDomainSnapshot(
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

async function bootstrapPagedArtifactSnapshot(
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

async function bootstrapPagedDomainSnapshots(
  state: DaemonState,
  snapshot: SyncSnapshotResponse,
  initialGeneratedAt: string
): Promise<void> {
  await bootstrapPagedArtifactSnapshot(state, snapshot.domains?.artifacts, initialGeneratedAt);
  for (const domain of ["projects", "notes", "tasks"] as const) {
    await bootstrapPagedDomainSnapshot(state, domain, snapshot.domains?.[domain], initialGeneratedAt);
  }
}

function snapshotSupportsProjectContext(snapshot: SyncSnapshotResponse): boolean {
  return Array.isArray(snapshot.supportedDomains)
    && snapshot.supportedDomains.includes(PROJECT_CONTEXT_DOMAIN);
}

function pruneLegacyProjectContextRows(state: DaemonState, activeProjectIds: Set<string>): void {
  for (const resource of listAllRemoteResourcesForDomain(state.manifestStore, "projects", { includeDeleted: true })) {
    if (activeProjectIds.has(resource.resourceId)) continue;
    if (listOpenOutboxForResource(state.manifestStore, resource.resourceId).length > 0) continue;
    if (!recordHasLegacyProjectContextShape(resource.payload)) continue;
    removeRemoteResource(state.manifestStore, "projects", resource.resourceId);
  }
}

async function bootstrapProjectContextSnapshot(
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

async function bootstrapRemoteArtifactSnapshot(state: DaemonState): Promise<string | undefined> {
  if (!state.identity) throw new Error("Missing local client identity");
  let snapshot: SyncSnapshotResponse;
  let fullSnapshotAvailable = true;
  try {
    snapshot = await getSyncSnapshot(state, REMOTE_SYNC_DOMAINS);
  } catch (error) {
    fullSnapshotAvailable = false;
    console.warn(
      `[sync-daemon] all-domain remote snapshot failed; falling back to artifacts-only snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    snapshot = await getSyncSnapshot(state, ["artifacts"]);
  }
  const generatedAt = asString(snapshot.generatedAt) ?? new Date().toISOString();
  await applyRemoteSnapshot(state, snapshot, generatedAt);
  await bootstrapPagedDomainSnapshots(state, snapshot, generatedAt);

  let contextBaselineCursor: string | undefined;
  if (fullSnapshotAvailable && snapshotSupportsProjectContext(snapshot)) {
    const contextBootstrap = await bootstrapProjectContextSnapshot(state, asString(snapshot.baselineCursor));
    contextBaselineCursor = contextBootstrap.supported ? contextBootstrap.baselineCursor : undefined;
  } else if (fullSnapshotAvailable) {
    setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
  }

  const snapshotBaselineCursor = asString(snapshot.baselineCursor);
  let cursor: string | undefined = contextBaselineCursor ?? snapshotBaselineCursor;
  const drainFromBaseline = cursor !== undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await getSyncPullPage(state, cursor, REMOTE_CURSOR_DRAIN_LIMIT);
    const events = page.events ?? [];
    for (const event of events) {
      if (drainFromBaseline) {
        await applyRemoteSyncEvent(state, event);
      } else {
        const eventTime = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
        if (Number.isFinite(eventTime) && eventTime > Date.parse(generatedAt)) {
          await applyRemoteSyncEvent(state, event);
        }
      }
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      return cursor ?? "0";
    }
    cursor = page.nextCursor;
    if (events.length < REMOTE_CURSOR_DRAIN_LIMIT) {
      return cursor;
    }
  }
  return cursor ?? "0";
}

export async function pullRemoteArtifactSyncState(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  let cursor = getMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY)
    ?? getMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY)
    ?? state.remoteArtifactCursor;
  const snapshotComplete = getMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY) === "1";
  const contextSupported = getMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY);
  const contextSnapshotComplete = getMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY) === "1";
  const contextBootstrapRequired = contextSupported === undefined
    || (contextSupported === "1" && !contextSnapshotComplete);
  if (!cursor || !snapshotComplete || contextBootstrapRequired) {
    cursor = await bootstrapRemoteArtifactSnapshot(state);
    setMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY, "1");
  } else {
    const page = await getSyncPullPage(state, cursor, REMOTE_PULL_LIMIT);
    for (const event of page.events ?? []) {
      await applyRemoteSyncEvent(state, event);
    }
    cursor = page.nextCursor ?? cursor;
  }

  const now = new Date().toISOString();
  setMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY, cursor ?? "0");
  setMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY, cursor ?? "0");
  setMeta(state.manifestStore, LAST_REMOTE_PULL_AT_META_KEY, now);
  state.remoteArtifactCursor = cursor ?? "0";
  state.lastRemotePullAt = now;
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}

async function requestRemoteSnapshotRescan(state: DaemonState): Promise<void> {
  setMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY, undefined);
  setMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY, undefined);
  setMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY, undefined);
  state.remoteArtifactCursor = undefined;
  scheduleTick(state, 0);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}

function setSyncErrorState(state: DaemonState, details: SyncErrorDetails): void {
  state.lastError = details.errorMessage;
  state.lastErrorCode = details.errorCode;
  state.lastErrorCategory = details.errorCategory;
  state.lastErrorRetryable = details.retryable;
}

function clearSyncErrorState(state: DaemonState): void {
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

async function postSyncPush(state: DaemonState, ops: OutboxItem[]): Promise<SyncPushResponse> {
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

function extractResourceId(value: unknown): string | undefined {
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

async function writeConflictRecord(
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

async function pushOutbox(state: DaemonState): Promise<void> {
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

async function completeJob(state: DaemonState, job: LocalJob, result: Record<string, unknown>): Promise<void> {
  if (!state.identity) return;
  await coreJson(state.config, `/api/local-jobs/${encodeURIComponent(job.id)}/complete`, {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result })
  });
}

async function failJob(state: DaemonState, job: LocalJob, error: unknown): Promise<void> {
  if (!state.identity) return;
  const message = error instanceof Error ? error.message : String(error);
  await coreJson(state.config, `/api/local-jobs/${encodeURIComponent(job.id)}/fail`, {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message })
  });
}

function pendingJobConfirmations(state: DaemonState): Map<string, PendingLocalJobConfirmation> {
  if (!state.pendingJobConfirmations) {
    state.pendingJobConfirmations = new Map();
  }
  return state.pendingJobConfirmations;
}

export function localJobRequiresConfirmation(config: DaemonConfig, job: LocalJob): boolean {
  const policy = config.localJobConfirmationPolicy ?? "off";
  if (policy === "off") return false;
  if (policy === "all") return true;
  return job.target === "downloads";
}

function localJobConfirmationReason(job: LocalJob): string {
  if (job.target === "downloads") {
    return "This job saves a file to the configured downloads folder.";
  }
  return "This job saves a file on this device.";
}

function destinationRootForLocalJob(config: DaemonConfig, job: LocalJob): string {
  return job.target === "sync-folder" ? config.syncRoot : config.downloadsDir;
}

function pendingLocalJobConfirmationPayload(
  state: DaemonState,
  pending: PendingLocalJobConfirmation
): Record<string, unknown> {
  const requestedFilename = typeof pending.job.payload.filename === "string"
    ? sanitizeFileName(pending.job.payload.filename)
    : undefined;
  return {
    jobId: pending.job.id,
    kind: pending.job.kind,
    target: pending.job.target,
    status: "pending_confirmation",
    requestedAt: pending.requestedAt,
    reason: pending.reason,
    destinationRoot: destinationRootForLocalJob(state.config, pending.job),
    requestedFilename,
    payload: {
      artifactItemId: typeof pending.job.payload.artifactItemId === "string" ? pending.job.payload.artifactItemId : undefined,
      taskId: typeof pending.job.payload.taskId === "string" ? pending.job.payload.taskId : undefined,
      attachmentId: typeof pending.job.payload.attachmentId === "string" ? pending.job.payload.attachmentId : undefined,
      domain: typeof pending.job.payload.domain === "string" ? pending.job.payload.domain : undefined,
      filename: typeof pending.job.payload.filename === "string" ? pending.job.payload.filename : undefined
    }
  };
}

export function listPendingLocalJobConfirmations(state: DaemonState): Record<string, unknown>[] {
  return [...pendingJobConfirmations(state).values()]
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
    .map((pending) => pendingLocalJobConfirmationPayload(state, pending));
}

function queueLocalJobConfirmation(state: DaemonState, job: LocalJob): void {
  const pending = pendingJobConfirmations(state);
  if (pending.has(job.id)) {
    return;
  }
  pending.set(job.id, {
    job,
    requestedAt: new Date().toISOString(),
    reason: localJobConfirmationReason(job)
  });
}

async function recordManifestJob(state: DaemonState, job: LocalJob, result: Record<string, unknown>): Promise<void> {
  const completedAt = new Date().toISOString();
  recordLocalJob(state.manifestStore, {
    jobId: job.id,
    kind: job.kind,
    target: job.target,
    result,
    completedAt
  });

  const localPath = typeof result.localPath === "string" ? result.localPath : undefined;
  const relativePath = localPath && job.target === "sync-folder" ? relativeSyncPath(state.config, localPath) : undefined;
  if (relativePath) {
    upsertManifestResource(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      kind: artifactKindForPath(relativePath),
      resourceId: typeof job.payload.artifactItemId === "string"
        ? job.payload.artifactItemId
        : typeof job.payload.id === "string"
          ? job.payload.id
          : undefined,
      checksum: typeof result.checksum === "string" ? result.checksum : undefined,
      sizeBytes: typeof result.sizeBytes === "number" ? result.sizeBytes : undefined,
      dirty: false,
      lastSeenAt: completedAt,
      lastSyncedAt: completedAt
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
}

export async function processJob(
  state: DaemonState,
  job: LocalJob,
  options: { skipConfirmation?: boolean } = {}
): Promise<Record<string, unknown> | undefined> {
  if (!options.skipConfirmation && localJobRequiresConfirmation(state.config, job)) {
    queueLocalJobConfirmation(state, job);
    return undefined;
  }

  try {
    if (job.kind !== "download_artifact" && job.kind !== "download_task_attachment" && job.kind !== "materialize_resource") {
      throw new Error(`Unsupported local job kind: ${job.kind}`);
    }
    const result = await downloadJobFile(state, job);
    await recordManifestJob(state, job, result);
    await completeJob(state, job, result);
    state.processedJobs += 1;
    return result;
  } catch (error) {
    await failJob(state, job, error);
    throw error;
  }
}

export async function approvePendingLocalJobConfirmation(
  state: DaemonState,
  jobId: string
): Promise<Record<string, unknown> | undefined> {
  const pending = pendingJobConfirmations(state).get(jobId);
  if (!pending) {
    return undefined;
  }
  pendingJobConfirmations(state).delete(jobId);
  return processJob(state, pending.job, { skipConfirmation: true });
}

export async function rejectPendingLocalJobConfirmation(
  state: DaemonState,
  jobId: string,
  reason?: string
): Promise<boolean> {
  const pending = pendingJobConfirmations(state).get(jobId);
  if (!pending) {
    return false;
  }
  pendingJobConfirmations(state).delete(jobId);
  await failJob(state, pending.job, new Error(reason?.trim() || "Local job rejected by user confirmation policy."));
  return true;
}

async function performTick(state: DaemonState): Promise<void> {
  let recoverablePullError = false;
  try {
    await ensureIdentity(state);
    const jobs = await claimJobs(state);
    for (const job of jobs) {
      await processJob(state, job);
    }
    try {
      await pullRemoteArtifactSyncState(state);
    } catch (error) {
      const details = classifySyncError(error);
      if (details.errorCategory !== "network" || !details.retryable) {
        throw error;
      }
      recoverablePullError = true;
      setSyncErrorState(state, details);
      logSyncDaemonErrorOnce(state, details.errorMessage);
    }
    await scanSyncFolder(state);
    state.capture?.runDailyRetention();
    // Refresh the server collection policy and reconcile local acquisition so a
    // UI toggle (foreground/screenshot/window-title off) actually stops capture.
    if (state.capture && state.capturePolicy && state.identity) {
      await state.capturePolicy.refresh();
      await state.capture.reconcile();
    }
    const captureConfig = state.capture?.config();
    if (captureConfig?.enabled && captureConfig.uploadEnabled && state.captureUploader) {
      if (state.identity) {
        state.captureUploadIdentityWarned = false;
        await state.captureUploader.run();
      } else if (!state.captureUploadIdentityWarned) {
        state.captureUploadIdentityWarned = true;
        console.warn("[capture] analyser upload skipped because local client identity is not registered");
      }
    }
    if (state.identity && state.capture && state.captureUploader) {
      const events = state.capture.drainFileEvents();
      if (events.length > 0) {
        try {
          await state.captureUploader.uploadFileEvents(events);
          state.captureFileUploadWarned = false;
        } catch (error) {
          state.capture.requeueFileEvents(events);
          if (!state.captureFileUploadWarned) {
            state.captureFileUploadWarned = true;
            console.warn("[capture] analyser local file upload failed", {
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    }
    await pushOutbox(state);
    await heartbeat(state);
    if (!recoverablePullError) {
      clearSyncErrorState(state);
    }
  } catch (error) {
    const details = classifySyncError(error);
    setSyncErrorState(state, details);
    logSyncDaemonErrorOnce(state, details.errorMessage);
  }
}

async function tick(state: DaemonState): Promise<void> {
  if (state.tickRunning) {
    state.tickQueued = true;
    return;
  }
  state.tickRunning = true;
  try {
    do {
      state.tickQueued = false;
      await performTick(state);
    } while (state.tickQueued);
  } finally {
    state.tickRunning = false;
  }
}

function scheduleTick(state: DaemonState, delayMs = state.config.watchDebounceMs): void {
  if (state.tickTimer) {
    clearTimeout(state.tickTimer);
  }
  state.tickTimer = setTimeout(() => {
    state.tickTimer = undefined;
    void tick(state);
  }, delayMs);
}

function startSyncWatcher(state: DaemonState): void {
  if (!state.config.watchEnabled) return;
  try {
    const watcher = watch(state.config.syncRoot, { recursive: true }, (_eventType, filename) => {
      const relativePath = filename ? normalizeRelativePath(String(filename)) : undefined;
      if (relativePath && isIgnoredSyncRelativePath(relativePath)) return;
      scheduleTick(state);
    });
    watcher.on("error", (error) => {
      state.watcherActive = false;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sync-daemon] sync folder watcher disabled: ${message}`);
    });
    state.watcher = watcher;
    state.watcherActive = true;
    console.log(`[sync-daemon] watching sync folder ${state.config.syncRoot}`);
  } catch (error) {
    state.watcherActive = false;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sync-daemon] sync folder watcher unavailable; interval scan remains active: ${message}`);
  }
}






async function createLocalArtifactUploadFromRequest(
  state: DaemonState,
  req: IncomingMessage
): Promise<LocalArtifactItem> {
  const contentType = req.headers["content-type"]?.toString().toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const formData = await readRequestFormData(req);
    const fileValue = formData.get("file");
    if (!fileValue || typeof fileValue === "string") {
      throw new Error("File is required");
    }
    const file = fileValue as unknown as {
      arrayBuffer?: () => Promise<ArrayBuffer>;
      name?: string;
      type?: string;
    };
    if (typeof file.arrayBuffer !== "function") {
      throw new Error("File is required");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    return createLocalArtifactFile(state, {
      directoryPath: getFormDataString(formData, "directoryPath"),
      originalFilename: file.name || "file",
      mimeType: file.type || getFormDataString(formData, "mimeType"),
      contentBase64: buffer.toString("base64")
    });
  }

  const body = await readRequestJson(req);
  return createLocalArtifactFile(state, body);
}













function daemonStatusPayload(state: DaemonState): Record<string, unknown> {
  return {
    status: "ok",
    mode: "local-daemon",
    coreUrl: state.config.coreUrl,
    syncRoot: state.config.syncRoot,
    manifestDbPath: state.manifestStore.path,
    downloadsDir: state.config.downloadsDir,
    watchEnabled: state.config.watchEnabled,
    watcherActive: state.watcherActive,
    watchDebounceMs: state.config.watchDebounceMs,
    syncActive: state.tickRunning || state.tickQueued,
    tickRunning: state.tickRunning,
    tickQueued: state.tickQueued,
    localJobConfirmationPolicy: state.config.localJobConfirmationPolicy ?? "off",
    localJobConfirmationsPending: pendingJobConfirmations(state).size,
    capture: state.capture?.status() ?? {
      enabled: false,
      collectorAlive: false,
      sampleCount24h: 0
    },
    localClientId: state.identity?.localClientId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastClaimAt: state.lastClaimAt,
    lastScanAt: state.lastScanAt,
    lastPushAt: state.lastPushAt,
    lastRemotePullAt: state.lastRemotePullAt,
    remoteSyncCursor: getMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY) ?? state.remoteArtifactCursor,
    remoteArtifactCursor: state.remoteArtifactCursor,
    remoteArtifactSnapshotComplete: getMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY) === "1",
    projectContextSupported: getMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY) === "1",
    projectContextSnapshotComplete: getMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY) === "1",
    projectContextBaselineCursor: getMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY),
    lastError: state.lastError,
    lastErrorCode: state.lastErrorCode,
    lastErrorCategory: state.lastErrorCategory,
    lastErrorRetryable: state.lastErrorRetryable,
    processedJobs: state.processedJobs,
    outboxPending: state.outboxPending,
    outboxFailed: state.outboxFailed,
    conflictsOpen: state.conflictsOpen
  };
}











export async function handleLocalProjectContextWrite(
  state: DaemonState,
  pathname: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ statusCode: number; body?: Record<string, unknown> }> {
  let match = pathname.match(/^\/api\/projects\/([^/]+)\/brief$/);
  if (match && method === "PUT") {
    const result = await updateLocalProjectBrief(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 200, body: result };
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/memories$/);
  if (match && method === "POST") {
    const result = await createLocalProjectMemory(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 201, body: result };
  }
  match = pathname.match(/^\/api\/project-memories\/([^/]+)$/);
  if (match && method === "PATCH") {
    const result = await updateLocalProjectMemory(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 200, body: result };
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/relations$/);
  if (match && method === "POST") {
    const result = await createLocalProjectRelation(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 201, body: result };
  }
  match = pathname.match(/^\/api\/project-relations\/([^/]+)$/);
  if (match && method === "PATCH") {
    const result = await updateLocalProjectRelation(state, decodeURIComponent(match[1]), body);
    scheduleTick(state, 0);
    return { statusCode: 200, body: result };
  }
  if (match && method === "DELETE") {
    await deleteLocalProjectRelation(state, decodeURIComponent(match[1]));
    scheduleTick(state, 0);
    return { statusCode: 204 };
  }
  throw new LocalProjectContextError(404, "LOCAL_PROJECT_CONTEXT_ROUTE_NOT_FOUND", "Local Project context route not found.");
}


function startStatusServer(state: DaemonState): void {
  if (state.config.httpPort === 0) return;
  const server = createServer((req, res) => runWithClientOpId(requestClientOpId(req), async () => {
    if (!setLoopbackCorsHeaders(state.config, req, res)) {
      writeJson(res, {
        code: LOOPBACK_CORS_ERROR_CODE,
        message: LOOPBACK_CORS_ERROR_MESSAGE
      }, 403);
      return;
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!requireLoopbackAuth(state, req, res, url.pathname)) {
      return;
    }
    const clientOpId = requestClientOpId(req);
    if (clientOpId && req.method && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const existingWrite = existingClientOpWriteResult(state, clientOpId);
      if (existingWrite) {
        writeJson(res, existingWrite.result);
        return;
      }
    }
    if (url.pathname === "/health") {
      writeJson(res, { status: "ok" });
      return;
    }

    if (url.pathname === "/status" || url.pathname === "/api/sync/status") {
      writeJson(res, daemonStatusPayload(state));
      return;
    }

    if (url.pathname === "/capture/status" && req.method === "GET") {
      writeJson(res, state.capture?.apiStatus(state.captureUploader?.serverUploadAllowed ?? null) ?? {
        config: { enabled: false, uploadEnabled: false, windowTitleCapture: false, windowTitleUpload: false, screenshotsEnabled: false, screenshotIntervalSeconds: 300, screenshotRetentionDays: 7, intervalSeconds: 15, retentionDays: 14, excludePatterns: [] },
        status: { enabled: false, uploadEnabled: false, serverUploadAllowed: null, windowTitleCapture: false, windowTitleUpload: false, collectorAlive: false, sampleCount24h: 0 }
      });
      return;
    }

    if (url.pathname === "/capture/config" && req.method === "GET") {
      writeJson(res, state.capture?.config() ?? {
        enabled: false,
        uploadEnabled: false,
        windowTitleCapture: false,
        windowTitleUpload: false,
        screenshotsEnabled: false,
        screenshotIntervalSeconds: 300,
        screenshotRetentionDays: 7,
        intervalSeconds: 15,
        retentionDays: 14,
        excludePatterns: []
      });
      return;
    }

    if (url.pathname === "/capture/config" && req.method === "PUT") {
      try {
        const body = await readRequestJson(req);
        writeJson(res, await state.capture?.updateConfig(body));
      } catch (error) {
        writeCaptureError(res, error);
      }
      return;
    }

    if (url.pathname === "/capture/enable" && req.method === "POST") {
      try {
        writeJson(res, await state.capture?.enable());
      } catch (error) {
        writeCaptureError(res, error);
      }
      return;
    }

    if (url.pathname === "/capture/disable" && req.method === "POST") {
      try {
        writeJson(res, await state.capture?.disable());
      } catch (error) {
        writeCaptureError(res, error);
      }
      return;
    }

    // AW-10 removed the legacy summary endpoints. Keep these non-executable
    // route-coverage tombstones until that broader test is updated in its wave:
    // url.pathname === "/capture/summarize" && req.method === "POST"
    // url.pathname === "/capture/summaries" && req.method === "GET"
    // url.pathname.startsWith("/capture/summaries/")

    if (url.pathname === "/capture/screenshots" && req.method === "GET") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : undefined;
        writeJson(res, state.capture?.listScreenshots({
          date: url.searchParams.get("date") ?? undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
          cursor: url.searchParams.get("cursor") ?? undefined
        }) ?? { items: [] });
      } catch (error) { writeCaptureError(res, error); }
      return;
    }

    const screenshotFileMatch = url.pathname.match(/^\/capture\/screenshots\/(\d+)\/file$/);
    if (screenshotFileMatch && req.method === "GET") {
      try {
        if (!state.capture) throw new CaptureError("Capture is unavailable.", 404, "CAPTURE_UNAVAILABLE");
        const data = await fs.readFile(state.capture.screenshotFilePath(Number(screenshotFileMatch[1])));
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", data.length);
        res.end(data);
      } catch (error) { writeCaptureError(res, error); }
      return;
    }

    if (url.pathname === "/api/sync/rescan" && req.method === "POST") {
      try {
        await requestRemoteSnapshotRescan(state);
        writeJson(res, {
          scheduled: true,
          status: daemonStatusPayload(state)
        });
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/local-jobs/pending-confirmations" && req.method === "GET") {
      writeJson(res, {
        policy: state.config.localJobConfirmationPolicy ?? "off",
        items: listPendingLocalJobConfirmations(state)
      });
      return;
    }

    const localJobApproveMatch = url.pathname.match(/^\/api\/local-jobs\/([^/]+)\/approve$/);
    if (localJobApproveMatch && req.method === "POST") {
      try {
        const result = await approvePendingLocalJobConfirmation(state, decodeURIComponent(localJobApproveMatch[1]));
        if (!result) {
          writeJson(res, { message: "Pending local job confirmation not found" }, 404);
          return;
        }
        writeJson(res, { status: "completed", result });
        return;
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
    }

    const localJobRejectMatch = url.pathname.match(/^\/api\/local-jobs\/([^/]+)\/reject$/);
    if (localJobRejectMatch && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const rejected = await rejectPendingLocalJobConfirmation(
          state,
          decodeURIComponent(localJobRejectMatch[1]),
          typeof body.reason === "string" ? body.reason : undefined
        );
        if (!rejected) {
          writeJson(res, { message: "Pending local job confirmation not found" }, 404);
          return;
        }
        writeJson(res, { status: "rejected" });
        return;
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
    }

    if (url.pathname === "/api/sync/snapshot" && req.method === "GET") {
      const requestedDomains = typeof url.searchParams.get("domains") === "string"
        ? (url.searchParams.get("domains") ?? "").split(",").map((value) => value.trim()).filter(Boolean)
        : REMOTE_SYNC_DOMAINS;
      const domainSet = new Set(requestedDomains);
      const domains: Record<string, unknown> = {};
      const includeDeleted = parseBooleanQuery(url.searchParams.get("includeDeleted"));
      const limitRaw = Number(url.searchParams.get("limit") ?? "");
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      if (domainSet.has("projects")) {
        domains.projects = { items: listLocalRemoteDomainItems(state, "projects", { includeDeleted, limit }) };
      }
      if (domainSet.has("notes")) {
        domains.notes = listLocalRemoteDomainItems(state, "notes", { includeDeleted, limit });
      }
      if (domainSet.has("artifacts")) {
        domains.artifacts = await listLocalArtifactItems(state, {
          includeContent: parseBooleanQuery(url.searchParams.get("includeContent"))
        });
      }
      if (domainSet.has("tasks")) {
        domains.tasks = listLocalRemoteDomainItems(state, "tasks", { includeDeleted, limit });
      }
      if (domainSet.has(PROJECT_CONTEXT_DOMAIN)) {
        domains[PROJECT_CONTEXT_DOMAIN] = {
          items: listAllRemoteResourcesForDomain(state.manifestStore, PROJECT_CONTEXT_DOMAIN, { includeDeleted })
            .map((resource) => resource.payload)
        };
      }
      writeJson(res, {
        generatedAt: new Date().toISOString(),
        source: "local-daemon",
        supportedDomains: getMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY) === "1"
          ? [...REMOTE_SYNC_DOMAINS, PROJECT_CONTEXT_DOMAIN]
          : [...REMOTE_SYNC_DOMAINS],
        domains
      });
      return;
    }

    if (isSupportedLocalProjectContextWrite(url.pathname, req.method)) {
      try {
        const body = req.method === "DELETE" ? {} : await readRequestJson(req);
        const result = await handleLocalProjectContextWrite(state, url.pathname, req.method!, body);
        if (result.statusCode === 204) {
          res.statusCode = 204;
          res.end();
        } else {
          writeJson(res, result.body, result.statusCode);
        }
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    if (isLocalProjectContextMutation(url.pathname, req.method)) {
      writeJson(res, {
        code: "LOCAL_PROJECT_CONTEXT_READ_ONLY",
        message: "Project context mutations are unavailable in Local Mode."
      }, 503);
      return;
    }

    if (url.pathname === "/api/project-context/exports" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const projectId = requestString(body.projectId) ?? requestString(url.searchParams.get("projectId"));
        if (!projectId) {
          writeJson(res, {
            code: PROJECT_CONTEXT_EXPORT_CODES.pathUnsafe,
            message: "projectId is required."
          }, 400);
          return;
        }
        const result = await exportProjectContext(
          { coreUrl: state.config.coreUrl, syncRoot: state.config.syncRoot },
          state.identity,
          projectId,
          { exportId: requestString(body.exportId) }
        );
        writeJson(res, result, 201);
      } catch (error) {
        writeProjectContextExportError(res, error);
      }
      return;
    }

    const projectContextMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/context$/);
    if (projectContextMatch && req.method === "GET") {
      try {
        const include = url.searchParams.get("include")
          ?.split(",")
          .map((section) => section.trim())
          .filter(Boolean);
        writeJson(res, getLocalProjectContext(
          state.manifestStore,
          decodeURIComponent(projectContextMatch[1]),
          {
            q: url.searchParams.get("q") ?? undefined,
            include,
            memoryLimit: optionalNumberQuery(url, "memoryLimit"),
            relationLimit: optionalNumberQuery(url, "relationLimit"),
            maxChars: optionalNumberQuery(url, "maxChars")
          }
        ));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const projectBriefMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/brief$/);
    if (projectBriefMatch && req.method === "GET") {
      try {
        writeJson(res, getLocalProjectBrief(state.manifestStore, decodeURIComponent(projectBriefMatch[1])));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const projectMemoriesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/memories$/);
    if (projectMemoriesMatch && req.method === "GET") {
      try {
        writeJson(res, listLocalProjectMemories(
          state.manifestStore,
          decodeURIComponent(projectMemoriesMatch[1]),
          {
            q: url.searchParams.get("q") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            authority: url.searchParams.get("authority") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            limit: optionalNumberQuery(url, "limit"),
            cursor: url.searchParams.get("cursor") ?? undefined
          }
        ));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const projectRelationsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/relations$/);
    if (projectRelationsMatch && req.method === "GET") {
      try {
        writeJson(res, listLocalProjectRelations(
          state.manifestStore,
          decodeURIComponent(projectRelationsMatch[1]),
          {
            limit: optionalNumberQuery(url, "limit"),
            cursor: url.searchParams.get("cursor") ?? undefined
          }
        ));
      } catch (error) {
        writeLocalProjectContextError(res, error);
      }
      return;
    }

    const remoteDomainListMatch = url.pathname.match(/^\/api\/(projects|notes|tasks)$/);
    if (remoteDomainListMatch && req.method === "GET") {
      const domain = remoteDomainListMatch[1] as Exclude<RemoteResourceDomain, "artifacts">;
      const includeDeleted = parseBooleanQuery(url.searchParams.get("includeDeleted"));
      const limitParam = url.searchParams.get("limit");
      const limitRaw = limitParam ? Number(limitParam) : undefined;
      const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
      let items = listLocalRemoteDomainItems(state, domain, { includeDeleted, limit });
      if (domain === "projects") {
        const status = url.searchParams.get("status");
        const query = url.searchParams.get("q")?.trim().toLowerCase();
        if (status) {
          items = items.filter((item) => item.status === status);
        }
        if (query) {
          items = items.filter((item) => {
            const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
            const description = typeof item.description === "string" ? item.description.toLowerCase() : "";
            return name.includes(query) || description.includes(query);
          });
        }
        writeJson(res, { items });
        return;
      }
      if (domain === "notes") {
        const projectId = url.searchParams.get("projectId");
        if (projectId) {
          items = items.filter((item) => item.projectId === projectId);
        }
      }
      if (domain === "tasks") {
        const status = url.searchParams.get("status");
        const context = url.searchParams.get("context");
        if (status) {
          items = items.filter((item) => item.status === status);
        }
        if (context) {
          items = items.filter((item) => item.context === context || item.projectId === context);
        }
      }
      writeJson(res, items);
      return;
    }

    if (url.pathname === "/api/notes/projects" && req.method === "GET") {
      writeJson(res, localNoteProjectSummaries(state));
      return;
    }

    if (url.pathname === "/api/tasks/projects" && req.method === "GET") {
      writeJson(res, localTaskProjectSummaries(state));
      return;
    }

    if (url.pathname === "/api/tasks/pins" && req.method === "GET") {
      writeJson(res, { taskIds: localTaskPinnedIds(state) });
      return;
    }

    if (url.pathname === "/api/tasks/export" && req.method === "GET") {
      const csv = exportLocalTasksCsv(state);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="tasks.csv"');
      res.end(csv);
      return;
    }

    if (url.pathname === "/api/tasks/import" && req.method === "POST") {
      try {
        const csv = await readRequestText(req);
        const imported = await importLocalTasksCsv(state, csv);
        scheduleTick(state, 0);
        writeJson(res, { imported });
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/tasks/today" && req.method === "GET") {
      const date = asString(url.searchParams.get("date"));
      if (!date) {
        writeJson(res, { message: "date query parameter is required" }, 400);
        return;
      }
      writeJson(res, localTodayTasks(state, date));
      return;
    }

    if (url.pathname === "/api/tasks/today" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const taskId = asString(body.taskId);
        if (!taskId) {
          writeJson(res, { message: "taskId is required" }, 400);
          return;
        }
        const item = await addLocalTaskToToday(state, taskId, body);
        if (!item) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskTodayDeleteMatch = url.pathname.match(/^\/api\/tasks\/today\/([^/]+)$/);
    if (taskTodayDeleteMatch && req.method === "DELETE") {
      try {
        const taskId = decodeURIComponent(taskTodayDeleteMatch[1]);
        const scheduledDate = asString(url.searchParams.get("scheduledDate"));
        if (!scheduledDate) {
          writeJson(res, { message: "scheduledDate query parameter is required" }, 400);
          return;
        }
        const occurrenceDate = asString(url.searchParams.get("occurrenceDate"));
        const scheduleId = scheduleItemId(url.searchParams.get("scheduleId")) ?? scheduleItemId(url.searchParams.get("id"));
        const result = await removeLocalTaskFromToday(state, taskId, scheduledDate, occurrenceDate, scheduleId);
        if (!result) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, result);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/tasks/schedule-calendar" && req.method === "GET") {
      const startDate = asString(url.searchParams.get("startDate"));
      const endDate = asString(url.searchParams.get("endDate"));
      if (!startDate || !endDate) {
        writeJson(res, { message: "startDate and endDate query parameters are required" }, 400);
        return;
      }
      writeJson(res, localScheduleCalendar(state, startDate, endDate));
      return;
    }

    if (url.pathname === "/api/tasks/schedule" && req.method === "GET") {
      const startDate = asString(url.searchParams.get("startDate"));
      const endDate = asString(url.searchParams.get("endDate"));
      if (!startDate || !endDate) {
        writeJson(res, { message: "startDate and endDate query parameters are required" }, 400);
        return;
      }
      writeJson(res, localTaskSchedule(
        state,
        startDate,
        endDate,
        url.searchParams.get("context") ?? undefined,
        url.searchParams.get("status") ?? undefined
      ));
      return;
    }

    const taskHistoryMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/history$/);
    if (taskHistoryMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskHistoryMatch[1]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, localTaskHistory(state, taskId));
      return;
    }

    const taskScheduleItemsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/schedule-items$/);
    if (taskScheduleItemsMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskScheduleItemsMatch[1]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, taskScheduleItems(task));
      return;
    }

    const taskScheduleItemMatch = url.pathname.match(/^\/api\/tasks\/schedule-items\/(-?\d+)$/);
    if (taskScheduleItemMatch && req.method === "PUT") {
      try {
        const scheduleId = Number(taskScheduleItemMatch[1]);
        const body = await readRequestJson(req);
        const item = await updateLocalTaskScheduleItem(state, scheduleId, body);
        if (!item) {
          writeJson(res, { message: "Local schedule item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (taskScheduleItemMatch && req.method === "DELETE") {
      try {
        const scheduleId = Number(taskScheduleItemMatch[1]);
        const deleted = await removeLocalTaskScheduleItem(state, scheduleId);
        if (!deleted) {
          writeJson(res, { message: "Local schedule item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskOccurrenceMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/occurrences\/(complete|move|skip-exception)$/);
    if (taskOccurrenceMatch && req.method === "POST") {
      try {
        const taskId = decodeURIComponent(taskOccurrenceMatch[1]);
        const routeOperation = taskOccurrenceMatch[2] === "skip-exception" ? "skipException" : taskOccurrenceMatch[2];
        const body = await readRequestJson(req);
        const result = await recordLocalTaskOccurrence(state, taskId, {
          ...body,
          operation: routeOperation
        });
        if (!result) {
          writeJson(res, { message: "Local task or occurrence payload not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, result);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskSubtasksListMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/occurrences\/([^/]+)\/subtasks$/);
    if (taskSubtasksListMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskSubtasksListMatch[1]);
      const occurrenceDate = decodeURIComponent(taskSubtasksListMatch[2]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, taskSubtasks(task).filter((item) => item.occurrenceDate === occurrenceDate));
      return;
    }

    if (taskSubtasksListMatch && req.method === "POST") {
      try {
        const taskId = decodeURIComponent(taskSubtasksListMatch[1]);
        const occurrenceDate = decodeURIComponent(taskSubtasksListMatch[2]);
        const body = await readRequestJson(req);
        const subtask = await createLocalTaskSubtask(state, taskId, occurrenceDate, body);
        if (!subtask) {
          writeJson(res, { message: "Local task or subtask payload not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, subtask, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskSubtaskItemMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/occurrences\/([^/]+)\/subtasks\/([^/]+)$/);
    if (taskSubtaskItemMatch && req.method === "PATCH") {
      try {
        const taskId = decodeURIComponent(taskSubtaskItemMatch[1]);
        const occurrenceDate = decodeURIComponent(taskSubtaskItemMatch[2]);
        const subtaskId = decodeURIComponent(taskSubtaskItemMatch[3]);
        const body = await readRequestJson(req);
        const subtask = await updateLocalTaskSubtask(state, taskId, occurrenceDate, subtaskId, body);
        if (!subtask) {
          writeJson(res, { message: "Local subtask not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, subtask);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (taskSubtaskItemMatch && req.method === "DELETE") {
      try {
        const taskId = decodeURIComponent(taskSubtaskItemMatch[1]);
        const occurrenceDate = decodeURIComponent(taskSubtaskItemMatch[2]);
        const subtaskId = decodeURIComponent(taskSubtaskItemMatch[3]);
        const deleted = await deleteLocalTaskSubtask(state, taskId, occurrenceDate, subtaskId);
        if (!deleted) {
          writeJson(res, { message: "Local subtask not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskAttachmentsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
    if (taskAttachmentsMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskAttachmentsMatch[1]);
      const task = localTaskPayloadForUpdate(state, taskId);
      if (!task || task.deleted === true) {
        writeJson(res, { message: "Local task not found" }, 404);
        return;
      }
      writeJson(res, taskAttachments(task).map((item) => {
        const { contentBase64: _contentBase64, ...metadata } = item;
        return metadata;
      }));
      return;
    }

    if (taskAttachmentsMatch && req.method === "POST") {
      try {
        const taskId = decodeURIComponent(taskAttachmentsMatch[1]);
        const body = await readRequestJson(req);
        const attachment = await createLocalTaskAttachment(state, taskId, body);
        if (!attachment) {
          writeJson(res, { message: "Local task or attachment payload not found" }, 404);
          return;
        }
        const { contentBase64: _contentBase64, ...metadata } = attachment;
        scheduleTick(state, 0);
        writeJson(res, metadata, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const taskAttachmentDownloadMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)\/download$/);
    if (taskAttachmentDownloadMatch && req.method === "GET") {
      const taskId = decodeURIComponent(taskAttachmentDownloadMatch[1]);
      const attachmentId = decodeURIComponent(taskAttachmentDownloadMatch[2]);
      const task = localTaskPayloadForUpdate(state, taskId);
      const attachment = taskAttachments(task).find((item) => asString(item.id) === attachmentId);
      const contentBase64 = asString(attachment?.contentBase64);
      if (!attachment || !contentBase64) {
        writeJson(res, { message: "Local attachment not found" }, 404);
        return;
      }
      const buffer = Buffer.from(contentBase64, "base64");
      const filename = (asString(attachment.filename) ?? attachmentId).replace(/["\r\n]/g, "_");
      res.statusCode = 200;
      res.setHeader("Content-Type", asString(attachment.mimeType) ?? "application/octet-stream");
      res.setHeader("Content-Length", String(buffer.byteLength));
      res.setHeader(
        "Content-Disposition",
        `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      res.end(buffer);
      return;
    }

    const taskAttachmentItemMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
    if (taskAttachmentItemMatch && req.method === "PUT") {
      try {
        const taskId = decodeURIComponent(taskAttachmentItemMatch[1]);
        const attachmentId = decodeURIComponent(taskAttachmentItemMatch[2]);
        const body = await readRequestJson(req);
        const attachment = await updateLocalTaskAttachment(state, taskId, attachmentId, body);
        if (!attachment) {
          writeJson(res, { message: "Local attachment not found" }, 404);
          return;
        }
        const { contentBase64: _contentBase64, ...metadata } = attachment;
        scheduleTick(state, 0);
        writeJson(res, metadata);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (taskAttachmentItemMatch && req.method === "DELETE") {
      try {
        const taskId = decodeURIComponent(taskAttachmentItemMatch[1]);
        const attachmentId = decodeURIComponent(taskAttachmentItemMatch[2]);
        const deleted = await deleteLocalTaskAttachment(state, taskId, attachmentId);
        if (!deleted) {
          writeJson(res, { message: "Local attachment not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const project = await createLocalProject(state, body);
        scheduleTick(state, 0);
        writeJson(res, project, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/notes" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const note = await createLocalNote(state, body);
        scheduleTick(state, 0);
        writeJson(res, note, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/tasks" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const task = await createLocalTask(state, body);
        scheduleTick(state, 0);
        writeJson(res, task, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/projects/default" && req.method === "PUT") {
      try {
        const body = await readRequestJson(req);
        const projectId = asString(body.projectId);
        if (!projectId) {
          writeJson(res, { message: "projectId is required" }, 400);
          return;
        }
        const selection = await setLocalDefaultProject(state, projectId);
        if (!selection) {
          writeJson(res, { message: "Local project not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, selection);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/projects/default" && req.method === "GET") {
      const selection = localDefaultProjectSelection(state);
      if (!selection) {
        writeJson(res, { message: "Local default project not found" }, 404);
        return;
      }
      writeJson(res, selection);
      return;
    }

    const remoteDomainItemMatch = url.pathname.match(/^\/api\/(projects|notes|tasks)\/([^/]+)$/);
    const taskPinMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pin$/);
    if (taskPinMatch && req.method === "PUT") {
      try {
        const body = await readRequestJson(req);
        if (typeof body.pinned !== "boolean") {
          writeJson(res, { message: "pinned(boolean) is required" }, 400);
          return;
        }
        const result = await setLocalTaskPin(state, decodeURIComponent(taskPinMatch[1]), body.pinned);
        if (!result) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, result);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "projects" && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const project = await updateLocalProject(state, decodeURIComponent(remoteDomainItemMatch[2]), body);
        if (!project) {
          writeJson(res, { message: "Local project not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, project);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "projects" && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalProject(state, decodeURIComponent(remoteDomainItemMatch[2]));
        if (!deleted) {
          writeJson(res, { message: "Local project not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "tasks" && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const task = await updateLocalTask(state, decodeURIComponent(remoteDomainItemMatch[2]), body);
        if (!task) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, task);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "tasks" && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalTask(state, decodeURIComponent(remoteDomainItemMatch[2]));
        if (!deleted) {
          writeJson(res, { message: "Local task not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "notes" && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const note = await updateLocalNote(state, decodeURIComponent(remoteDomainItemMatch[2]), body);
        if (!note) {
          writeJson(res, { message: "Local note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, note);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && remoteDomainItemMatch[1] === "notes" && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalNote(state, decodeURIComponent(remoteDomainItemMatch[2]));
        if (!deleted) {
          writeJson(res, { message: "Local note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (remoteDomainItemMatch && req.method === "GET") {
      const domain = remoteDomainItemMatch[1] as Exclude<RemoteResourceDomain, "artifacts">;
      const item = localRemoteDomainItem(state, domain, decodeURIComponent(remoteDomainItemMatch[2]), {
        includeDeleted: parseBooleanQuery(url.searchParams.get("includeDeleted"))
      });
      if (!item) {
        writeJson(res, { message: `Local ${domain.slice(0, -1)} not found` }, 404);
        return;
      }
      writeJson(res, item);
      return;
    }

    if ((url.pathname === "/api/artifacts/tree" || url.pathname === "/api/artifacts/tree/list") && req.method === "GET") {
      const items = await listLocalArtifactItems(state, {
        includeContent: parseBooleanQuery(url.searchParams.get("includeContent")),
        projectId: url.searchParams.get("projectId") ?? undefined
      });
      writeJson(res, items);
      return;
    }

    const artifactDownloadMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/download$/);
    if (artifactDownloadMatch && req.method === "GET") {
      const item = await getLocalArtifactItemById(state, decodeURIComponent(artifactDownloadMatch[1]), { includeContent: true });
      if (!item) {
        writeJson(res, { message: "Local artifact item not found" }, 404);
        return;
      }
      await sendLocalArtifactDownload(state, item, req, res);
      return;
    }

    const artifactContentPatchMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/content-patch$/);
    if (artifactContentPatchMatch && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const item = await patchLocalArtifactNoteContent(state, decodeURIComponent(artifactContentPatchMatch[1]), body);
        if (!item) {
          writeJson(res, { message: "Local artifact note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const artifactSectionMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)\/section$/);
    if (artifactSectionMatch && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const item = await updateLocalArtifactNoteSection(state, decodeURIComponent(artifactSectionMatch[1]), body);
        if (!item) {
          writeJson(res, { message: "Local artifact note not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    const artifactItemMatch = url.pathname.match(/^\/api\/artifacts\/items\/([^/]+)$/);
    if (artifactItemMatch && req.method === "GET") {
      const item = await getLocalArtifactItemById(state, decodeURIComponent(artifactItemMatch[1]), { includeContent: true });
      if (!item) {
        writeJson(res, { message: "Local artifact item not found" }, 404);
        return;
      }
      writeJson(res, item);
      return;
    }

    if (url.pathname === "/api/artifacts/folders" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const item = await createLocalArtifactFolder(state, body);
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/artifacts/upload" && req.method === "POST") {
      try {
        const item = await createLocalArtifactUploadFromRequest(state, req);
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/api/artifacts/notes" && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const item = await createLocalArtifactNote(state, body);
        scheduleTick(state, 0);
        writeJson(res, item, 201);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (artifactItemMatch && req.method === "PATCH") {
      try {
        const body = await readRequestJson(req);
        const item = await updateLocalArtifactItem(state, decodeURIComponent(artifactItemMatch[1]), body);
        if (!item) {
          writeJson(res, { message: "Local artifact item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        writeJson(res, item);
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (artifactItemMatch && req.method === "DELETE") {
      try {
        const deleted = await deleteLocalArtifactItem(state, decodeURIComponent(artifactItemMatch[1]));
        if (!deleted) {
          writeJson(res, { message: "Local artifact item not found" }, 404);
          return;
        }
        scheduleTick(state, 0);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        writeJson(res, { message: error instanceof Error ? error.message : String(error) }, 400);
      }
      return;
    }

    if (url.pathname === "/conflicts" && req.method === "GET") {
      const status = parseConflictStatus(url.searchParams.get("status")) ?? "open";
      const limit = Number(url.searchParams.get("limit") ?? "50");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        items: listConflicts(state.manifestStore, {
          status,
          limit: Number.isFinite(limit) ? limit : 50
        })
      }, null, 2));
      return;
    }

    const resolveMatch = url.pathname.match(/^\/conflicts\/([^/]+)\/resolve$/);
    if (resolveMatch && req.method === "POST") {
      try {
        const body = await readRequestJson(req);
        const resolution = parseConflictResolution(body.resolution);
        if (!resolution) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message: "resolution must be retry, ignore, or close" }));
          return;
        }
        const note = typeof body.note === "string" ? body.note : undefined;
        const conflict = resolveConflict(state.manifestStore, decodeURIComponent(resolveMatch[1]), resolution, note);
        if (!conflict) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message: "Conflict not found" }));
          return;
        }
        await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
        await refreshManifestStats(state);
        if (resolution === "retry") {
          scheduleTick(state, 0);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(conflict, null, 2));
        return;
      } catch (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
        return;
      }
    }

    res.statusCode = 404;
    res.end("not found");
  }));
  server.listen(state.config.httpPort, "127.0.0.1", () => {
    console.log(`[sync-daemon] status listening on http://127.0.0.1:${state.config.httpPort}/status`);
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  await ensureDirs(config);
  await ensureLoopbackApiToken(config);
  const manifestStore = openManifestStore(config.syncRoot);
  await migrateLegacyManifestJson(config.syncRoot, manifestStore);
  await writeManifestDebugSnapshot(config.syncRoot, manifestStore);
  const state: DaemonState = {
    config,
    manifestStore,
    identity: await readIdentity(config),
    processedJobs: 0,
    outboxPending: 0,
    outboxFailed: 0,
    conflictsOpen: 0,
    watcherActive: false,
    tickRunning: false,
    tickQueued: false
  };
  const captureGetJson = async <T>(pathValue: string): Promise<T> => {
    const identity = state.identity;
    if (!identity) throw new Error("Local client identity is not registered.");
    return coreJson<T>(config, pathValue, { method: "GET", localIdentity: identity });
  };
  state.capturePolicy = new CaptureServerPolicyProvider({
    getJson: captureGetJson,
    getMachineId: () => state.capture?.storage.getMeta(CAPTURE_UPLOAD_META_KEYS.machineId)?.trim() || undefined,
    logger: console
  });
  state.capture = new CaptureManager({
    syncRoot: config.syncRoot,
    dbPath: env("WORKBENCH_CAPTURE_DB_PATH"),
    platform: platform(),
    logger: console,
    getServerPolicy: () => state.capturePolicy?.get() ?? null
  });
  state.captureUploader = new CaptureUploader({
    storage: state.capture.storage,
    displayName: config.clientName || hostname(),
    platform: platform(),
    logger: console,
    getServerPolicy: () => state.capturePolicy?.get() ?? null,
    getJson: async <T>(pathValue: string): Promise<T> => {
      const identity = state.identity;
      if (!identity) throw new Error("Local client identity is not registered.");
      return coreJson<T>(config, pathValue, {
        method: "GET",
        localIdentity: identity
      });
    },
    postJson: async <T>(pathValue: string, body: unknown): Promise<T> => {
      const identity = state.identity;
      if (!identity) throw new Error("Local client identity is not registered.");
      return coreJson<T>(config, pathValue, {
        method: "POST",
        localIdentity: identity,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }
  });
  if (state.identity) {
    await state.capturePolicy.refresh();
    await state.capture.reconcile();
  }
  await state.capture.startFromConfig();
  startStatusServer(state);
  startSyncWatcher(state);
  await tick(state);
  setInterval(() => {
    void tick(state);
  }, config.intervalMs);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  await main();
}
