

import {
  hostname,
  platform
} from "node:os";
import {
  dirname,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  watch
} from "node:fs";
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
  defaultNotePath,
  isIgnoredSyncPath,
  isIgnoredSyncRelativePath,
  isPathInsideDirectory,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  normalizeRelativePath,
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
  localNoteProjectSummaries,
  normalizeStringArray,
  noteOutboxPath,
  updateLocalNote
} from "./localNotes.js";
import {
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
  isLocalProjectContextMutation,
  isSupportedLocalProjectContextWrite
} from "./httpApi.js";
import {
  applyRemoteArtifactEvent,
  applyRemoteArtifactSnapshotEntry,
  applyRemoteSnapshot,
  applyRemoteDomainEvent,
  applyRemoteDomainSnapshotEntry,
  bootstrapPagedDomainSnapshots,
  bootstrapProjectContextSnapshot,
  classifySyncError,
  clearSyncErrorState,
  fetchProjectContextDetail,
  firstRecord,
  getSyncPullPage,
  getSyncSnapshot,
  isLegacyProjectContextEvent,
  isRemoteResourceTombstone,
  isRemoteTombstone,
  normalizedProjectEventMarker,
  parseRemoteResourceDomain,
  projectContextEventIsStale,
  projectContextSnapshotPage,
  pushOutbox,
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
  snapshotSupportsProjectContext,
  setSyncErrorState,
  logSyncDaemonErrorOnce
} from "./remoteSync.js";
import {
  claimJobs,
  coreJson,
  ensureIdentity,
  heartbeat
} from "./coreClient.js";
import {
  approvePendingLocalJobConfirmation,
  listPendingLocalJobConfirmations,
  processJob,
  rejectPendingLocalJobConfirmation
} from "./jobs.js";
import { createTickScheduler, scheduleTick } from "./tickScheduler.js";
import {
  pullRemoteArtifactSyncState
} from "./remotePull.js";
export { pullRemoteArtifactSyncState } from "./remotePull.js";
import { startStatusServer } from "./statusServer.js";
export { handleLocalProjectContextWrite } from "./statusServer.js";

export { readIdentity } from "./identityStorage.js";
export type { ClientIdentity, SecureIdentityMode } from "./identityStorage.js";
export {
  ensureIdentity,
  registerIfNeeded
} from "./coreClient.js";
export {
  approvePendingLocalJobConfirmation,
  listPendingLocalJobConfirmations,
  localJobRequiresConfirmation,
  processJob,
  rejectPendingLocalJobConfirmation
} from "./jobs.js";
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
  applyRemoteSnapshot,
  applyRemoteDomainEvent,
  applyRemoteDomainSnapshotEntry,
  applyRemoteProjectDefaultEvent,
  canApplyRemoteArtifact,
  canApplyRemoteArtifactFolderDelete,
  classifySyncError,
  bootstrapPagedArtifactSnapshot,
  bootstrapPagedDomainSnapshot,
  bootstrapPagedDomainSnapshots,
  bootstrapProjectContextSnapshot,
  clearSyncErrorState,
  directoryHasUntrackedVisibleEntries,
  fallbackRemoteArtifactLeaf,
  fetchProjectContextDetail,
  fetchRemoteArtifactBlob,
  findResourceById,
  firstRecord,
  getSyncPullPage,
  getSyncSnapshot,
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
  pruneLegacyProjectContextRows,
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
  snapshotSupportsProjectContext,
  setSyncErrorState,
  logSyncDaemonErrorOnce,
  postSyncPush,
  extractResourceId,
  writeConflictRecord,
  pushOutbox,
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
  migrateLegacyManifestJson,
  openManifestStore,
  writeManifestDebugSnapshot
} from "./manifestStore.js";
import {
  asNumber,
  asRecord,
  asString,
  listLocalRemoteDomainItems,
  localRemoteDomainItem,
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
  CAPTURE_UPLOAD_META_KEYS,
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
  LocalJob
} from "./types.js";

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
  // Wired before anything can ask for a tick, so scheduleTick always lands.
  state.ticker = createTickScheduler(state, performTick);
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
  await state.ticker.run();
  setInterval(() => {
    void state.ticker?.run();
  }, config.intervalMs);
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  await main();
}
