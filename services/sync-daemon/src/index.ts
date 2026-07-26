import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  readIdentity,
  writeIdentity,
  type ClientIdentity,
  type SecureIdentityMode
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
  directoryPathFor,
  hashFile,
  isIgnoredSyncPath,
  isIgnoredSyncRelativePath,
  isPathInsideDirectory,
  mimeTypeForPath,
  normalizeArtifactFolderPath,
  normalizeArtifactRelativePath,
  normalizeRelativePath,
  normalizeSha256Checksum,
  parseContentDispositionFilename,
  relativeSyncPath,
  resolveSyncRootRelativePath,
  sanitizeFileName,
  sanitizePathSegment,
  sleep,
  titleFor,
  uniquePath
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
  buildLocalArtifactItem,
  buildLocalFolderItem,
  buildOutboxPayloadForFile,
  buildOutboxPayloadForFolder,
  getLocalArtifactItemById,
  listLocalArtifactItems,
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
  classifySyncError,
  stringFromUnknown,
  type SyncErrorDetails
} from "./remoteSync.js";

export { readIdentity } from "./identityStorage.js";
export type { ClientIdentity, SecureIdentityMode } from "./identityStorage.js";
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
export * from "./localTasks.js";
export * from "./localArtifacts.js";
export * from "./remoteSync.js";
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
  hasOpenOutboxForPath,
  listAllRemoteResourcesForDomain,
  listRemoteResources,
  listConflicts,
  listOpenOutboxForResource,
  listOpenOutboxUnderPath,
  listPendingOutbox,
  listResources,
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
  type ManifestResource,
  type ManifestStore,
  type OutboxItem,
  type RemoteResource,
  type RemoteResourceDomain,
  type SyncErrorCategory
} from "./manifestStore.js";
import {
  asNumber,
  asRecord,
  asString,
  decodeLocalItemId,
  enqueueManifestOutbox,
  localItemId,
  listLocalRemoteDomainItems,
  localRemoteDomainItem,
  localProjectId,
  localProjectName,
  refreshManifestStats,
  remoteResourceUpdatedAt,
  resultRecord,
  runWithClientOpId,
  supersedeOpenOutboxForPath,
  uniqueRelativePath
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
  SyncPushResponse
} from "./types.js";

class CoreHttpError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CoreHttpError";
    this.status = status;
    this.code = code;
  }
}

function coreHttpError(response: Response, body: string): CoreHttpError {
  let message: string | undefined;
  let code: string | undefined;
  const trimmed = body.trim();

  if (trimmed.startsWith("{") || response.headers.get("content-type")?.includes("application/json")) {
    try {
      const parsed = JSON.parse(trimmed) as { message?: unknown; error?: unknown; code?: unknown };
      message = stringFromUnknown(parsed.message) ?? stringFromUnknown(parsed.error);
      code = stringFromUnknown(parsed.code);
    } catch {
      // Fall through to the compact non-JSON response below.
    }
  }

  const cloudflareTunnelOffline = /cloudflare tunnel error/i.test(trimmed) && (
    /errorcode\s*:\s*1033/i.test(trimmed)
    || /<span[^>]*>\s*1033\s*<\/span>/i.test(trimmed)
    || /error\s+1033/i.test(trimmed)
  );
  if (cloudflareTunnelOffline) {
    return new CoreHttpError(
      `Cloud API is unavailable because its Cloudflare tunnel is offline (HTTP ${response.status}, error 1033).`,
      response.status,
      "CLOUDFLARE_TUNNEL_UNAVAILABLE"
    );
  }

  if (!message && trimmed && !/^<!doctype html/i.test(trimmed) && !/^<html/i.test(trimmed)) {
    message = trimmed.replace(/\s+/g, " ").slice(0, 500);
  }

  return new CoreHttpError(
    message ?? `Cloud API request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
    response.status,
    code
  );
}

async function coreJson<T>(
  config: DaemonConfig,
  pathValue: string,
  init: RequestInit & { localIdentity?: ClientIdentity; accessToken?: string } = {}
): Promise<T> {
  const { localIdentity, accessToken, ...fetchInit } = init;
  const headers: Record<string, string> = {
    ...(fetchInit.headers as Record<string, string> | undefined)
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (localIdentity) {
    headers["x-workbench-local-client-id"] = localIdentity.localClientId;
    headers["x-workbench-local-client-token"] = localIdentity.localClientToken;
  }
  const response = await fetch(`${config.coreUrl}${pathValue}`, {
    ...fetchInit,
    headers
  });
  const text = await response.text();
  if (!response.ok) {
    throw coreHttpError(response, text);
  }
  return (text.trim() ? JSON.parse(text) : undefined) as T;
}

export async function registerIfNeeded(config: DaemonConfig): Promise<ClientIdentity> {
  const existing = await readIdentity(config);
  if (existing) return existing;
  if (!config.accessToken) {
    throw new Error("WORKBENCH_ACCESS_TOKEN is required for first local client registration.");
  }

  const result = await coreJson<{
    client: { id: string; deviceId: string; syncRootId: string };
    clientToken: string;
  }>(config, "/api/local-clients/register", {
    method: "POST",
    accessToken: config.accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: config.deviceId,
      clientName: config.clientName,
      platform: platform(),
      capabilities: {
        localJobs: true,
        downloads: true,
        syncFolder: true
      },
      syncRootId: config.syncRootId,
      syncRootLabel: config.syncRootLabel,
      default: true
    })
  });

  const identity: ClientIdentity = {
    localClientId: result.client.id,
    localClientToken: result.clientToken,
    deviceId: result.client.deviceId,
    syncRootId: result.client.syncRootId
  };
  await writeIdentity(config, identity);
  return identity;
}

export async function ensureIdentity(state: Pick<DaemonState, "config" | "identity">): Promise<ClientIdentity> {
  if (state.identity) return state.identity;
  const identity = await registerIfNeeded(state.config);
  state.identity = identity;
  return identity;
}

async function heartbeat(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  await refreshManifestStats(state);
  await coreJson(state.config, `/api/local-clients/${encodeURIComponent(state.identity.localClientId)}/heartbeat`, {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      daemonVersion: "0.1.0",
      syncRootState: {
        syncRoot: state.config.syncRoot,
        downloadsDir: state.config.downloadsDir,
        processedJobs: state.processedJobs,
        outboxPending: state.outboxPending,
        outboxFailed: state.outboxFailed,
        conflictsOpen: state.conflictsOpen,
        watcherActive: state.watcherActive,
        lastScanAt: state.lastScanAt,
        lastPushAt: state.lastPushAt,
        lastRemotePullAt: state.lastRemotePullAt
      }
    })
  });
  state.lastHeartbeatAt = new Date().toISOString();
}

async function claimJobs(state: DaemonState): Promise<LocalJob[]> {
  if (!state.identity) return [];
  const result = await coreJson<{ items: LocalJob[] }>(state.config, "/api/local-jobs/claim", {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 5 })
  });
  state.lastClaimAt = new Date().toISOString();
  return result.items;
}

function assertExpectedDownloadChecksum(expected: string | null, actualHex: string): void {
  const expectedHex = normalizeSha256Checksum(expected);
  if (expectedHex && expectedHex !== actualHex.toLowerCase()) {
    throw new Error("Download checksum mismatch");
  }
}

async function downloadJobFile(state: DaemonState, job: LocalJob): Promise<{
  localPath: string;
  checksum: string;
  sizeBytes: number;
}> {
  if (!state.identity) throw new Error("Missing local client identity");
  const response = await fetch(`${state.config.coreUrl}/api/local-jobs/${encodeURIComponent(job.id)}/download`, {
    headers: {
      "x-workbench-local-client-id": state.identity.localClientId,
      "x-workbench-local-client-token": state.identity.localClientToken
    }
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(buffer.toString("utf8") || `HTTP ${response.status}`);
  }
  const checksum = createHash("sha256").update(buffer).digest("hex");
  assertExpectedDownloadChecksum(response.headers.get("x-workbench-content-checksum"), checksum);

  const requestedName = typeof job.payload.filename === "string" ? job.payload.filename : undefined;
  const headerName = parseContentDispositionFilename(response.headers.get("content-disposition"));
  const filename = sanitizeFileName(requestedName || headerName || basename(job.id));
  const directory = job.target === "sync-folder" ? state.config.syncRoot : state.config.downloadsDir;
  const localPath = await uniquePath(directory, filename);
  if (!isPathInsideDirectory(directory, localPath)) {
    throw new Error("Invalid local job download path");
  }
  await fs.mkdir(dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, buffer);

  return {
    localPath,
    checksum,
    sizeBytes: buffer.byteLength
  };
}

function getLocalArtifactResourceById(state: DaemonState, id: string): ManifestResource | undefined {
  const local = decodeLocalItemId(id);
  const resources = listResources(state.manifestStore);
  return resources.find((item) => item.resourceId === id)
    ?? (local ? resources.find((item) => item.kind === local.kind && item.relativePath === local.relativePath) : undefined);
}

async function readLocalNoteContent(state: DaemonState, relativePath: string): Promise<string> {
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) return "";
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch {
    return "";
  }
}

function assertExpectedLocalVersion(value: unknown): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error("expectedVersion must be a positive integer");
  }
  if (value !== 1) {
    throw new Error(`Version conflict: expected ${value}, current 1`);
  }
}

function decodeContentBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error("contentBase64 must be valid base64");
  }
  return Buffer.from(compact, "base64");
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readRequiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return Number(value);
}

function applyLocalNotePatchOperation(content: string, operation: unknown): string {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error("Patch operation must be an object");
  }
  const record = operation as Record<string, unknown>;
  const type = record.type;
  if (type === "insert") {
    const index = readRequiredInteger(record, "index");
    if (index < 0 || index > content.length) {
      throw new Error("Insert index is out of range");
    }
    return `${content.slice(0, index)}${readRequiredString(record, "text")}${content.slice(index)}`;
  }

  if (type !== "delete" && type !== "replace") {
    throw new Error("Patch operation type must be insert, delete, or replace");
  }

  const start = readRequiredInteger(record, "start");
  const end = readRequiredInteger(record, "end");
  if (start < 0 || end < start || end > content.length) {
    throw new Error("Patch range is out of range");
  }

  if (type === "delete") {
    return `${content.slice(0, start)}${content.slice(end)}`;
  }
  return `${content.slice(0, start)}${readRequiredString(record, "text")}${content.slice(end)}`;
}

function applyLocalNotePatchOperations(content: string, operations: unknown): string {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("At least one patch operation is required");
  }
  if (operations.length > 100) {
    throw new Error("Too many patch operations");
  }
  return operations.reduce((nextContent, operation) => applyLocalNotePatchOperation(nextContent, operation), content);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function findMarkdownSection(
  content: string,
  heading: string,
  level?: number
): { bodyStart: number; sectionEnd: number; level: number } | undefined {
  const normalizedHeading = heading.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalizedHeading) {
    throw new Error("heading is required");
  }

  const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content)) !== null) {
    const headingLevel = match[1].length;
    if (level !== undefined && headingLevel !== level) {
      continue;
    }

    const text = match[2].trim().replace(/\s+/g, " ").toLowerCase();
    if (text !== normalizedHeading) {
      continue;
    }

    const lineEnd = content.indexOf("\n", match.index);
    const bodyStart = lineEnd === -1 ? content.length : lineEnd + 1;
    const restPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
    restPattern.lastIndex = bodyStart;

    let sectionEnd = content.length;
    let nextMatch: RegExpExecArray | null;
    while ((nextMatch = restPattern.exec(content)) !== null) {
      if (nextMatch[1].length <= headingLevel) {
        sectionEnd = nextMatch.index;
        break;
      }
    }

    return { bodyStart, sectionEnd, level: headingLevel };
  }

  return undefined;
}

function applyLocalNoteSectionUpdate(content: string, input: Record<string, unknown>): string {
  const heading = readRequiredString(input, "heading");
  const rawLevel = input.level;
  const level = rawLevel === undefined ? undefined : readRequiredInteger(input, "level");
  if (level !== undefined && (level < 1 || level > 6)) {
    throw new Error("level must be between 1 and 6");
  }
  const rawMode = input.mode;
  const mode = rawMode === undefined ? "replaceBody" : rawMode;
  if (mode !== "replaceBody" && mode !== "appendBody" && mode !== "prependBody") {
    throw new Error("mode must be replaceBody, appendBody, or prependBody");
  }
  const nextBody = ensureTrailingNewline(readRequiredString(input, "contentMarkdown"));
  const section = findMarkdownSection(content, heading, level);

  if (!section) {
    if (input.createIfMissing !== true) {
      throw new Error("Heading not found");
    }
    const nextLevel = level ?? 2;
    const separator = content.trim().length === 0 ? "" : "\n\n";
    return `${content}${separator}${"#".repeat(nextLevel)} ${heading.trim()}\n${nextBody}`;
  }

  const currentBody = content.slice(section.bodyStart, section.sectionEnd);
  let replacementBody = nextBody;
  if (mode === "appendBody") {
    const separator = currentBody.endsWith("\n") || currentBody.length === 0 ? "" : "\n";
    replacementBody = `${currentBody}${separator}${nextBody}`;
  } else if (mode === "prependBody") {
    const separator = nextBody.endsWith("\n") || currentBody.length === 0 ? "" : "\n";
    replacementBody = `${nextBody}${separator}${currentBody}`;
  }

  return `${content.slice(0, section.bodyStart)}${replacementBody}${content.slice(section.sectionEnd)}`;
}

export async function createLocalArtifactFolder(
  state: DaemonState,
  input: Record<string, unknown>
): Promise<LocalArtifactItem> {
  const rawPath = typeof input.path === "string" && input.path.trim()
    ? input.path.trim()
    : typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : "";
  const requestedPath = normalizeArtifactFolderPath(rawPath);
  if (!requestedPath || !resolveSyncRootRelativePath(state.config, requestedPath)) {
    throw new Error("Invalid artifact folder path");
  }

  const relativePath = await uniqueRelativePath(state.config, requestedPath, undefined, "folder");
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) {
    throw new Error("Invalid artifact folder path");
  }

  await fs.mkdir(absolutePath, { recursive: true });
  const stat = await fs.stat(absolutePath);
  const now = new Date().toISOString();
  const updatedAt = stat.mtime.toISOString();
  supersedeOpenOutboxForPath(
    state,
    relativePath,
    () => true,
    "Local folder was created through daemon facade; stale folder operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    action: "create",
    payload: buildOutboxPayloadForFolder(relativePath)
  });
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: "folder",
    dirty: true,
    lastSeenAt: now,
    localUpdatedAt: updatedAt
  });
  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  const resource = getResource(state.manifestStore, relativePath);
  return resource ? buildLocalArtifactItem(state, resource) : buildLocalFolderItem(state, relativePath, updatedAt);
}

export async function createLocalArtifactFile(
  state: DaemonState,
  input: Record<string, unknown>
): Promise<LocalArtifactItem> {
  const rawFilename = typeof input.originalFilename === "string" && input.originalFilename.trim()
    ? input.originalFilename.trim()
    : typeof input.filename === "string" && input.filename.trim()
      ? input.filename.trim()
      : "file";
  const filename = sanitizePathSegment(rawFilename, "file");
  let directoryPath: string | undefined;
  if (typeof input.directoryPath === "string" && input.directoryPath.trim()) {
    directoryPath = normalizeArtifactFolderPath(input.directoryPath);
    if (!directoryPath) {
      throw new Error("Invalid artifact file path");
    }
  }
  const requestedPath = directoryPath ? `${directoryPath}/${filename}` : filename;
  const relativePath = await uniqueRelativePath(state.config, requestedPath, undefined, filename);
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) {
    throw new Error("Invalid artifact file path");
  }
  if (typeof input.contentBase64 !== "string") {
    throw new Error("contentBase64 is required");
  }

  const buffer = decodeContentBase64(input.contentBase64);
  if (buffer.byteLength > state.config.maxSyncFileBytes) {
    throw new Error(`File exceeds max sync size of ${state.config.maxSyncFileBytes} bytes`);
  }

  const now = new Date().toISOString();
  supersedeOpenOutboxForPath(
    state,
    relativePath,
    () => true,
    "Local file was changed through daemon upload facade; stale operation was superseded.",
    now
  );

  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);
  const stat = await fs.stat(absolutePath);
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const mimeType = typeof input.mimeType === "string" && input.mimeType.trim()
    ? input.mimeType.trim()
    : mimeTypeForPath(relativePath);

  enqueueManifestOutbox(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    action: "create",
    payload: {
      kind: "file",
      filename: basename(relativePath),
      directoryPath: directoryPathFor(relativePath),
      mimeType,
      contentBase64: buffer.toString("base64"),
      maxSyncFileBytes: state.config.maxSyncFileBytes
    }
  });
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: "file",
    checksum,
    sizeBytes: stat.size,
    dirty: true,
    lastSeenAt: now,
    localUpdatedAt: stat.mtime.toISOString()
  });
  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);

  const resource = getResource(state.manifestStore, relativePath);
  return resource
    ? buildLocalArtifactItem(state, resource)
    : {
        id: localItemId("file", relativePath),
        projectId: localProjectId(state),
        projectName: localProjectName(state),
        kind: "file",
        title: titleFor(relativePath),
        path: relativePath,
        parentPath: directoryPathFor(relativePath) ?? "",
        scope: "private",
        tags: [],
        mimeType,
        sizeBytes: stat.size,
        version: 1,
        createdAt: now,
        updatedAt: now
      };
}

async function writeLocalNoteAndQueue(
  state: DaemonState,
  options: {
    relativePath: string;
    contentMarkdown: string;
    resourceId?: string;
    action: "create" | "update";
    previousRelativePath?: string;
  }
): Promise<LocalArtifactItem> {
  const now = new Date().toISOString();
  const relativePath = normalizeArtifactRelativePath(options.relativePath);
  const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
  if (!absolutePath) {
    throw new Error("Invalid artifact note path");
  }

  if (options.previousRelativePath && options.previousRelativePath !== relativePath) {
    supersedeOpenOutboxForPath(
      state,
      options.previousRelativePath,
      () => true,
      "Local note path changed through daemon facade; stale operation was superseded.",
      now
    );
    const previousAbsolutePath = resolveSyncRootRelativePath(state.config, options.previousRelativePath);
    if (previousAbsolutePath) {
      await fs.rm(previousAbsolutePath, { force: true }).catch(() => {
        // Best-effort cleanup after local rename.
      });
    }
    removeResource(state.manifestStore, options.previousRelativePath);
  }

  supersedeOpenOutboxForPath(
    state,
    relativePath,
    () => true,
    "Local note was changed through daemon facade; stale operation was superseded.",
    now
  );

  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, options.contentMarkdown, "utf8");
  const stat = await fs.stat(absolutePath);
  const checksum = await hashFile(absolutePath);
  const payload = await buildOutboxPayloadForFile(state.config, absolutePath, relativePath, "note");

  enqueueManifestOutbox(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    action: options.action,
    resourceId: options.action === "update" ? options.resourceId : undefined,
    payload
  });
  upsertManifestResource(state.manifestStore, {
    relativePath,
    domain: "artifacts",
    kind: "note",
    resourceId: options.resourceId,
    checksum,
    sizeBytes: stat.size,
    dirty: true,
    lastSeenAt: now,
    localUpdatedAt: stat.mtime.toISOString()
  });
  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);

  const resource = getResource(state.manifestStore, relativePath);
  return resource
    ? buildLocalArtifactItem(state, resource, { includeContent: true })
    : {
        id: localItemId("note", relativePath),
        projectId: localProjectId(state),
        projectName: localProjectName(state),
        kind: "note",
        title: titleFor(relativePath),
        path: relativePath,
        parentPath: directoryPathFor(relativePath) ?? "",
        scope: "private",
        tags: [],
        mimeType: "text/markdown",
        sizeBytes: stat.size,
        version: 1,
        contentMarkdown: options.contentMarkdown,
        createdAt: now,
        updatedAt: now
      };
}

export async function createLocalArtifactNote(
  state: DaemonState,
  input: Record<string, unknown>
): Promise<LocalArtifactItem> {
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Untitled";
  const requestedPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : defaultNotePath(title);
  const relativePath = await uniqueRelativePath(state.config, requestedPath);
  if (!relativePath) {
    throw new Error("Invalid artifact note path");
  }
  const contentMarkdown = typeof input.contentMarkdown === "string" ? input.contentMarkdown : "";
  return writeLocalNoteAndQueue(state, {
    relativePath,
    contentMarkdown,
    action: "create"
  });
}

export async function updateLocalArtifactItem(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<LocalArtifactItem | undefined> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return undefined;
  if (resource.kind !== "note") {
    throw new Error("Only local note items can be updated through the daemon facade in this phase");
  }

  const item = await buildLocalArtifactItem(state, resource, { includeContent: true });
  let nextRelativePath = resource.relativePath;
  if (typeof input.path === "string" && input.path.trim()) {
    nextRelativePath = await uniqueRelativePath(state.config, input.path.trim(), resource.relativePath);
    if (!nextRelativePath) {
      throw new Error("Invalid artifact note path");
    }
  } else if (typeof input.title === "string" && input.title.trim() && input.title.trim() !== item.title) {
    const parent = directoryPathFor(resource.relativePath);
    const requested = parent ? `${parent}/${defaultNotePath(input.title.trim())}` : defaultNotePath(input.title.trim());
    nextRelativePath = await uniqueRelativePath(state.config, requested, resource.relativePath);
    if (!nextRelativePath) {
      throw new Error("Invalid artifact note path");
    }
  }

  const contentMarkdown = typeof input.contentMarkdown === "string"
    ? input.contentMarkdown
    : item.contentMarkdown ?? await readLocalNoteContent(state, resource.relativePath);
  return writeLocalNoteAndQueue(state, {
    relativePath: nextRelativePath,
    previousRelativePath: resource.relativePath,
    contentMarkdown,
    resourceId: resource.resourceId,
    action: resource.resourceId ? "update" : "create"
  });
}

export async function patchLocalArtifactNoteContent(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<LocalArtifactItem | undefined> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return undefined;
  if (resource.kind !== "note") {
    throw new Error("Only local note items support markdown content patches");
  }

  assertExpectedLocalVersion(input.expectedVersion);
  const currentContent = await readLocalNoteContent(state, resource.relativePath);
  const contentMarkdown = applyLocalNotePatchOperations(currentContent, input.operations);
  return writeLocalNoteAndQueue(state, {
    relativePath: resource.relativePath,
    contentMarkdown,
    resourceId: resource.resourceId,
    action: resource.resourceId ? "update" : "create"
  });
}

export async function updateLocalArtifactNoteSection(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<LocalArtifactItem | undefined> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return undefined;
  if (resource.kind !== "note") {
    throw new Error("Only local note items support markdown section updates");
  }

  assertExpectedLocalVersion(input.expectedVersion);
  const currentContent = await readLocalNoteContent(state, resource.relativePath);
  const contentMarkdown = applyLocalNoteSectionUpdate(currentContent, input);
  return writeLocalNoteAndQueue(state, {
    relativePath: resource.relativePath,
    contentMarkdown,
    resourceId: resource.resourceId,
    action: resource.resourceId ? "update" : "create"
  });
}

export async function deleteLocalArtifactItem(state: DaemonState, id: string): Promise<boolean> {
  const resource = getLocalArtifactResourceById(state, id);
  if (!resource) return false;
  const now = new Date().toISOString();
  supersedeOpenOutboxForPath(
    state,
    resource.relativePath,
    () => true,
    "Local artifact was deleted through daemon facade; stale operation was superseded.",
    now
  );

  const absolutePath = resolveSyncRootRelativePath(state.config, resource.relativePath);
  if (absolutePath) {
    await fs.rm(absolutePath, { recursive: resource.kind === "folder", force: true }).catch(() => {
      // Best-effort local file deletion.
    });
  }

  if (resource.resourceId) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: resource.relativePath,
      domain: "artifacts",
      action: "delete",
      resourceId: resource.resourceId,
      payload: resource.kind === "folder" ? buildOutboxPayloadForFolder(resource.relativePath) : {}
    });
    upsertManifestResource(state.manifestStore, {
      ...resource,
      dirty: true,
      lastSeenAt: now
    });
  } else {
    removeResource(state.manifestStore, resource.relativePath);
  }

  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

type RemoteArtifactKind = "folder" | "note" | "file";

type RemoteArtifactItem = {
  id: string;
  kind: RemoteArtifactKind;
  title?: string;
  path?: string;
  parentPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  version?: number;
  updatedAt?: string;
  contentMarkdown?: string;
  contentBase64?: string;
};

type RemoteSyncEvent = {
  cursor?: string;
  domain?: string;
  resourceId?: string;
  action?: string;
  version?: number;
  payload?: Record<string, unknown>;
  createdAt?: string;
};

type SyncPullResponse = {
  events?: RemoteSyncEvent[];
  nextCursor?: string;
};

type SyncSnapshotResponse = {
  generatedAt?: string;
  baselineCursor?: string;
  supportedDomains?: string[];
  domains?: Partial<Record<RemoteResourceDomain, unknown>>;
};

const REMOTE_SYNC_DOMAINS: RemoteResourceDomain[] = ["projects", "notes", "artifacts", "tasks"];
const REMOTE_SYNC_CURSOR_META_KEY = "remoteSyncCursor";
const REMOTE_ARTIFACT_CURSOR_META_KEY = "remoteArtifactCursor";
const REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY = "remoteArtifactSnapshotComplete";
const LAST_REMOTE_PULL_AT_META_KEY = "lastRemotePullAt";
const REMOTE_PULL_LIMIT = 100;
const REMOTE_SNAPSHOT_PAGE_LIMIT = 100;
const REMOTE_CURSOR_DRAIN_LIMIT = 500;

function parseRemoteResourceDomain(value: unknown): RemoteResourceDomain | undefined {
  return value === "projects"
    || value === "notes"
    || value === "artifacts"
    || value === "tasks"
    || value === PROJECT_CONTEXT_DOMAIN
    ? value
    : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return undefined;
}

function remoteResourceIdFromUnknown(value: unknown, fallbackResourceId?: string): string | undefined {
  const record = asRecord(value);
  return asString(record?.id)
    ?? asString(record?._id)
    ?? asString(record?.resourceId)
    ?? fallbackResourceId;
}

function remoteResourcePayloadFromEvent(event: RemoteSyncEvent): { payload: Record<string, unknown>; merge: boolean } {
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

function remoteResourcePayloadFromSnapshot(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function isRemoteResourceTombstone(event: RemoteSyncEvent): boolean {
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

function normalizedProjectEventMarker(value: unknown): string | undefined {
  return asString(value)?.toLowerCase().replaceAll("_", "-");
}

function recordHasLegacyProjectContextShape(value: unknown): boolean {
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

function isLegacyProjectContextEvent(event: RemoteSyncEvent): boolean {
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

function snapshotItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["items", "data", "results", "projects", "notes", "tasks", "artifacts"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function snapshotNextCursor(value: unknown): string | undefined {
  const record = asRecord(value);
  return asString(record?.nextCursor);
}

function parseRemoteArtifactKind(value: unknown): RemoteArtifactKind | undefined {
  return value === "folder" || value === "note" || value === "file" ? value : undefined;
}

function remoteArtifactFromUnknown(value: unknown, fallbackResourceId?: string): RemoteArtifactItem | undefined {
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

function remoteArtifactFromEvent(event: RemoteSyncEvent): RemoteArtifactItem | undefined {
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

function isRemoteTombstone(event: RemoteSyncEvent, item?: RemoteArtifactItem): boolean {
  const payload = asRecord(event.payload) ?? {};
  return event.action === "delete"
    || payload.deleted === true
    || payload.tombstone === true
    || typeof payload.deletedAt === "string"
    || (item ? (asRecord(item)?.deleted === true || asRecord(item)?.tombstone === true) : false);
}

function fallbackRemoteArtifactLeaf(item: RemoteArtifactItem): string {
  if (item.kind === "note") {
    return defaultNotePath(item.title ?? item.id);
  }
  if (item.kind === "file") {
    return sanitizePathSegment(item.title ?? item.id, "file");
  }
  return sanitizePathSegment(item.title ?? item.id, "folder");
}

function relativePathForRemoteArtifact(item: RemoteArtifactItem): string | undefined {
  if (item.kind === "folder") {
    const requested = item.path ?? (item.parentPath ? `${item.parentPath}/${item.title ?? item.id}` : item.title ?? item.id);
    const relativePath = normalizeArtifactFolderPath(requested);
    return relativePath && !isIgnoredSyncRelativePath(relativePath) ? relativePath : undefined;
  }

  const requested = item.path ?? (item.parentPath ? `${item.parentPath}/${fallbackRemoteArtifactLeaf(item)}` : fallbackRemoteArtifactLeaf(item));
  const relativePath = normalizeArtifactRelativePath(requested, fallbackRemoteArtifactLeaf(item));
  return relativePath && !isIgnoredSyncRelativePath(relativePath) ? relativePath : undefined;
}

function findResourceById(state: DaemonState, resourceId: string): ManifestResource | undefined {
  return listResources(state.manifestStore).find((resource) => resource.resourceId === resourceId);
}

function pathIsSelfOrChild(relativePath: string, parentPath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedParent = normalizeRelativePath(parentPath).replace(/\/+$/, "");
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function resourcesUnderPath(state: DaemonState, relativePath: string): ManifestResource[] {
  return listResources(state.manifestStore).filter((resource) => pathIsSelfOrChild(resource.relativePath, relativePath));
}

async function localPathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function isLocalArtifactDirty(
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

function hasOpenOutboxForRemoteArtifact(state: DaemonState, relativePath?: string, resourceId?: string): boolean {
  if (relativePath && hasOpenOutboxForPath(state.manifestStore, relativePath)) return true;
  if (resourceId && listOpenOutboxForResource(state.manifestStore, resourceId).length > 0) return true;
  return false;
}

function hasOpenOutboxUnderRemoteFolder(state: DaemonState, relativePath: string, resourceId?: string): boolean {
  if (listOpenOutboxUnderPath(state.manifestStore, relativePath).length > 0) return true;
  if (resourceId && listOpenOutboxForResource(state.manifestStore, resourceId).length > 0) return true;
  return false;
}

async function directoryHasUntrackedVisibleEntries(
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

async function writeRemoteConflict(
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

async function canApplyRemoteArtifact(
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

async function canApplyRemoteArtifactFolderDelete(
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

async function fetchRemoteArtifactBlob(state: DaemonState, artifactId: string): Promise<Buffer | undefined> {
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

async function remoteArtifactBuffer(
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

async function applyRemoteArtifactItem(
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

async function applyRemoteArtifactDelete(
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

async function applyRemoteArtifactEvent(state: DaemonState, event: RemoteSyncEvent): Promise<void> {
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

async function applyRemoteArtifactSnapshotEntry(
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

function remoteResourceRecord(
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

function applyRemoteDomainSnapshotEntry(
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

function applyRemoteProjectDefaultEvent(
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

function projectContextSnapshotPage(value: unknown): { items: unknown[]; nextCursor?: string } {
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

function projectContextEventIsStale(state: DaemonState, event: RemoteSyncEvent): boolean {
  if (event.version === undefined || !event.resourceId) return false;
  const current = getRemoteResource(state.manifestStore, PROJECT_CONTEXT_DOMAIN, event.resourceId);
  return current?.version !== undefined && event.version <= current.version;
}

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

async function fetchProjectContextDetail(
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

function applyRemoteDomainEvent(state: DaemonState, event: RemoteSyncEvent): void {
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
