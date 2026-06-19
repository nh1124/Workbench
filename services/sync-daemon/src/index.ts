import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { config as loadEnv } from "dotenv";
import { normalizeCoreUrl } from "./coreUrl.js";
import {
  parseSecureIdentityMode,
  readIdentity,
  writeIdentity,
  type ClientIdentity,
  type SecureIdentityMode
} from "./identityStorage.js";

export { readIdentity } from "./identityStorage.js";
export type { ClientIdentity, SecureIdentityMode } from "./identityStorage.js";

import {
  enqueueOutbox as enqueueManifestOutbox,
  getMeta,
  getRemoteResource,
  getResource,
  hasOpenOutboxForPath,
  listRemoteResources,
  listConflicts,
  listOpenOutboxForResource,
  listOpenOutboxForPath,
  listOpenOutboxUnderPath,
  listPendingOutbox,
  listResources,
  markOutboxApplied,
  markOutboxFailed,
  markOutboxSuperseded,
  migrateLegacyManifestJson,
  openManifestStore,
  readManifestStats,
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
  type ConflictResolution,
  type ConflictStatus,
  type ManifestResource,
  type ManifestStore,
  type OutboxItem,
  type RemoteResource,
  type RemoteResourceDomain,
  type SyncErrorCategory,
  type SyncErrorMetadata
} from "./manifestStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: resolve(__dirname, "../.env") });

export type LocalJob = {
  id: string;
  kind: "download_artifact" | "download_task_attachment" | "materialize_resource";
  target: "downloads" | "sync-folder";
  payload: Record<string, unknown>;
  status: string;
};

export type LocalJobConfirmationPolicy = "off" | "downloads" | "all";

type PendingLocalJobConfirmation = {
  job: LocalJob;
  requestedAt: string;
  reason: string;
};

type LocalArtifactItem = {
  id: string;
  projectId: string;
  projectName?: string;
  kind: "folder" | "note" | "file";
  title: string;
  path: string;
  parentPath: string;
  scope: "private";
  tags: string[];
  mimeType?: string;
  sizeBytes?: number;
  version: number;
  contentMarkdown?: string;
  createdAt: string;
  updatedAt: string;
};

export type DaemonConfig = {
  coreUrl: string;
  accessToken?: string;
  apiToken?: string;
  syncRoot: string;
  downloadsDir: string;
  deviceId: string;
  clientName: string;
  syncRootId: string;
  syncRootLabel: string;
  intervalMs: number;
  httpPort: number;
  apiAllowedOrigins?: string[];
  maxSyncFileBytes: number;
  watchEnabled: boolean;
  watchDebounceMs: number;
  persistClientIdentity?: boolean;
  secureClientIdentity?: SecureIdentityMode;
  localJobConfirmationPolicy?: LocalJobConfirmationPolicy;
};

export type DaemonState = {
  config: DaemonConfig;
  manifestStore: ManifestStore;
  identity?: ClientIdentity;
  lastHeartbeatAt?: string;
  lastClaimAt?: string;
  lastScanAt?: string;
  lastPushAt?: string;
  lastRemotePullAt?: string;
  remoteArtifactCursor?: string;
  lastError?: string;
  lastErrorCode?: string;
  lastErrorCategory?: SyncErrorCategory;
  lastErrorRetryable?: boolean;
  processedJobs: number;
  outboxPending: number;
  outboxFailed: number;
  conflictsOpen: number;
  watcherActive: boolean;
  tickRunning: boolean;
  tickQueued: boolean;
  tickTimer?: ReturnType<typeof setTimeout>;
  watcher?: FSWatcher;
  pendingJobConfirmations?: Map<string, PendingLocalJobConfirmation>;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

export function parseLocalJobConfirmationPolicy(value: string | undefined): LocalJobConfirmationPolicy {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return "off";
  }
  if (normalized === "downloads" || normalized === "download" || normalized === "outside-sync-folder") {
    return "downloads";
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "all") {
    return "all";
  }
  return "off";
}

function readConfig(): DaemonConfig {
  const syncRoot = resolve(env("WORKBENCH_SYNC_ROOT") ?? join(homedir(), "WorkbenchSync"));
  const downloadsDir = resolve(env("WORKBENCH_DOWNLOADS_DIR") ?? join(homedir(), "Downloads"));
  const intervalRaw = Number(env("WORKBENCH_DAEMON_INTERVAL_MS") ?? "5000");
  const httpPortRaw = Number(env("WORKBENCH_DAEMON_HTTP_PORT") ?? "35780");
  const maxSyncFileBytesRaw = Number(env("WORKBENCH_MAX_SYNC_FILE_BYTES") ?? String(10 * 1024 * 1024));
  const watchDebounceRaw = Number(env("WORKBENCH_SYNC_WATCH_DEBOUNCE_MS") ?? "800");
  const watchEnabledRaw = env("WORKBENCH_SYNC_WATCH")?.toLowerCase();
  const persistIdentityRaw = env("WORKBENCH_PERSIST_CLIENT_IDENTITY") ?? env("WORKBENCH_LOCAL_CLIENT_IDENTITY_FILE");
  const secureIdentityRaw = env("WORKBENCH_SECURE_CLIENT_IDENTITY") ?? env("WORKBENCH_LOCAL_CLIENT_SECURE_STORAGE");
  const localJobConfirmationRaw = env("WORKBENCH_LOCAL_JOB_CONFIRMATION") ?? env("WORKBENCH_LOCAL_JOB_CONFIRMATION_POLICY");
  return {
    coreUrl: normalizeCoreUrl(env("WORKBENCH_CORE_URL") ?? "http://localhost:3000"),
    accessToken: env("WORKBENCH_ACCESS_TOKEN"),
    apiToken: env("WORKBENCH_DAEMON_API_TOKEN") ?? env("WORKBENCH_LOCAL_DAEMON_TOKEN"),
    syncRoot,
    downloadsDir,
    deviceId: env("WORKBENCH_DEVICE_ID") ?? `${hostname()}-${randomUUID()}`,
    clientName: env("WORKBENCH_CLIENT_NAME") ?? `${hostname()} Workbench daemon`,
    syncRootId: env("WORKBENCH_SYNC_ROOT_ID") ?? "default",
    syncRootLabel: env("WORKBENCH_SYNC_ROOT_LABEL") ?? "Workbench Sync",
    intervalMs: Number.isFinite(intervalRaw) ? Math.max(1000, intervalRaw) : 5000,
    httpPort: Number.isFinite(httpPortRaw) ? Math.max(0, httpPortRaw) : 35780,
    apiAllowedOrigins: parseLoopbackAllowedOrigins(
      env("WORKBENCH_DAEMON_ALLOWED_ORIGINS") ?? env("WORKBENCH_LOCAL_DAEMON_ALLOWED_ORIGINS")
    ),
    maxSyncFileBytes: Number.isFinite(maxSyncFileBytesRaw) ? Math.max(1024, maxSyncFileBytesRaw) : 10 * 1024 * 1024,
    watchEnabled: watchEnabledRaw !== "0" && watchEnabledRaw !== "false" && watchEnabledRaw !== "off",
    watchDebounceMs: Number.isFinite(watchDebounceRaw) ? Math.max(100, watchDebounceRaw) : 800,
    persistClientIdentity: envBoolean(persistIdentityRaw, true),
    secureClientIdentity: parseSecureIdentityMode(secureIdentityRaw),
    localJobConfirmationPolicy: parseLocalJobConfirmationPolicy(localJobConfirmationRaw)
  };
}

async function ensureDirs(config: DaemonConfig): Promise<void> {
  await fs.mkdir(config.syncRoot, { recursive: true });
  await fs.mkdir(config.downloadsDir, { recursive: true });
  await fs.mkdir(join(config.syncRoot, ".workbench"), { recursive: true });
  await fs.mkdir(join(config.syncRoot, ".workbench", "conflicts"), { recursive: true });
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
    throw new Error(text || `HTTP ${response.status}`);
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

async function refreshManifestStats(state: DaemonState): Promise<void> {
  const stats = readManifestStats(state.manifestStore);
  state.outboxPending = stats.outboxPending;
  state.outboxFailed = stats.outboxFailed;
  state.conflictsOpen = stats.conflictsOpen;
  state.lastScanAt = stats.lastScanAt ?? state.lastScanAt;
  state.lastPushAt = stats.lastPushAt ?? state.lastPushAt;
  state.lastRemotePullAt = getMeta(state.manifestStore, "lastRemotePullAt") ?? state.lastRemotePullAt;
  state.remoteArtifactCursor = getMeta(state.manifestStore, "remoteArtifactCursor") ?? state.remoteArtifactCursor;
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

function isReservedWindowsName(value: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value);
}

export function sanitizeFileName(raw: string): string {
  const fallback = "download.bin";
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || isReservedWindowsName(cleaned)) return fallback;
  return cleaned.slice(0, 180);
}

function sanitizePathSegment(raw: string, fallback = "untitled"): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || isReservedWindowsName(cleaned)) return fallback;
  return cleaned.slice(0, 180);
}

function parseContentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const quoted = value.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  const plain = value.match(/filename\s*=\s*([^;]+)/i);
  return plain?.[1]?.trim();
}

async function uniquePath(directory: string, filename: string): Promise<string> {
  const parsed = filename.match(/^(.*?)(\.[^.]+)?$/);
  const base = parsed?.[1] || "download";
  const ext = parsed?.[2] || "";
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(directory, index === 0 ? `${base}${ext}` : `${base} (${index})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return join(directory, `${base}-${Date.now()}${ext}`);
}

export function normalizeSha256Checksum(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error("Invalid download checksum header");
  }
  return hex;
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

export function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

function pathHasUnsafeRootOrTraversal(pathValue: string): boolean {
  const normalized = normalizeRelativePath(pathValue);
  const trimmed = normalized.trim();
  if (!trimmed) return false;
  if (isAbsolute(pathValue) || isAbsolute(normalized) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("//")) {
    return true;
  }
  return normalized.split("/").some((segment) => segment === "..");
}

function pathContainsReservedSegment(pathValue: string): boolean {
  return normalizeRelativePath(pathValue).split("/").some((segment) => isReservedWindowsName(segment));
}

function isPathInsideDirectory(directory: string, candidate: string): boolean {
  const relativePath = normalizeRelativePath(relative(resolve(directory), resolve(candidate)));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../"));
}

function relativeSyncPath(config: DaemonConfig, absolutePath: string): string | undefined {
  if (!isPathInsideDirectory(config.syncRoot, absolutePath)) {
    return undefined;
  }
  const rel = relative(config.syncRoot, absolutePath);
  if (!rel || resolve(config.syncRoot, rel) === resolve(config.syncRoot, ".workbench")) {
    return undefined;
  }
  return normalizeRelativePath(rel);
}

function isIgnoredSyncRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\/+/, "");
  const fileName = basename(normalized).toLowerCase();
  if (!normalized || normalized === ".workbench" || normalized.startsWith(".workbench/")) return true;
  if (pathContainsReservedSegment(normalized)) return true;
  if (fileName === "thumbs.db" || fileName === ".ds_store") return true;
  if (fileName.startsWith("~$") || fileName.startsWith(".~")) return true;
  if (fileName.endsWith("~") || fileName.endsWith(".tmp") || fileName.endsWith(".temp")) return true;
  if (fileName.endsWith(".swp") || fileName.endsWith(".swo") || fileName.endsWith(".part")) return true;
  if (fileName.endsWith(".crdownload") || fileName.endsWith(".download")) return true;
  return false;
}

function isIgnoredSyncPath(config: DaemonConfig, absolutePath: string): boolean {
  const relativePath = relativeSyncPath(config, absolutePath);
  return !relativePath || isIgnoredSyncRelativePath(relativePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForStableFile(absolutePath: string): Promise<{
  size: number;
  mtime: Date;
  mtimeMs: number;
} | undefined> {
  let previous: { size: number; mtimeMs: number; mtime: Date } | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return {
        size: stat.size,
        mtime: stat.mtime,
        mtimeMs: stat.mtimeMs
      };
    }
    previous = { size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
    await sleep(180);
  }
  return previous;
}

async function walkSyncFiles(config: DaemonConfig, current = config.syncRoot, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".workbench") continue;
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkSyncFiles(config, absolutePath, files);
    } else if (entry.isFile() && !isIgnoredSyncPath(config, absolutePath)) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function walkSyncDirectories(
  config: DaemonConfig,
  current = config.syncRoot,
  directories: string[] = []
): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".workbench") continue;
    if (!entry.isDirectory()) continue;
    const absolutePath = join(current, entry.name);
    const relativePath = relativeSyncPath(config, absolutePath);
    if (!relativePath || isIgnoredSyncRelativePath(relativePath)) continue;
    directories.push(relativePath);
    await walkSyncDirectories(config, absolutePath, directories);
  }
  return directories;
}

async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function mimeTypeForPath(pathValue: string): string {
  const ext = extname(pathValue).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".html") return "text/html";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function artifactKindForPath(pathValue: string): "note" | "file" {
  const ext = extname(pathValue).toLowerCase();
  return ext === ".md" || ext === ".markdown" ? "note" : "file";
}

function artifactKindForOutboxItem(item: OutboxItem): "folder" | "note" | "file" {
  return item.payload.kind === "folder" ? "folder" : artifactKindForPath(item.relativePath);
}

function directoryPathFor(relativePath: string): string | undefined {
  const directory = normalizeRelativePath(dirname(relativePath));
  return directory === "." ? undefined : directory;
}

function titleFor(relativePath: string): string {
  const name = basename(relativePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function defaultNotePath(title: string): string {
  const base = sanitizePathSegment(title, "untitled");
  return /\.[a-z0-9]{1,12}$/i.test(base) ? base : `${base}.md`;
}

function normalizeArtifactRelativePath(raw: string, fallbackLeaf = "untitled.md"): string {
  if (pathHasUnsafeRootOrTraversal(raw)) return "";
  const normalized = normalizeRelativePath(raw).replace(/^\/+/, "");
  const segments = normalized
    .split("/")
    .map((segment, index, values) => sanitizePathSegment(segment, index === values.length - 1 ? fallbackLeaf : "folder"))
    .filter((segment) => segment.length > 0);
  return normalizeRelativePath(segments.join("/"));
}

function normalizeArtifactFolderPath(raw: string): string {
  if (pathHasUnsafeRootOrTraversal(raw)) return "";
  const normalized = normalizeRelativePath(raw).replace(/^\/+|\/+$/g, "");
  const segments = normalized
    .split("/")
    .map((segment) => sanitizePathSegment(segment, "folder"))
    .filter((segment) => segment.length > 0);
  return normalizeRelativePath(segments.join("/"));
}

async function uniqueRelativePath(
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

function localProjectId(state: DaemonState): string {
  return `local:${state.config.syncRootId}`;
}

function localProjectName(state: DaemonState): string {
  return state.config.syncRootLabel;
}

function localItemId(kind: "folder" | "note" | "file", relativePath: string): string {
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

export function resolveSyncRootRelativePath(config: DaemonConfig, relativePath: string): string | undefined {
  if (pathHasUnsafeRootOrTraversal(relativePath)) return undefined;
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || isIgnoredSyncRelativePath(normalized)) return undefined;
  const absolutePath = resolve(config.syncRoot, normalized);
  const relativeToRoot = normalizeRelativePath(relative(config.syncRoot, absolutePath));
  if (
    !relativeToRoot
    || relativeToRoot === ".."
    || relativeToRoot.startsWith("../")
    || resolve(config.syncRoot, relativeToRoot) === resolve(config.syncRoot, ".workbench")
  ) {
    return undefined;
  }
  return absolutePath;
}

function itemUpdatedAt(resource: ManifestResource): string {
  return resource.localUpdatedAt ?? resource.lastSeenAt ?? resource.lastSyncedAt ?? new Date(0).toISOString();
}

function buildLocalFolderItem(state: DaemonState, folderPath: string, updatedAt: string): LocalArtifactItem {
  return {
    id: localItemId("folder", folderPath),
    projectId: localProjectId(state),
    projectName: localProjectName(state),
    kind: "folder",
    title: basename(folderPath),
    path: folderPath,
    parentPath: directoryPathFor(folderPath) ?? "",
    scope: "private",
    tags: [],
    version: 1,
    createdAt: updatedAt,
    updatedAt
  };
}

async function buildLocalArtifactItem(
  state: DaemonState,
  resource: ManifestResource,
  options: { includeContent?: boolean } = {}
): Promise<LocalArtifactItem> {
  const updatedAt = itemUpdatedAt(resource);
  const item: LocalArtifactItem = {
    id: resource.resourceId ?? localItemId(resource.kind, resource.relativePath),
    projectId: localProjectId(state),
    projectName: localProjectName(state),
    kind: resource.kind,
    title: titleFor(resource.relativePath),
    path: resource.relativePath,
    parentPath: directoryPathFor(resource.relativePath) ?? "",
    scope: "private",
    tags: [],
    mimeType: resource.kind === "folder" ? undefined : resource.kind === "note" ? "text/markdown" : mimeTypeForPath(resource.relativePath),
    sizeBytes: resource.sizeBytes,
    version: 1,
    createdAt: updatedAt,
    updatedAt
  };

  if (resource.kind === "note" && options.includeContent) {
    const absolutePath = resolveSyncRootRelativePath(state.config, resource.relativePath);
    if (absolutePath) {
      try {
        item.contentMarkdown = await fs.readFile(absolutePath, "utf8");
      } catch {
        item.contentMarkdown = "";
      }
    }
  }

  return item;
}

export async function listLocalArtifactItems(
  state: DaemonState,
  options: { includeContent?: boolean; projectId?: string } = {}
): Promise<LocalArtifactItem[]> {
  if (options.projectId && options.projectId !== localProjectId(state)) {
    return [];
  }

  const resources = listResources(state.manifestStore)
    .filter((resource) => resource.domain === "artifacts" && !isIgnoredSyncRelativePath(resource.relativePath));
  const trackedFolderPaths = new Set(
    resources.filter((resource) => resource.kind === "folder").map((resource) => resource.relativePath)
  );
  const folderUpdatedAt = new Map<string, string>();

  for (const resource of resources) {
    const updatedAt = itemUpdatedAt(resource);
    let folderPath = directoryPathFor(resource.relativePath);
    while (folderPath) {
      const current = folderUpdatedAt.get(folderPath);
      if (!current || current < updatedAt) {
        folderUpdatedAt.set(folderPath, updatedAt);
      }
      folderPath = directoryPathFor(folderPath);
    }
  }

  for (const folderPath of await walkSyncDirectories(state.config)) {
    if (trackedFolderPaths.has(folderPath)) continue;
    const absolutePath = resolveSyncRootRelativePath(state.config, folderPath);
    if (!absolutePath) continue;
    let updatedAt = new Date().toISOString();
    try {
      updatedAt = (await fs.stat(absolutePath)).mtime.toISOString();
    } catch {
      // Best-effort metadata for folders discovered from the sync root.
    }
    const current = folderUpdatedAt.get(folderPath);
    if (!current || current < updatedAt) {
      folderUpdatedAt.set(folderPath, updatedAt);
    }
  }

  const folders = [...folderUpdatedAt.entries()].map(([folderPath, updatedAt]) => buildLocalFolderItem(state, folderPath, updatedAt));
  const items = await Promise.all(resources.map((resource) => buildLocalArtifactItem(state, resource, options)));
  return [...folders, ...items].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

export async function getLocalArtifactItemById(
  state: DaemonState,
  id: string,
  options: { includeContent?: boolean } = {}
): Promise<LocalArtifactItem | undefined> {
  const local = decodeLocalItemId(id);
  if (local?.kind === "folder") {
    const items = await listLocalArtifactItems(state);
    return items.find((item) => item.id === id && item.kind === "folder");
  }

  const resources = listResources(state.manifestStore);
  const resource = resources.find((item) => item.resourceId === id)
    ?? (local ? resources.find((item) => item.kind === local.kind && item.relativePath === local.relativePath) : undefined);
  return resource ? buildLocalArtifactItem(state, resource, options) : undefined;
}

function listLocalRemoteDomainItems(
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

function localRemoteDomainItem(
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

function localDefaultProjectSelection(state: DaemonState): Record<string, unknown> | undefined {
  const projects = listLocalRemoteDomainItems(state, "projects");
  const project = projects.find((item) => item.isUserDefault === true)
    ?? projects.find((item) => item.isFallbackDefault === true);
  if (!project) return undefined;
  return {
    project,
    source: project.isUserDefault === true ? "user" : "fallback"
  };
}

const LOCAL_PROJECT_ID_PREFIX = "local-project-";
const LOCAL_PROJECT_STATUSES = new Set(["draft", "active", "archived"]);

function isLocalProjectId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_PROJECT_ID_PREFIX);
}

function projectOutboxPath(id: string): string {
  return `projects/${id}`;
}

function projectDefaultOutboxPath(): string {
  return "projects/default";
}

function normalizeProjectStatus(value: unknown, fallback?: unknown): "draft" | "active" | "archived" {
  if (typeof value === "string" && LOCAL_PROJECT_STATUSES.has(value)) {
    return value as "draft" | "active" | "archived";
  }
  if (typeof fallback === "string" && LOCAL_PROJECT_STATUSES.has(fallback)) {
    return fallback as "draft" | "active" | "archived";
  }
  return "active";
}

function normalizeLocalProjectPayload(
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : typeof existing?.name === "string" && existing.name.trim()
      ? existing.name
      : "Untitled Project";
  const description = typeof input.description === "string"
    ? input.description
    : typeof existing?.description === "string"
      ? existing.description
      : "";
  return {
    ...(existing ?? {}),
    name,
    description,
    status: normalizeProjectStatus(input.status, existing?.status),
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
}

function localProjectDefaultSelection(project: Record<string, unknown>): Record<string, unknown> {
  return {
    project,
    source: project.isFallbackDefault === true && project.isUserDefault !== true ? "fallback" : "user"
  };
}

function updateLocalProjectDefaultCache(state: DaemonState, projectId: string, updatedAt: string): Record<string, unknown> | undefined {
  let selected: Record<string, unknown> | undefined;
  for (const resource of listRemoteResources(state.manifestStore, { domain: "projects", includeDeleted: false, limit: 1000 })) {
    const id = asString(resource.payload.id) ?? resource.resourceId;
    const payload = {
      ...resource.payload,
      id,
      isUserDefault: id === projectId,
      updatedAt: asString(resource.payload.updatedAt) ?? resource.updatedAt ?? updatedAt
    };
    upsertRemoteResource(state.manifestStore, {
      domain: "projects",
      resourceId: resource.resourceId,
      version: resource.version,
      payload,
      updatedAt: asString(payload.updatedAt) ?? updatedAt,
      lastSyncedAt: resource.lastSyncedAt
    });
    if (id === projectId) {
      selected = payload;
    }
  }
  return selected;
}

function supersedeOpenProjectDefaultForResource(state: DaemonState, resourceId: string, reason: string, updatedAt: string): void {
  for (const item of listOpenOutboxForResource(state.manifestStore, resourceId)) {
    if (item.domain !== "projects" || asString(item.payload.relation) !== "default") continue;
    markOutboxSuperseded(state.manifestStore, item.id, reason, updatedAt);
  }
}

function retargetOpenProjectOutboxReferences(state: DaemonState, oldResourceId: string, newResourceId: string, updatedAt: string): void {
  for (const item of listOpenOutboxForResource(state.manifestStore, oldResourceId)) {
    if (item.domain !== "projects") continue;
    markOutboxSuperseded(
      state.manifestStore,
      item.id,
      "Local project received a cloud id; pending project operation was retargeted.",
      updatedAt
    );
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: item.relativePath,
      domain: item.domain,
      action: item.action,
      resourceId: newResourceId,
      payload: {
        ...item.payload,
        id: asString(item.payload.id) === oldResourceId ? newResourceId : item.payload.id,
        projectId: asString(item.payload.projectId) === oldResourceId ? newResourceId : item.payload.projectId
      }
    });
  }
}

function projectDefaultRelationPayload(item: OutboxItem): { relation: "default"; projectId: string } | undefined {
  if (item.domain !== "projects" || asString(item.payload.relation) !== "default") return undefined;
  const projectId = asString(item.payload.projectId) ?? item.resourceId ?? asString(item.payload.id);
  return projectId ? { relation: "default", projectId } : undefined;
}

function shouldDeferProjectOutboxItem(state: DaemonState, item: OutboxItem): boolean {
  const defaultPayload = projectDefaultRelationPayload(item);
  if (!defaultPayload || !isLocalProjectId(defaultPayload.projectId)) return false;
  return listOpenOutboxForResource(state.manifestStore, defaultPayload.projectId).some(
    (candidate) => candidate.domain === "projects"
      && candidate.action === "create"
      && asString(candidate.payload.relation) !== "default"
  );
}

function applyProjectDefaultPushResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const defaultPayload = projectDefaultRelationPayload(item);
  if (!defaultPayload) return false;
  const result = resultRecord(appliedItem.result);
  const resultProject = resultRecord(result?.project);
  const projectId = appliedItem.resourceId ?? asString(resultProject?.id) ?? defaultPayload.projectId;
  if (resultProject) {
    upsertRemoteResource(state.manifestStore, {
      domain: "projects",
      resourceId: projectId,
      version: appliedItem.version,
      payload: {
        ...resultProject,
        id: projectId,
        isUserDefault: true
      },
      updatedAt: remoteResourceUpdatedAt(resultProject, now),
      lastSyncedAt: now
    });
  }
  updateLocalProjectDefaultCache(state, projectId, now);
  return true;
}

export async function createLocalProject(state: DaemonState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${LOCAL_PROJECT_ID_PREFIX}${randomUUID()}`;
  const payload: Record<string, unknown> = {
    ...normalizeLocalProjectPayload(input),
    id
  };
  const now = new Date().toISOString();
  const outboxPath = projectOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local project was recreated through daemon facade; stale project operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "projects",
    action: "create",
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "projects",
    resourceId: id,
    payload,
    updatedAt: asString(payload.updatedAt) ?? now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function updateLocalProject(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "projects", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...normalizeLocalProjectPayload(input, existing),
    id
  };
  const outboxPath = projectOutboxPath(id);
  const action = isLocalProjectId(id) ? "create" : "update";
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local project was updated through daemon facade; stale project operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "projects",
    action,
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "projects",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: asString(payload.updatedAt) ?? now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function deleteLocalProject(state: DaemonState, id: string): Promise<boolean> {
  const existing = localRemoteDomainItem(state, "projects", id);
  if (!existing) return false;
  const now = new Date().toISOString();
  const outboxPath = projectOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local project was deleted through daemon facade; stale project operation was superseded.",
    now
  );
  supersedeOpenProjectDefaultForResource(
    state,
    id,
    "Local project was deleted before its default selection synced; stale default operation was superseded.",
    now
  );

  if (isLocalProjectId(id)) {
    removeRemoteResource(state.manifestStore, "projects", id);
  } else {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: outboxPath,
      domain: "projects",
      action: "delete",
      resourceId: id,
      payload: existing
    });
    markRemoteResourceDeleted(state.manifestStore, {
      domain: "projects",
      resourceId: id,
      version: asNumber(existing.version),
      payload: existing,
      deletedAt: now,
      lastSyncedAt: asString(existing.lastSyncedAt)
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function setLocalDefaultProject(state: DaemonState, projectId: string): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "projects", projectId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const selected = updateLocalProjectDefaultCache(state, projectId, now) ?? {
    ...existing,
    isUserDefault: true
  };
  supersedeOpenOutboxForPath(
    state,
    projectDefaultOutboxPath(),
    () => true,
    "Local project default was changed through daemon facade; stale default operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectDefaultOutboxPath(),
    domain: "projects",
    action: "update",
    resourceId: projectId,
    payload: {
      relation: "default",
      projectId
    }
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return localProjectDefaultSelection(selected);
}

const LOCAL_NOTE_ID_PREFIX = "local-note-";

function isLocalNoteId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_NOTE_ID_PREFIX);
}

function noteOutboxPath(id: string): string {
  return `notes/${id}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeLocalNotePayload(
  state: DaemonState,
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : typeof existing?.title === "string" && existing.title.trim()
      ? existing.title
      : "Untitled";
  const content = typeof input.content === "string"
    ? input.content
    : typeof existing?.content === "string"
      ? existing.content
      : "";
  const projectId = typeof input.projectId === "string" && input.projectId.trim()
    ? input.projectId.trim()
    : typeof existing?.projectId === "string" && existing.projectId.trim()
      ? existing.projectId
      : localProjectId(state);
  const projectName = typeof input.projectName === "string"
    ? input.projectName
    : typeof existing?.projectName === "string"
      ? existing.projectName
      : localProjectName(state);
  return {
    ...(existing ?? {}),
    title,
    content,
    projectId,
    projectName,
    tags: Array.isArray(input.tags) ? normalizeStringArray(input.tags) : normalizeStringArray(existing?.tags),
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
}

function localNoteProjectSummaries(state: DaemonState): Record<string, unknown>[] {
  const byProject = new Map<string, { projectId: string; projectName?: string; noteCount: number; latestUpdatedAt: string }>();
  for (const note of listLocalRemoteDomainItems(state, "notes")) {
    const projectId = typeof note.projectId === "string" && note.projectId.trim() ? note.projectId : localProjectId(state);
    const projectName = typeof note.projectName === "string" ? note.projectName : undefined;
    const updatedAt = typeof note.updatedAt === "string" ? note.updatedAt : new Date().toISOString();
    const existing = byProject.get(projectId);
    if (!existing) {
      byProject.set(projectId, { projectId, projectName, noteCount: 1, latestUpdatedAt: updatedAt });
    } else {
      existing.noteCount += 1;
      if (!existing.projectName && projectName) existing.projectName = projectName;
      if (existing.latestUpdatedAt < updatedAt) existing.latestUpdatedAt = updatedAt;
    }
  }
  return [...byProject.values()].sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

export async function createLocalNote(state: DaemonState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${LOCAL_NOTE_ID_PREFIX}${randomUUID()}`;
  const payload: Record<string, unknown> = {
    ...normalizeLocalNotePayload(state, input),
    id
  };
  const now = new Date().toISOString();
  const outboxPath = noteOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local note was recreated through daemon facade; stale note operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "notes",
    action: "create",
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "notes",
    resourceId: id,
    payload,
    updatedAt: asString(payload.updatedAt) ?? now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function updateLocalNote(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "notes", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...normalizeLocalNotePayload(state, input, existing),
    id
  };
  const outboxPath = noteOutboxPath(id);
  const action = isLocalNoteId(id) ? "create" : "update";
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local note was updated through daemon facade; stale note operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "notes",
    action,
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "notes",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: asString(payload.updatedAt) ?? now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function deleteLocalNote(state: DaemonState, id: string): Promise<boolean> {
  const existing = localRemoteDomainItem(state, "notes", id);
  if (!existing) return false;
  const now = new Date().toISOString();
  const outboxPath = noteOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local note was deleted through daemon facade; stale note operation was superseded.",
    now
  );

  if (isLocalNoteId(id)) {
    removeRemoteResource(state.manifestStore, "notes", id);
  } else {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: outboxPath,
      domain: "notes",
      action: "delete",
      resourceId: id,
      payload: existing
    });
    markRemoteResourceDeleted(state.manifestStore, {
      domain: "notes",
      resourceId: id,
      version: asNumber(existing.version),
      payload: existing,
      deletedAt: now,
      lastSyncedAt: asString(existing.lastSyncedAt)
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

const LOCAL_TASK_ID_PREFIX = "local-task-";
const LOCAL_TASK_STATUSES = new Set(["todo", "done", "skipped"]);
const LOCAL_TASK_PRIORITIES = new Set(["low", "medium", "high"]);
const LOCAL_TASK_RECURRENCES = new Set(["ONCE", "WEEKLY", "EVERY_N_DAYS", "MONTHLY_DAY", "MONTHLY_NTH_WEEKDAY"]);

function isLocalTaskId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_TASK_ID_PREFIX);
}

function taskOutboxPath(id: string): string {
  return `tasks/${id}`;
}

function taskRelationOutboxPath(id: string, relation: string): string {
  return `tasks/${id}/${relation}`;
}

function normalizeTaskStatus(value: unknown, fallback?: unknown): "todo" | "done" | "skipped" {
  if (typeof value === "string" && LOCAL_TASK_STATUSES.has(value)) return value as "todo" | "done" | "skipped";
  if (typeof fallback === "string" && LOCAL_TASK_STATUSES.has(fallback)) return fallback as "todo" | "done" | "skipped";
  return "todo";
}

function normalizeTaskPriority(value: unknown, fallback?: unknown): "low" | "medium" | "high" | undefined {
  if (typeof value === "string" && LOCAL_TASK_PRIORITIES.has(value)) return value as "low" | "medium" | "high";
  if (typeof fallback === "string" && LOCAL_TASK_PRIORITIES.has(fallback)) return fallback as "low" | "medium" | "high";
  return undefined;
}

function normalizeTaskRecurrence(value: unknown, fallback?: unknown): string {
  if (typeof value === "string" && LOCAL_TASK_RECURRENCES.has(value)) return value;
  if (typeof fallback === "string" && LOCAL_TASK_RECURRENCES.has(fallback)) return fallback;
  return "ONCE";
}

function finiteNumber(value: unknown, fallback?: unknown, defaultValue?: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return defaultValue;
}

function finiteInteger(value: unknown, fallback?: unknown): number | undefined {
  const number = finiteNumber(value, fallback);
  return number === undefined ? undefined : Math.trunc(number);
}

function normalizeTaskBoolean(value: unknown, fallback: unknown, defaultValue?: boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof fallback === "boolean") return fallback;
  return defaultValue;
}

function copyOptionalTaskString(payload: Record<string, unknown>, key: string, input: Record<string, unknown>, existing?: Record<string, unknown>): void {
  if (typeof input[key] === "string") {
    payload[key] = input[key];
  } else if (typeof existing?.[key] === "string") {
    payload[key] = existing[key];
  }
}

function copyOptionalTaskBoolean(payload: Record<string, unknown>, key: string, input: Record<string, unknown>, existing?: Record<string, unknown>): void {
  const value = normalizeTaskBoolean(input[key], existing?.[key]);
  if (value !== undefined) payload[key] = value;
}

function copyOptionalTaskInteger(payload: Record<string, unknown>, key: string, input: Record<string, unknown>, existing?: Record<string, unknown>): void {
  const value = finiteInteger(input[key], existing?.[key]);
  if (value !== undefined) payload[key] = value;
}

function normalizeLocalTaskPayload(
  state: DaemonState,
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : typeof existing?.title === "string" && existing.title.trim()
      ? existing.title
      : "Untitled Task";
  const context = typeof input.context === "string" && input.context.trim()
    ? input.context.trim()
    : typeof existing?.context === "string" && existing.context.trim()
      ? existing.context
      : typeof existing?.projectId === "string" && existing.projectId.trim()
        ? existing.projectId
        : localProjectId(state);
  const contextName = typeof input.contextName === "string"
    ? input.contextName
    : typeof existing?.contextName === "string"
      ? existing.contextName
      : localProjectName(state);
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    title,
    notes: typeof input.notes === "string" ? input.notes : typeof existing?.notes === "string" ? existing.notes : "",
    context,
    contextName,
    status: normalizeTaskStatus(input.status, existing?.status),
    isLocked: normalizeTaskBoolean(input.isLocked, existing?.isLocked, false) ?? false,
    baseLoadScore: finiteNumber(input.baseLoadScore, existing?.baseLoadScore, 5) ?? 5,
    recurrence: normalizeTaskRecurrence(input.recurrence, existing?.recurrence),
    active: normalizeTaskBoolean(input.active, existing?.active, true) ?? true,
    isPinned: normalizeTaskBoolean(input.isPinned, existing?.isPinned, false) ?? false,
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
  const priority = normalizeTaskPriority(input.priority, existing?.priority);
  if (priority) payload.priority = priority;
  for (const key of ["dueDate", "startTime", "endTime", "timezone", "activeFrom", "activeUntil", "anchorDate"]) {
    copyOptionalTaskString(payload, key, input, existing);
  }
  for (const key of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    copyOptionalTaskBoolean(payload, key, input, existing);
  }
  for (const key of ["intervalDays", "monthDay", "nthInMonth", "weekdayMon1"]) {
    copyOptionalTaskInteger(payload, key, input, existing);
  }
  return payload;
}

function localTaskProjectSummaries(state: DaemonState): Record<string, unknown>[] {
  const byProject = new Map<string, { projectId: string; projectName?: string; taskCount: number; latestUpdatedAt: string }>();
  for (const task of listLocalRemoteDomainItems(state, "tasks")) {
    const projectId = typeof task.context === "string" && task.context.trim()
      ? task.context
      : typeof task.projectId === "string" && task.projectId.trim()
        ? task.projectId
        : localProjectId(state);
    const projectName = typeof task.contextName === "string" ? task.contextName : undefined;
    const updatedAt = typeof task.updatedAt === "string" ? task.updatedAt : new Date().toISOString();
    const existing = byProject.get(projectId);
    if (!existing) {
      byProject.set(projectId, { projectId, projectName, taskCount: 1, latestUpdatedAt: updatedAt });
    } else {
      existing.taskCount += 1;
      if (!existing.projectName && projectName) existing.projectName = projectName;
      if (existing.latestUpdatedAt < updatedAt) existing.latestUpdatedAt = updatedAt;
    }
  }
  return [...byProject.values()].sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

function localTaskPinnedIds(state: DaemonState): string[] {
  return listLocalRemoteDomainItems(state, "tasks")
    .filter((task) => task.isPinned === true)
    .map((task) => asString(task.id))
    .filter((id): id is string => Boolean(id));
}

function taskRelationPayload(item: OutboxItem): { relation: string; taskId: string } | undefined {
  if (item.domain !== "tasks") return undefined;
  const relation = asString(item.payload.relation);
  if (!relation) return undefined;
  const taskId = asString(item.payload.taskId) ?? item.resourceId ?? asString(item.payload.id);
  return taskId ? { relation, taskId } : undefined;
}

function shouldDeferTaskOutboxItem(state: DaemonState, item: OutboxItem): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || !isLocalTaskId(relationPayload.taskId)) return false;
  return listOpenOutboxForResource(state.manifestStore, relationPayload.taskId).some(
    (candidate) => candidate.domain === "tasks"
      && candidate.action === "create"
      && !asString(candidate.payload.relation)
  );
}

function retargetOpenTaskOutboxReferences(state: DaemonState, oldResourceId: string, newResourceId: string, updatedAt: string): void {
  for (const item of listOpenOutboxForResource(state.manifestStore, oldResourceId)) {
    if (item.domain !== "tasks") continue;
    markOutboxSuperseded(
      state.manifestStore,
      item.id,
      "Local task received a cloud id; pending task operation was retargeted.",
      updatedAt
    );
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: item.relativePath.replace(oldResourceId, newResourceId),
      domain: item.domain,
      action: item.action,
      resourceId: newResourceId,
      payload: {
        ...item.payload,
        id: asString(item.payload.id) === oldResourceId ? newResourceId : item.payload.id,
        taskId: asString(item.payload.taskId) === oldResourceId ? newResourceId : item.payload.taskId
      }
    });
  }
}

function applyTaskPinPushResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "pin") return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? asString(result?.taskId) ?? relationPayload.taskId;
  const pinned = typeof result?.pinned === "boolean" ? result.pinned : normalizeTaskBoolean(item.payload.pinned, undefined, false) ?? false;
  const existing = localRemoteDomainItem(state, "tasks", taskId, { includeDeleted: true });
  if (existing) {
    const payload = {
      ...existing,
      id: taskId,
      isPinned: pinned,
      updatedAt: now
    };
    upsertRemoteResource(state.manifestStore, {
      domain: "tasks",
      resourceId: taskId,
      version: appliedItem.version,
      payload,
      updatedAt: now,
      lastSyncedAt: now
    });
  }
  return true;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : [];
}

function nextLocalScheduleId(): number {
  return -Number.parseInt(randomUUID().slice(0, 8), 16);
}

function localSubtaskId(): string {
  return `local-subtask-${randomUUID()}`;
}

function localTaskPayloadForUpdate(state: DaemonState, taskId: string): Record<string, unknown> | undefined {
  return localRemoteDomainItem(state, "tasks", taskId, { includeDeleted: true });
}

function upsertLocalTaskPayload(
  state: DaemonState,
  taskId: string,
  payload: Record<string, unknown>,
  updatedAt: string
): void {
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: taskId,
    version: asNumber(payload.version),
    payload: {
      ...payload,
      id: taskId,
      updatedAt
    },
    updatedAt,
    lastSyncedAt: asString(payload.lastSyncedAt)
  });
}

function taskScheduleItems(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.scheduleItems);
}

function taskSubtasks(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.subtasks);
}

function taskAttachments(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.attachments);
}

function taskOccurrenceActions(task: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return recordArray(task?.occurrenceActions);
}

function scheduleItemOutboxPath(taskId: string, scheduleId: string | number): string {
  return `tasks/${taskId}/schedule-items/${scheduleId}`;
}

function subtaskOutboxPath(taskId: string, occurrenceDate: string, subtaskId: string): string {
  return `tasks/${taskId}/subtasks/${occurrenceDate}/${subtaskId}`;
}

function attachmentOutboxPath(taskId: string, attachmentId: string): string {
  return `tasks/${taskId}/attachments/${attachmentId}`;
}

function occurrenceOutboxPath(taskId: string, operation: string, targetDate: string): string {
  return `tasks/${taskId}/occurrences/${operation}/${targetDate}`;
}

function scheduleItemId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function scheduleItemIdValue(item: Record<string, unknown>): number | undefined {
  return scheduleItemId(item.id) ?? scheduleItemId(item.scheduleId);
}

function normalizeScheduleItemPayload(taskId: string, input: Record<string, unknown>, existing?: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  const scheduledDate = asString(input.scheduledDate) ?? asString(existing?.scheduledDate) ?? new Date().toISOString().slice(0, 10);
  const occurrenceDate = typeof input.occurrenceDate === "string"
    ? input.occurrenceDate
    : typeof existing?.occurrenceDate === "string"
      ? existing.occurrenceDate
      : scheduledDate;
  const payload: Record<string, unknown> = {
    ...(existing ?? {}),
    id: scheduleItemId(input.id) ?? scheduleItemId(input.scheduleId) ?? scheduleItemId(existing?.id) ?? nextLocalScheduleId(),
    taskId,
    occurrenceDate,
    scheduledDate,
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
  for (const key of ["startTime", "endTime", "timezone"]) {
    if (key in input) {
      payload[key] = input[key] ?? undefined;
    } else if (key in (existing ?? {})) {
      payload[key] = existing?.[key];
    }
  }
  return payload;
}

function updateTaskScheduleItems(
  state: DaemonState,
  taskId: string,
  updater: (items: Record<string, unknown>[]) => Record<string, unknown>[],
  updatedAt: string
): Record<string, unknown> | undefined {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const payload = {
    ...task,
    scheduleItems: updater(taskScheduleItems(task))
  };
  upsertLocalTaskPayload(state, taskId, payload, updatedAt);
  return payload;
}

function findLocalScheduleItem(
  state: DaemonState,
  scheduleId: number
): { taskId: string; task: Record<string, unknown>; item: Record<string, unknown> } | undefined {
  for (const task of listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 })) {
    const taskId = asString(task.id);
    if (!taskId) continue;
    const item = taskScheduleItems(task).find((candidate) => scheduleItemIdValue(candidate) === scheduleId);
    if (item) return { taskId, task, item };
  }
  return undefined;
}

function localTodayTasks(state: DaemonState, date: string): Record<string, unknown>[] {
  const tasks: Record<string, unknown>[] = [];
  for (const task of listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 })) {
    for (const item of taskScheduleItems(task)) {
      if (item.scheduledDate !== date) continue;
      tasks.push({
        ...task,
        occurrenceDate: asString(item.occurrenceDate) ?? date,
        scheduledDate: date,
        scheduleId: scheduleItemIdValue(item),
        startTime: item.startTime,
        endTime: item.endTime,
        timezone: item.timezone
      });
    }
  }
  return tasks.sort((a, b) => String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")));
}

function dateRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days: string[] = [];
  for (let current = start; current <= end; current = new Date(current.getTime() + 24 * 60 * 60 * 1000)) {
    days.push(current.toISOString().slice(0, 10));
  }
  return days;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportLocalTasksCsv(state: DaemonState): string {
  const headers = [
    "task_name", "context", "base_load_score", "active", "rule_type",
    "due_date", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
    "interval_days", "anchor_date", "month_day", "nth_in_month", "weekday_mon1",
    "start_date", "end_date", "notes", "timezone"
  ];
  const rows = listLocalRemoteDomainItems(state, "tasks", { includeDeleted: false, limit: 1000 }).map((task) => [
    task.title,
    task.context,
    task.baseLoadScore,
    task.active,
    task.recurrence,
    task.dueDate ?? "",
    task.mon ?? false,
    task.tue ?? false,
    task.wed ?? false,
    task.thu ?? false,
    task.fri ?? false,
    task.sat ?? false,
    task.sun ?? false,
    task.intervalDays ?? "",
    task.anchorDate ?? "",
    task.monthDay ?? "",
    task.nthInMonth ?? "",
    task.weekdayMon1 ?? "",
    task.activeFrom ?? "",
    task.activeUntil ?? "",
    task.notes ?? "",
    task.timezone ?? ""
  ].map(csvEscape).join(","));
  return [headers.join(","), ...rows].join("\n");
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.length > 0) || rows.length === 0) rows.push(row);
  return rows;
}

function csvBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function csvNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csvString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function csvTaskPayload(record: Record<string, string>): Record<string, unknown> | undefined {
  const title = csvString(record.task_name) ?? csvString(record.title);
  const context = csvString(record.context);
  if (!title || !context) return undefined;
  return {
    title,
    context,
    baseLoadScore: csvNumber(record.base_load_score),
    active: csvBoolean(record.active),
    recurrence: csvString(record.rule_type),
    dueDate: csvString(record.due_date),
    mon: csvBoolean(record.mon),
    tue: csvBoolean(record.tue),
    wed: csvBoolean(record.wed),
    thu: csvBoolean(record.thu),
    fri: csvBoolean(record.fri),
    sat: csvBoolean(record.sat),
    sun: csvBoolean(record.sun),
    intervalDays: csvNumber(record.interval_days),
    anchorDate: csvString(record.anchor_date),
    monthDay: csvNumber(record.month_day),
    nthInMonth: csvNumber(record.nth_in_month),
    weekdayMon1: csvNumber(record.weekday_mon1),
    activeFrom: csvString(record.start_date),
    activeUntil: csvString(record.end_date),
    notes: record.notes ?? "",
    timezone: csvString(record.timezone)
  };
}

export async function importLocalTasksCsv(state: DaemonState, csv: string): Promise<number> {
  const rows = parseCsvRows(csv);
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  let imported = 0;
  for (const row of rows) {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    const payload = csvTaskPayload(record);
    if (!payload) continue;
    await createLocalTask(state, payload);
    imported += 1;
  }
  return imported;
}

export function localTaskHistory(state: DaemonState, taskId: string): Record<string, unknown>[] {
  const task = localTaskPayloadForUpdate(state, taskId);
  return taskOccurrenceActions(task).map((action, index) => ({
    id: action.id ?? `local-history-${index}`,
    taskId,
    targetDate: action.targetDate ?? action.sourceDate ?? "",
    status: action.status ?? action.operation ?? "",
    createdAt: action.updatedAt ?? action.syncedAt ?? ""
  }));
}

function localScheduleCalendar(state: DaemonState, startDate: string, endDate: string): Record<string, unknown>[] {
  return dateRange(startDate, endDate).map((date) => ({
    date,
    items: localTodayTasks(state, date).map((task) => ({
      scheduleId: task.scheduleId,
      taskId: task.id,
      title: task.title,
      context: task.context,
      status: task.status,
      occurrenceDate: task.occurrenceDate,
      scheduledDate: task.scheduledDate,
      load: task.baseLoadScore,
      startTime: task.startTime,
      endTime: task.endTime,
      timezone: task.timezone,
      isLocked: task.isLocked
    }))
  }));
}

function localTaskSchedule(state: DaemonState, startDate: string, endDate: string, context?: string, status?: string): Record<string, unknown>[] {
  return dateRange(startDate, endDate).map((date) => {
    const tasks = localTodayTasks(state, date)
      .filter((task) => !context || task.context === context)
      .filter((task) => !status || task.status === status)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        context: task.context,
        status: task.status,
        load: task.baseLoadScore,
        startTime: task.startTime,
        endTime: task.endTime,
        isLocked: task.isLocked
      }));
    return {
      date,
      totalLoad: tasks.reduce((sum, task) => sum + (typeof task.load === "number" ? task.load : 0), 0),
      tasks
    };
  });
}

function enqueueTaskRelationOutbox(
  state: DaemonState,
  input: {
    path: string;
    action: "create" | "update" | "delete";
    taskId: string;
    payload: Record<string, unknown>;
    supersedeReason: string;
    updatedAt: string;
  }
): void {
  supersedeOpenOutboxForPath(state, input.path, () => true, input.supersedeReason, input.updatedAt);
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: input.path,
    domain: "tasks",
    action: input.action,
    resourceId: input.taskId,
    payload: {
      taskId: input.taskId,
      ...input.payload
    }
  });
}

function applyTaskScheduleResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || (relationPayload.relation !== "today" && relationPayload.relation !== "scheduleItem")) return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const localId = scheduleItemId(item.payload.scheduleId) ?? scheduleItemId(item.payload.id);
  const resultId = scheduleItemId(result?.id) ?? scheduleItemId(result?.scheduleId) ?? localId;

  updateTaskScheduleItems(state, taskId, (items) => {
    if (item.action === "delete") {
      return items.filter((candidate) => scheduleItemIdValue(candidate) !== localId && scheduleItemIdValue(candidate) !== resultId);
    }
    const nextItem = normalizeScheduleItemPayload(taskId, {
      ...item.payload,
      ...(result ?? {}),
      id: resultId ?? localId
    });
    const replaced = items.map((candidate) => {
      const candidateId = scheduleItemIdValue(candidate);
      return candidateId === localId || candidateId === resultId ? nextItem : candidate;
    });
    return replaced.some((candidate) => scheduleItemIdValue(candidate) === scheduleItemIdValue(nextItem))
      ? replaced
      : [...replaced, nextItem];
  }, now);
  return true;
}

function applyTaskSubtaskResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "subtask") return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const localId = asString(item.payload.subtaskId) ?? asString(item.payload.id);
  const resultId = asString(result?.id) ?? asString(result?.subtaskId) ?? localId;

  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task) return true;
  const subtasks = taskSubtasks(task);
  const nextSubtasks = item.action === "delete"
    ? subtasks.filter((candidate) => asString(candidate.id) !== localId && asString(candidate.id) !== resultId)
    : (() => {
      const nextSubtask = {
        ...item.payload,
        ...(result ?? {}),
        id: resultId,
        taskId,
        updatedAt: now
      };
      const replaced = subtasks.map((candidate) => {
        const candidateId = asString(candidate.id);
        return candidateId === localId || candidateId === resultId ? nextSubtask : candidate;
      });
      return replaced.some((candidate) => asString(candidate.id) === resultId)
        ? replaced
        : [...replaced, nextSubtask];
    })();
  upsertLocalTaskPayload(state, taskId, { ...task, subtasks: nextSubtasks }, now);
  return true;
}

function applyTaskAttachmentResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "attachment") return false;
  const result = resultRecord(appliedItem.result);
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const localId = asString(item.payload.attachmentId) ?? asString(item.payload.id);
  const resultId = asString(result?.id) ?? asString(result?.attachmentId) ?? localId;
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task) return true;
  const attachments = taskAttachments(task);
  const nextAttachments = item.action === "delete"
    ? attachments.filter((candidate) => asString(candidate.id) !== localId && asString(candidate.id) !== resultId)
    : (() => {
      const nextAttachment = {
        ...item.payload,
        ...(result ?? {}),
        id: resultId,
        taskId,
        updatedAt: now
      };
      const replaced = attachments.map((candidate) => {
        const candidateId = asString(candidate.id);
        return candidateId === localId || candidateId === resultId ? nextAttachment : candidate;
      });
      return replaced.some((candidate) => asString(candidate.id) === resultId)
        ? replaced
        : [...replaced, nextAttachment];
    })();
  upsertLocalTaskPayload(state, taskId, { ...task, attachments: nextAttachments }, now);
  return true;
}

function applyTaskOccurrenceResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const relationPayload = taskRelationPayload(item);
  if (!relationPayload || relationPayload.relation !== "occurrence") return false;
  const taskId = appliedItem.resourceId ?? relationPayload.taskId;
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task) return true;
  const occurrence = {
    ...item.payload,
    ...(resultRecord(appliedItem.result) ?? {}),
    taskId,
    syncedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    ...(item.payload.operation === "complete" && asString(item.payload.status) ? { status: item.payload.status } : {}),
    occurrenceActions: [...taskOccurrenceActions(task), occurrence]
  }, now);
  return true;
}

function applyTaskRelationPushResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  return applyTaskPinPushResult(state, item, appliedItem, now)
    || applyTaskScheduleResult(state, item, appliedItem, now)
    || applyTaskSubtaskResult(state, item, appliedItem, now)
    || applyTaskAttachmentResult(state, item, appliedItem, now)
    || applyTaskOccurrenceResult(state, item, appliedItem, now);
}

function enqueueLocalTaskPinOutbox(state: DaemonState, id: string, pinned: boolean, now: string): void {
  const outboxPath = taskRelationOutboxPath(id, "pin");
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task pin was changed through daemon facade; stale pin operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "tasks",
    action: "update",
    resourceId: id,
    payload: {
      relation: "pin",
      taskId: id,
      pinned
    }
  });
}

export async function addLocalTaskToToday(
  state: DaemonState,
  taskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const now = new Date().toISOString();
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const item = normalizeScheduleItemPayload(taskId, input);
  const scheduleId = scheduleItemIdValue(item);
  if (scheduleId === undefined) return undefined;
  updateTaskScheduleItems(state, taskId, (items) => [...items, item], now);
  enqueueTaskRelationOutbox(state, {
    path: scheduleItemOutboxPath(taskId, scheduleId),
    action: "create",
    taskId,
    payload: {
      relation: "today",
      scheduleId,
      id: scheduleId,
      ...item
    },
    supersedeReason: "Local task schedule item was recreated; stale schedule operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return item;
}

export async function removeLocalTaskFromToday(
  state: DaemonState,
  taskId: string,
  scheduledDate: string
): Promise<Record<string, unknown> | undefined> {
  const now = new Date().toISOString();
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const existing = taskScheduleItems(task).filter((item) => item.scheduledDate === scheduledDate);
  if (existing.length === 0) return { taskId, scheduledDate, removed: 0 };
  updateTaskScheduleItems(state, taskId, (items) => items.filter((item) => item.scheduledDate !== scheduledDate), now);
  for (const item of existing) {
    const scheduleId = scheduleItemIdValue(item);
    if (scheduleId === undefined) continue;
    const path = scheduleItemOutboxPath(taskId, scheduleId);
    supersedeOpenOutboxForPath(
      state,
      path,
      () => true,
      "Local task schedule item was removed; stale schedule operation was superseded.",
      now
    );
    if (scheduleId > 0) {
      enqueueManifestOutbox(state.manifestStore, {
        relativePath: path,
        domain: "tasks",
        action: "delete",
        resourceId: taskId,
        payload: {
          relation: "today",
          taskId,
          scheduleId,
          id: scheduleId,
          scheduledDate
        }
      });
    }
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return { taskId, scheduledDate, removed: existing.length };
}

export async function updateLocalTaskScheduleItem(
  state: DaemonState,
  scheduleId: number,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const found = findLocalScheduleItem(state, scheduleId);
  if (!found) return undefined;
  const now = new Date().toISOString();
  const item = normalizeScheduleItemPayload(found.taskId, { ...found.item, ...input, id: scheduleId }, found.item);
  updateTaskScheduleItems(state, found.taskId, (items) => items.map((candidate) => (
    scheduleItemIdValue(candidate) === scheduleId ? item : candidate
  )), now);
  const path = scheduleItemOutboxPath(found.taskId, scheduleId);
  const action = scheduleId < 0 ? "create" : "update";
  enqueueTaskRelationOutbox(state, {
    path,
    action,
    taskId: found.taskId,
    payload: {
      relation: scheduleId < 0 ? "today" : "scheduleItem",
      scheduleId,
      id: scheduleId,
      ...item
    },
    supersedeReason: "Local task schedule item was updated; stale schedule operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return item;
}

export async function removeLocalTaskScheduleItem(state: DaemonState, scheduleId: number): Promise<boolean> {
  const found = findLocalScheduleItem(state, scheduleId);
  if (!found) return false;
  const now = new Date().toISOString();
  updateTaskScheduleItems(state, found.taskId, (items) => items.filter((item) => scheduleItemIdValue(item) !== scheduleId), now);
  const path = scheduleItemOutboxPath(found.taskId, scheduleId);
  supersedeOpenOutboxForPath(
    state,
    path,
    () => true,
    "Local task schedule item was removed; stale schedule operation was superseded.",
    now
  );
  if (scheduleId > 0) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: path,
      domain: "tasks",
      action: "delete",
      resourceId: found.taskId,
      payload: {
        relation: "scheduleItem",
        taskId: found.taskId,
        scheduleId,
        id: scheduleId,
        scheduledDate: found.item.scheduledDate,
        occurrenceDate: found.item.occurrenceDate
      }
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function recordLocalTaskOccurrence(
  state: DaemonState,
  taskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const operation = asString(input.operation);
  const targetDate = asString(input.targetDate);
  if (!operation || !targetDate) return undefined;
  const now = new Date().toISOString();
  const occurrence = {
    relation: "occurrence",
    taskId,
    operation,
    ...input,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    ...(operation === "complete" && asString(input.status) ? { status: input.status } : {}),
    occurrenceActions: [...taskOccurrenceActions(task), occurrence]
  }, now);
  enqueueTaskRelationOutbox(state, {
    path: occurrenceOutboxPath(taskId, operation, targetDate),
    action: "update",
    taskId,
    payload: occurrence,
    supersedeReason: "Local task occurrence was updated; stale occurrence operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  if (operation === "move") {
    return { taskId, sourceDate: input.sourceDate, targetDate };
  }
  if (operation === "skipException") {
    return { taskId, targetDate };
  }
  return { taskId, targetDate, status: input.status };
}

export async function createLocalTaskSubtask(
  state: DaemonState,
  taskId: string,
  occurrenceDate: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const title = asString(input.title);
  if (!title) return undefined;
  const now = new Date().toISOString();
  const subtask = {
    id: localSubtaskId(),
    taskId,
    occurrenceDate,
    title,
    isDone: false,
    sortOrder: taskSubtasks(task).length,
    createdAt: now,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, { ...task, subtasks: [...taskSubtasks(task), subtask] }, now);
  enqueueTaskRelationOutbox(state, {
    path: subtaskOutboxPath(taskId, occurrenceDate, subtask.id),
    action: "create",
    taskId,
    payload: {
      relation: "subtask",
      subtaskId: subtask.id,
      ...subtask
    },
    supersedeReason: "Local task subtask was recreated; stale subtask operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return subtask;
}

export async function updateLocalTaskSubtask(
  state: DaemonState,
  taskId: string,
  occurrenceDate: string,
  subtaskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const existing = taskSubtasks(task).find((item) => asString(item.id) === subtaskId && item.occurrenceDate === occurrenceDate);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const subtask = {
    ...existing,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.isDone === "boolean" ? { isDone: input.isDone } : {}),
    ...(typeof input.sortOrder === "number" ? { sortOrder: input.sortOrder } : {}),
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    subtasks: taskSubtasks(task).map((item) => asString(item.id) === subtaskId ? subtask : item)
  }, now);
  enqueueTaskRelationOutbox(state, {
    path: subtaskOutboxPath(taskId, occurrenceDate, subtaskId),
    action: subtaskId.startsWith("local-subtask-") ? "create" : "update",
    taskId,
    payload: {
      relation: "subtask",
      subtaskId,
      ...subtask
    },
    supersedeReason: "Local task subtask was updated; stale subtask operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return subtask;
}

export async function deleteLocalTaskSubtask(
  state: DaemonState,
  taskId: string,
  occurrenceDate: string,
  subtaskId: string
): Promise<boolean> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return false;
  const existing = taskSubtasks(task).find((item) => asString(item.id) === subtaskId && item.occurrenceDate === occurrenceDate);
  if (!existing) return false;
  const now = new Date().toISOString();
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    subtasks: taskSubtasks(task).filter((item) => asString(item.id) !== subtaskId)
  }, now);
  const path = subtaskOutboxPath(taskId, occurrenceDate, subtaskId);
  supersedeOpenOutboxForPath(
    state,
    path,
    () => true,
    "Local task subtask was removed; stale subtask operation was superseded.",
    now
  );
  if (!subtaskId.startsWith("local-subtask-")) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: path,
      domain: "tasks",
      action: "delete",
      resourceId: taskId,
      payload: {
        relation: "subtask",
        taskId,
        occurrenceDate,
        subtaskId,
        id: subtaskId
      }
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function createLocalTaskAttachment(
  state: DaemonState,
  taskId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const filename = asString(input.filename) ?? asString(input.originalFilename);
  const contentBase64 = asString(input.contentBase64);
  if (!filename || !contentBase64) return undefined;
  const now = new Date().toISOString();
  const buffer = Buffer.from(contentBase64, "base64");
  const attachment = {
    id: `local-attachment-${randomUUID()}`,
    taskId,
    filename,
    mimeType: asString(input.mimeType) ?? "application/octet-stream",
    sizeBytes: buffer.byteLength,
    contentBase64,
    createdAt: now,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, { ...task, attachments: [...taskAttachments(task), attachment] }, now);
  enqueueTaskRelationOutbox(state, {
    path: attachmentOutboxPath(taskId, attachment.id),
    action: "create",
    taskId,
    payload: {
      relation: "attachment",
      attachmentId: attachment.id,
      ...attachment
    },
    supersedeReason: "Local task attachment was recreated; stale attachment operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return attachment;
}

export async function updateLocalTaskAttachment(
  state: DaemonState,
  taskId: string,
  attachmentId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return undefined;
  const existing = taskAttachments(task).find((item) => asString(item.id) === attachmentId);
  if (!existing) return undefined;
  const contentBase64 = asString(input.contentBase64) ?? asString(existing.contentBase64);
  if (!contentBase64) return undefined;
  const now = new Date().toISOString();
  const buffer = Buffer.from(contentBase64, "base64");
  const attachment = {
    ...existing,
    filename: asString(input.filename) ?? asString(existing.filename) ?? attachmentId,
    mimeType: asString(input.mimeType) ?? asString(existing.mimeType) ?? "application/octet-stream",
    sizeBytes: buffer.byteLength,
    contentBase64,
    updatedAt: now
  };
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    attachments: taskAttachments(task).map((item) => asString(item.id) === attachmentId ? attachment : item)
  }, now);
  enqueueTaskRelationOutbox(state, {
    path: attachmentOutboxPath(taskId, attachmentId),
    action: attachmentId.startsWith("local-attachment-") ? "create" : "update",
    taskId,
    payload: {
      relation: "attachment",
      attachmentId,
      ...attachment
    },
    supersedeReason: "Local task attachment was updated; stale attachment operation was superseded.",
    updatedAt: now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return attachment;
}

export async function deleteLocalTaskAttachment(state: DaemonState, taskId: string, attachmentId: string): Promise<boolean> {
  const task = localTaskPayloadForUpdate(state, taskId);
  if (!task || task.deleted === true) return false;
  const existing = taskAttachments(task).find((item) => asString(item.id) === attachmentId);
  if (!existing) return false;
  const now = new Date().toISOString();
  upsertLocalTaskPayload(state, taskId, {
    ...task,
    attachments: taskAttachments(task).filter((item) => asString(item.id) !== attachmentId)
  }, now);
  const path = attachmentOutboxPath(taskId, attachmentId);
  supersedeOpenOutboxForPath(
    state,
    path,
    () => true,
    "Local task attachment was removed; stale attachment operation was superseded.",
    now
  );
  if (!attachmentId.startsWith("local-attachment-")) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: path,
      domain: "tasks",
      action: "delete",
      resourceId: taskId,
      payload: {
        relation: "attachment",
        taskId,
        attachmentId,
        id: attachmentId
      }
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function createLocalTask(state: DaemonState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${LOCAL_TASK_ID_PREFIX}${randomUUID()}`;
  const payload: Record<string, unknown> = {
    ...normalizeLocalTaskPayload(state, input),
    id
  };
  const now = new Date().toISOString();
  const outboxPath = taskOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task was recreated through daemon facade; stale task operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "tasks",
    action: "create",
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: id,
    payload,
    updatedAt: asString(payload.updatedAt) ?? now
  });
  if (payload.isPinned === true) {
    enqueueLocalTaskPinOutbox(state, id, true, now);
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function updateLocalTask(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "tasks", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...normalizeLocalTaskPayload(state, input, existing),
    id
  };
  const outboxPath = taskOutboxPath(id);
  const action = isLocalTaskId(id) ? "create" : "update";
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task was updated through daemon facade; stale task operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "tasks",
    action,
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: asString(payload.updatedAt) ?? now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  if (typeof input.isPinned === "boolean") {
    enqueueLocalTaskPinOutbox(state, id, input.isPinned, now);
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function deleteLocalTask(state: DaemonState, id: string): Promise<boolean> {
  const existing = localRemoteDomainItem(state, "tasks", id);
  if (!existing) return false;
  const now = new Date().toISOString();
  const outboxPath = taskOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local task was deleted through daemon facade; stale task operation was superseded.",
    now
  );
  for (const item of listOpenOutboxForResource(state.manifestStore, id)) {
    if (item.domain === "tasks" && asString(item.payload.relation)) {
      markOutboxSuperseded(
        state.manifestStore,
        item.id,
        "Local task was deleted before a related task operation synced; stale relation operation was superseded.",
        now
      );
    }
  }

  if (isLocalTaskId(id)) {
    removeRemoteResource(state.manifestStore, "tasks", id);
  } else {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: outboxPath,
      domain: "tasks",
      action: "delete",
      resourceId: id,
      payload: existing
    });
    markRemoteResourceDeleted(state.manifestStore, {
      domain: "tasks",
      resourceId: id,
      version: asNumber(existing.version),
      payload: existing,
      deletedAt: now,
      lastSyncedAt: asString(existing.lastSyncedAt)
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function setLocalTaskPin(state: DaemonState, id: string, pinned: boolean): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "tasks", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload = {
    ...existing,
    id,
    isPinned: pinned,
    updatedAt: now
  };
  enqueueLocalTaskPinOutbox(state, id, pinned, now);
  upsertRemoteResource(state.manifestStore, {
    domain: "tasks",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return { taskId: id, pinned };
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

async function buildOutboxPayloadForFile(
  config: DaemonConfig,
  absolutePath: string,
  relativePath: string,
  kind: "note" | "file"
): Promise<Record<string, unknown>> {
  if (kind === "note") {
    return {
      kind: "note",
      path: relativePath,
      title: titleFor(relativePath),
      contentMarkdown: await fs.readFile(absolutePath, "utf8")
    };
  }

  const buffer = await fs.readFile(absolutePath);
  return {
    kind: "file",
    filename: basename(relativePath),
    directoryPath: directoryPathFor(relativePath),
    mimeType: mimeTypeForPath(relativePath),
    contentBase64: buffer.toString("base64"),
    maxSyncFileBytes: config.maxSyncFileBytes
  };
}

function buildOutboxPayloadForFolder(relativePath: string): Record<string, unknown> {
  return {
    kind: "folder",
    path: relativePath,
    title: titleFor(relativePath)
  };
}

type PendingLocalCreateCandidate = {
  absolutePath: string;
  relativePath: string;
  kind: "note" | "file";
  checksum: string;
  sizeBytes: number;
  localUpdatedAt: string;
};

function renameCandidateKey(kind: "note" | "file", checksum: string, sizeBytes: number): string {
  return `${kind}\0${sizeBytes}\0${checksum}`;
}

function addRenameCandidateGroup<T>(
  groups: Map<string, T[]>,
  key: string,
  value: T
): void {
  const existing = groups.get(key);
  if (existing) {
    existing.push(value);
  } else {
    groups.set(key, [value]);
  }
}

async function buildOutboxPayloadForRename(
  config: DaemonConfig,
  candidate: PendingLocalCreateCandidate
): Promise<Record<string, unknown>> {
  if (candidate.kind === "note") {
    return buildOutboxPayloadForFile(config, candidate.absolutePath, candidate.relativePath, candidate.kind);
  }

  return {
    kind: "file",
    path: candidate.relativePath,
    title: basename(candidate.relativePath)
  };
}

async function queueCleanLocalRenameUpdates(
  state: DaemonState,
  currentPaths: Set<string>,
  pendingCreateCandidates: PendingLocalCreateCandidate[],
  now: string
): Promise<Set<string>> {
  const candidateGroups = new Map<string, PendingLocalCreateCandidate[]>();
  for (const candidate of pendingCreateCandidates) {
    if (!resolveSyncRootRelativePath(state.config, candidate.relativePath)) continue;
    if (hasOpenOutboxForPath(state.manifestStore, candidate.relativePath)) continue;
    addRenameCandidateGroup(
      candidateGroups,
      renameCandidateKey(candidate.kind, candidate.checksum, candidate.sizeBytes),
      candidate
    );
  }

  const resourceGroups = new Map<string, ManifestResource[]>();
  for (const resource of listResources(state.manifestStore)) {
    if (resource.kind === "folder") continue;
    if (!resource.resourceId || resource.dirty) continue;
    if (!resource.checksum || typeof resource.sizeBytes !== "number") continue;
    if (isIgnoredSyncRelativePath(resource.relativePath)) continue;
    if (!resolveSyncRootRelativePath(state.config, resource.relativePath)) continue;
    if (currentPaths.has(resource.relativePath)) continue;
    if (hasOpenOutboxForPath(state.manifestStore, resource.relativePath)) continue;
    if (listOpenOutboxForResource(state.manifestStore, resource.resourceId).length > 0) continue;
    addRenameCandidateGroup(
      resourceGroups,
      renameCandidateKey(resource.kind, resource.checksum, resource.sizeBytes),
      resource
    );
  }

  const renamedCandidatePaths = new Set<string>();
  for (const [key, resources] of resourceGroups) {
    const candidates = candidateGroups.get(key);
    if (resources.length !== 1 || candidates?.length !== 1) continue;

    const resource = resources[0];
    const candidate = candidates[0];
    const payload = await buildOutboxPayloadForRename(state.config, candidate);
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: candidate.relativePath,
      domain: "artifacts",
      action: "update",
      resourceId: resource.resourceId,
      payload
    });
    removeResource(state.manifestStore, resource.relativePath);
    upsertManifestResource(state.manifestStore, {
      ...resource,
      relativePath: candidate.relativePath,
      kind: candidate.kind,
      checksum: candidate.checksum,
      sizeBytes: candidate.sizeBytes,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: candidate.localUpdatedAt
    });
    renamedCandidatePaths.add(candidate.relativePath);
  }

  return renamedCandidatePaths;
}

function supersedeOpenOutboxForPath(
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

function hasOpenOutboxAction(
  state: DaemonState,
  relativePath: string,
  predicate: (item: OutboxItem) => boolean
): boolean {
  return listOpenOutboxForPath(state.manifestStore, relativePath).some(predicate);
}

function ancestorFolderPaths(relativePath: string): string[] {
  const ancestors: string[] = [];
  let current = directoryPathFor(relativePath);
  while (current) {
    ancestors.push(current);
    current = directoryPathFor(current);
  }
  return ancestors;
}

function hasOpenFolderDeleteAncestor(state: DaemonState, relativePath: string): boolean {
  return ancestorFolderPaths(relativePath).some((folderPath) => hasOpenOutboxAction(
    state,
    folderPath,
    (item) => item.action === "delete" && item.payload.kind === "folder"
  ));
}

export async function scanSyncFolder(state: DaemonState): Promise<void> {
  const currentPaths = new Set<string>();
  const pendingCreateCandidates: PendingLocalCreateCandidate[] = [];
  const folders = await walkSyncDirectories(state.config);
  const files = await walkSyncFiles(state.config);
  const now = new Date().toISOString();

  for (const relativePath of folders) {
    if (!relativePath || isIgnoredSyncRelativePath(relativePath)) continue;
    currentPaths.add(relativePath);
    const absolutePath = resolveSyncRootRelativePath(state.config, relativePath);
    if (!absolutePath) continue;
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const existing = getResource(state.manifestStore, relativePath);
    const openOutboxItems = listOpenOutboxForPath(state.manifestStore, relativePath);
    if (openOutboxItems.some((item) => item.action === "delete")) {
      supersedeOpenOutboxForPath(
        state,
        relativePath,
        (item) => item.action === "delete",
        "Local folder exists again; pending delete was superseded by recovery scan.",
        now
      );
    }

    if (existing?.kind === "folder" && !existing.dirty) {
      upsertManifestResource(state.manifestStore, {
        ...existing,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }
    if (hasOpenOutboxForPath(state.manifestStore, relativePath)) continue;

    enqueueManifestOutbox(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      action: existing?.resourceId ? "update" : "create",
      resourceId: existing?.resourceId,
      payload: buildOutboxPayloadForFolder(relativePath)
    });
    upsertManifestResource(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      kind: "folder",
      resourceId: existing?.resourceId,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: stat.mtime.toISOString()
    });
  }

  for (const absolutePath of files) {
    const relativePath = relativeSyncPath(state.config, absolutePath);
    if (!relativePath) continue;
    if (isIgnoredSyncRelativePath(relativePath)) continue;
    currentPaths.add(relativePath);
    const stat = await waitForStableFile(absolutePath);
    if (!stat) continue;
    const kind = artifactKindForPath(relativePath);
    const existing = getResource(state.manifestStore, relativePath);
    if (stat.size > state.config.maxSyncFileBytes) {
      upsertManifestResource(state.manifestStore, {
        ...(existing ?? { relativePath, domain: "artifacts", kind }),
        checksum: existing?.checksum,
        sizeBytes: stat.size,
        dirty: false,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }

    const checksum = await hashFile(absolutePath);
    const openOutboxItems = listOpenOutboxForPath(state.manifestStore, relativePath);
    const hasOpenDelete = openOutboxItems.some((item) => item.action === "delete");
    const hasStaleWrite = openOutboxItems.some(
      (item) => (item.action === "create" || item.action === "update") && existing?.checksum !== checksum
    );
    if (hasOpenDelete) {
      supersedeOpenOutboxForPath(
        state,
        relativePath,
        (item) => item.action === "delete",
        "Local file exists again; pending delete was superseded by recovery scan.",
        now
      );
    }
    if (hasStaleWrite) {
      supersedeOpenOutboxForPath(
        state,
        relativePath,
        (item) => item.action === "create" || item.action === "update",
        "Local file changed before sync completed; stale write was superseded by recovery scan.",
        now
      );
    }

    if (existing?.checksum === checksum && !existing.dirty) {
      upsertManifestResource(state.manifestStore, {
        ...existing,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }
    if (hasOpenOutboxForPath(state.manifestStore, relativePath)) continue;

    if (!existing) {
      pendingCreateCandidates.push({
        absolutePath,
        relativePath,
        kind,
        checksum,
        sizeBytes: stat.size,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }

    const payload = await buildOutboxPayloadForFile(state.config, absolutePath, relativePath, kind);
    const action = existing?.resourceId ? "update" : "create";
    enqueueManifestOutbox(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      action,
      resourceId: action === "update" ? existing?.resourceId : undefined,
      payload
    });
    upsertManifestResource(state.manifestStore, {
      ...(existing ?? { relativePath, domain: "artifacts", kind }),
      kind,
      checksum,
      sizeBytes: stat.size,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: stat.mtime.toISOString()
    });
  }

  const renamedCandidatePaths = await queueCleanLocalRenameUpdates(state, currentPaths, pendingCreateCandidates, now);
  for (const candidate of pendingCreateCandidates) {
    if (renamedCandidatePaths.has(candidate.relativePath)) continue;
    if (hasOpenOutboxForPath(state.manifestStore, candidate.relativePath)) continue;

    const payload = await buildOutboxPayloadForFile(
      state.config,
      candidate.absolutePath,
      candidate.relativePath,
      candidate.kind
    );
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: candidate.relativePath,
      domain: "artifacts",
      action: "create",
      payload
    });
    upsertManifestResource(state.manifestStore, {
      relativePath: candidate.relativePath,
      domain: "artifacts",
      kind: candidate.kind,
      checksum: candidate.checksum,
      sizeBytes: candidate.sizeBytes,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: candidate.localUpdatedAt
    });
  }

  for (const resource of listResources(state.manifestStore)) {
    if (isIgnoredSyncRelativePath(resource.relativePath)) {
      removeResource(state.manifestStore, resource.relativePath);
      continue;
    }
    if (currentPaths.has(resource.relativePath)) continue;
    if (resource.kind !== "folder" && hasOpenFolderDeleteAncestor(state, resource.relativePath)) continue;

    const supersededWrites = supersedeOpenOutboxForPath(
      state,
      resource.relativePath,
      (item) => item.action === "create" || item.action === "update",
      "Local file was removed before sync completed; stale write was superseded by recovery scan.",
      now
    );
    if (supersededWrites.length > 0 && !resource.resourceId) {
      removeResource(state.manifestStore, resource.relativePath);
      continue;
    }
    if (hasOpenOutboxAction(state, resource.relativePath, (item) => item.action === "delete")) continue;
    if (hasOpenOutboxForPath(state.manifestStore, resource.relativePath)) continue;

    if (!resource.resourceId) {
      removeResource(state.manifestStore, resource.relativePath);
      continue;
    }
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
  }

  setMeta(state.manifestStore, "lastScanAt", now);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRemoteResourceDomain(value: unknown): RemoteResourceDomain | undefined {
  return value === "projects" || value === "notes" || value === "artifacts" || value === "tasks" ? value : undefined;
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

function remoteResourceUpdatedAt(payload: Record<string, unknown>, fallback: string): string {
  return asString(payload.updatedAt)
    ?? asString(payload.updated_at)
    ?? asString(payload.modifiedAt)
    ?? asString(payload.createdAt)
    ?? fallback;
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

function applyRemoteDomainEvent(state: DaemonState, event: RemoteSyncEvent): void {
  const domain = parseRemoteResourceDomain(event.domain);
  if (!domain || domain === "artifacts") return;
  const payload = asRecord(event.payload) ?? {};
  if (asString(payload.localClientId) === state.identity?.localClientId) return;

  const createdAt = asString(event.createdAt) ?? new Date().toISOString();
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
  options: { cursor?: string; limit?: number } = {}
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

async function bootstrapRemoteArtifactSnapshot(state: DaemonState): Promise<string | undefined> {
  if (!state.identity) throw new Error("Missing local client identity");
  let snapshot: SyncSnapshotResponse;
  try {
    snapshot = await getSyncSnapshot(state, REMOTE_SYNC_DOMAINS);
  } catch (error) {
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

  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await getSyncPullPage(state, cursor, REMOTE_CURSOR_DRAIN_LIMIT);
    const events = page.events ?? [];
    for (const event of events) {
      const eventTime = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
      if (Number.isFinite(eventTime) && eventTime > Date.parse(generatedAt)) {
        await applyRemoteSyncEvent(state, event);
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
  if (!cursor || !snapshotComplete) {
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

type SyncPushResponse = {
  applied?: Array<{
    index: number;
    domain?: RemoteResourceDomain;
    action?: "create" | "update" | "delete";
    resourceId?: string;
    version?: number;
    result?: unknown;
  }>;
  rejected?: Array<{
    index: number;
    code?: string;
    message?: string;
  }>;
  serverCursor?: string;
};

type SyncErrorDetails = SyncErrorMetadata & {
  errorMessage: string;
};

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function errorCodeFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return stringFromUnknown(code);
}

function statusFromUnknown(value: unknown): number | undefined {
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

  if (normalizedCode === "SYNC_VERSION_CONFLICT" || status === 409) {
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
    || normalizedCode.includes("BASE64")
    || normalizedMessage.includes("exceeds max sync size")
    || status === 400
  ) {
    return { errorMessage, errorCode, errorCategory: "validation", retryable: false };
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

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
  try {
    await ensureIdentity(state);
    const jobs = await claimJobs(state);
    for (const job of jobs) {
      await processJob(state, job);
    }
    await pullRemoteArtifactSyncState(state);
    await scanSyncFolder(state);
    await pushOutbox(state);
    await heartbeat(state);
    state.lastError = undefined;
    state.lastErrorCode = undefined;
    state.lastErrorCategory = undefined;
    state.lastErrorRetryable = undefined;
  } catch (error) {
    const details = classifySyncError(error);
    state.lastError = details.errorMessage;
    state.lastErrorCode = details.errorCode;
    state.lastErrorCategory = details.errorCategory;
    state.lastErrorRetryable = details.retryable;
    console.warn(`[sync-daemon] ${state.lastError}`);
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

async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readRequestBuffer(req)).toString("utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function readRequestText(req: IncomingMessage): Promise<string> {
  return (await readRequestBuffer(req)).toString("utf8");
}

async function readRequestFormData(req: IncomingMessage): Promise<FormData> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const request = new Request("http://127.0.0.1", {
    method: req.method ?? "POST",
    headers,
    body: Readable.toWeb(req) as unknown as BodyInit,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
  return request.formData();
}

function getFormDataString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function parseConflictStatus(value: string | null): ConflictStatus | "all" | undefined {
  if (value === "open" || value === "resolved" || value === "ignored" || value === "all") return value;
  return undefined;
}

function parseConflictResolution(value: unknown): ConflictResolution | undefined {
  return value === "retry" || value === "ignore" || value === "close" ? value : undefined;
}

function parseBooleanQuery(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeConfiguredOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === "*" || trimmed === "null") return trimmed;
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function parseLoopbackAllowedOrigins(raw: string | undefined): string[] | undefined {
  const values = raw
    ?.split(",")
    .map((value) => normalizeConfiguredOrigin(value))
    .filter((value): value is string => Boolean(value));
  return values && values.length > 0 ? [...new Set(values)] : undefined;
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function isDefaultLoopbackOrigin(origin: string): boolean {
  if (origin === "null") return false;
  try {
    const url = new URL(origin);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "tauri:") {
      return false;
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "tauri.localhost" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function isLoopbackOriginAllowed(origin: string | undefined, allowedOrigins?: string[]): boolean {
  if (!origin) return true;
  const normalizedOrigin = normalizeConfiguredOrigin(origin);
  if (!normalizedOrigin) return false;
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return isDefaultLoopbackOrigin(normalizedOrigin);
  }
  return allowedOrigins.some((allowedOrigin) => allowedOrigin === "*" || allowedOrigin === normalizedOrigin);
}

export const LOOPBACK_CORS_ERROR_CODE = "WORKBENCH_DAEMON_CORS_DENIED";
export const LOOPBACK_CORS_ERROR_MESSAGE = "Origin is not allowed for the local daemon API.";

function setLoopbackCorsHeaders(config: DaemonConfig, req: IncomingMessage, res: ServerResponse): boolean {
  const origin = requestOrigin(req);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-workbench-daemon-token");
  res.setHeader("Access-Control-Max-Age", "600");
  if (!origin) {
    return true;
  }
  if (!isLoopbackOriginAllowed(origin, config.apiAllowedOrigins)) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  return true;
}

export const LOOPBACK_AUTH_ERROR_CODE = "WORKBENCH_DAEMON_UNAUTHORIZED";
export const LOOPBACK_AUTH_ERROR_MESSAGE = "Local daemon API token is required.";

export function loopbackAuthBypassed(pathname: string, method?: string): boolean {
  return method === "OPTIONS" || pathname === "/health";
}

export function requestHasValidLoopbackToken(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const headerToken = req.headers["x-workbench-daemon-token"];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (token === expectedToken) return true;

  const authorization = req.headers.authorization;
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] === expectedToken;
}

function requireLoopbackAuth(state: DaemonState, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (loopbackAuthBypassed(pathname, req.method)) return true;
  if (requestHasValidLoopbackToken(req, state.config.apiToken)) return true;

  writeJson(res, {
    code: LOOPBACK_AUTH_ERROR_CODE,
    message: LOOPBACK_AUTH_ERROR_MESSAGE
  }, 401);
  return false;
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
    localClientId: state.identity?.localClientId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastClaimAt: state.lastClaimAt,
    lastScanAt: state.lastScanAt,
    lastPushAt: state.lastPushAt,
    lastRemotePullAt: state.lastRemotePullAt,
    remoteSyncCursor: getMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY) ?? state.remoteArtifactCursor,
    remoteArtifactCursor: state.remoteArtifactCursor,
    remoteArtifactSnapshotComplete: getMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY) === "1",
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

function writeJson(res: ServerResponse, value: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value, null, 2));
}

async function sendLocalArtifactDownload(state: DaemonState, item: LocalArtifactItem, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (item.kind === "folder") {
    writeJson(res, { message: "Folder items cannot be downloaded" }, 400);
    return;
  }
  const absolutePath = resolveSyncRootRelativePath(state.config, item.path);
  if (!absolutePath) {
    writeJson(res, { message: "Invalid local artifact path" }, 400);
    return;
  }
  try {
    const buffer = await fs.readFile(absolutePath);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", item.mimeType ?? mimeTypeForPath(item.path));
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(item.path))}`);
    res.end(buffer);
  } catch {
    writeJson(res, { message: "Local artifact file not found" }, 404);
  }
}

function startStatusServer(state: DaemonState): void {
  if (state.config.httpPort === 0) return;
  const server = createServer(async (req, res) => {
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
    if (url.pathname === "/health") {
      writeJson(res, { status: "ok" });
      return;
    }

    if (url.pathname === "/status" || url.pathname === "/api/sync/status") {
      writeJson(res, daemonStatusPayload(state));
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
      writeJson(res, {
        generatedAt: new Date().toISOString(),
        source: "local-daemon",
        domains
      });
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
        const result = await removeLocalTaskFromToday(state, taskId, scheduledDate);
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
  });
  server.listen(state.config.httpPort, "127.0.0.1", () => {
    console.log(`[sync-daemon] status listening on http://127.0.0.1:${state.config.httpPort}/status`);
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  await ensureDirs(config);
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
