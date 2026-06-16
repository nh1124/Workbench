import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  enqueueOutbox as enqueueManifestOutbox,
  getMeta,
  getResource,
  hasOpenOutboxForPath,
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
  removeResource,
  resolveConflict,
  setMeta,
  upsertResource as upsertManifestResource,
  writeManifestDebugSnapshot,
  type ConflictResolution,
  type ConflictStatus,
  type ManifestResource,
  type ManifestStore,
  type OutboxItem
} from "./manifestStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: resolve(__dirname, "../.env") });

type LocalJob = {
  id: string;
  kind: "download_artifact" | "download_task_attachment" | "materialize_resource";
  target: "downloads" | "sync-folder";
  payload: Record<string, unknown>;
  status: string;
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

type ClientIdentity = {
  localClientId: string;
  localClientToken: string;
  deviceId: string;
  syncRootId: string;
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
  processedJobs: number;
  outboxPending: number;
  outboxFailed: number;
  conflictsOpen: number;
  watcherActive: boolean;
  tickRunning: boolean;
  tickQueued: boolean;
  tickTimer?: ReturnType<typeof setTimeout>;
  watcher?: FSWatcher;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readConfig(): DaemonConfig {
  const syncRoot = resolve(env("WORKBENCH_SYNC_ROOT") ?? join(homedir(), "WorkbenchSync"));
  const downloadsDir = resolve(env("WORKBENCH_DOWNLOADS_DIR") ?? join(homedir(), "Downloads"));
  const intervalRaw = Number(env("WORKBENCH_DAEMON_INTERVAL_MS") ?? "5000");
  const httpPortRaw = Number(env("WORKBENCH_DAEMON_HTTP_PORT") ?? "35780");
  const maxSyncFileBytesRaw = Number(env("WORKBENCH_MAX_SYNC_FILE_BYTES") ?? String(10 * 1024 * 1024));
  const watchDebounceRaw = Number(env("WORKBENCH_SYNC_WATCH_DEBOUNCE_MS") ?? "800");
  const watchEnabledRaw = env("WORKBENCH_SYNC_WATCH")?.toLowerCase();
  return {
    coreUrl: (env("WORKBENCH_CORE_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
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
    watchDebounceMs: Number.isFinite(watchDebounceRaw) ? Math.max(100, watchDebounceRaw) : 800
  };
}

async function ensureDirs(config: DaemonConfig): Promise<void> {
  await fs.mkdir(config.syncRoot, { recursive: true });
  await fs.mkdir(config.downloadsDir, { recursive: true });
  await fs.mkdir(join(config.syncRoot, ".workbench"), { recursive: true });
  await fs.mkdir(join(config.syncRoot, ".workbench", "conflicts"), { recursive: true });
}

function identityPath(config: DaemonConfig): string {
  return join(config.syncRoot, ".workbench", "client-identity.json");
}

async function readJsonFile<T>(pathValue: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(pathValue, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(pathValue: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(pathValue), { recursive: true });
  await fs.writeFile(pathValue, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readIdentity(config: DaemonConfig): Promise<ClientIdentity | undefined> {
  const envClientId = env("WORKBENCH_LOCAL_CLIENT_ID");
  const envClientToken = env("WORKBENCH_LOCAL_CLIENT_TOKEN");
  if (envClientId && envClientToken) {
    return {
      localClientId: envClientId,
      localClientToken: envClientToken,
      deviceId: config.deviceId,
      syncRootId: config.syncRootId
    };
  }
  return readJsonFile<ClientIdentity>(identityPath(config));
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

async function registerIfNeeded(config: DaemonConfig): Promise<ClientIdentity> {
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
  await writeJsonFile(identityPath(config), identity);
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
    throw new Error("Invalid local job download checksum header");
  }
  return hex;
}

function assertExpectedDownloadChecksum(expected: string | null, actualHex: string): void {
  const expectedHex = normalizeSha256Checksum(expected);
  if (expectedHex && expectedHex !== actualHex.toLowerCase()) {
    throw new Error("Local job download checksum mismatch");
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
    mimeType: resource.kind === "note" ? "text/markdown" : mimeTypeForPath(resource.relativePath),
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
  const updatedAt = stat.mtime.toISOString();
  setMeta(state.manifestStore, "lastScanAt", new Date().toISOString());
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return buildLocalFolderItem(state, relativePath, updatedAt);
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
    await fs.rm(absolutePath, { force: true }).catch(() => {
      // Best-effort local file deletion.
    });
  }

  if (resource.resourceId) {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: resource.relativePath,
      domain: "artifacts",
      action: "delete",
      resourceId: resource.resourceId,
      payload: {}
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

export async function scanSyncFolder(state: DaemonState): Promise<void> {
  const currentPaths = new Set<string>();
  const pendingCreateCandidates: PendingLocalCreateCandidate[] = [];
  const files = await walkSyncFiles(state.config);
  const now = new Date().toISOString();

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
      payload: {}
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
  domains?: {
    artifacts?: unknown;
  };
};

const REMOTE_ARTIFACT_CURSOR_META_KEY = "remoteArtifactCursor";
const LAST_REMOTE_PULL_AT_META_KEY = "lastRemotePullAt";
const REMOTE_PULL_LIMIT = 100;
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
  }
): Promise<void> {
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
    await fs.mkdir(folderPath, { recursive: true });
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

async function bootstrapRemoteArtifactSnapshot(state: DaemonState): Promise<string | undefined> {
  if (!state.identity) throw new Error("Missing local client identity");
  const snapshot = await coreJson<SyncSnapshotResponse>(state.config, "/api/sync/snapshot?domains=artifacts", {
    method: "GET",
    localIdentity: state.identity
  });
  const generatedAt = asString(snapshot.generatedAt) ?? new Date().toISOString();
  const artifacts = Array.isArray(snapshot.domains?.artifacts) ? snapshot.domains.artifacts : [];
  for (const artifact of artifacts) {
    await applyRemoteArtifactSnapshotEntry(state, artifact, generatedAt);
  }

  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await getSyncPullPage(state, cursor, REMOTE_CURSOR_DRAIN_LIMIT);
    const events = page.events ?? [];
    for (const event of events) {
      const eventTime = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
      if (Number.isFinite(eventTime) && eventTime > Date.parse(generatedAt)) {
        await applyRemoteArtifactEvent(state, event);
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
  let cursor = getMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY) ?? state.remoteArtifactCursor;
  if (!cursor) {
    cursor = await bootstrapRemoteArtifactSnapshot(state);
  } else {
    const page = await getSyncPullPage(state, cursor, REMOTE_PULL_LIMIT);
    for (const event of page.events ?? []) {
      await applyRemoteArtifactEvent(state, event);
    }
    cursor = page.nextCursor ?? cursor;
  }

  const now = new Date().toISOString();
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
    resourceId?: string;
    result?: unknown;
  }>;
  rejected?: Array<{
    index: number;
    code?: string;
    message?: string;
  }>;
  serverCursor?: string;
};

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
  errorMessage: string,
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
    errorMessage,
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
    errorMessage,
    payload: item.payload,
    createdAt
  }, null, 2)}\n`, "utf8");

  const resource = getResource(state.manifestStore, item.relativePath);
  if (resource) {
    upsertManifestResource(state.manifestStore, {
      ...resource,
      dirty: true,
      lastError: errorMessage
    });
  }
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
}

async function pushOutbox(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  const pending = listPendingOutbox(state.manifestStore, 20);
  if (pending.length === 0) {
    await refreshManifestStats(state);
    return;
  }

  const result = await postSyncPush(state, pending);
  const applied = result.applied ?? [];
  const rejected = result.rejected ?? [];
  const now = new Date().toISOString();
  if (result.serverCursor) {
    setMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY, result.serverCursor);
    state.remoteArtifactCursor = result.serverCursor;
  }
  for (const appliedItem of applied) {
    const item = pending[appliedItem.index];
    if (!item) continue;
    markOutboxApplied(state.manifestStore, item.id, now);
    const resourceId = appliedItem.resourceId ?? extractResourceId(appliedItem.result);
    const existing = getResource(state.manifestStore, item.relativePath);
    if (item.action === "delete") {
      removeResource(state.manifestStore, item.relativePath);
    } else {
      upsertManifestResource(state.manifestStore, {
        ...(existing ?? { relativePath: item.relativePath, domain: "artifacts", kind: artifactKindForPath(item.relativePath) }),
        resourceId: resourceId ?? existing?.resourceId,
        dirty: false,
        lastSyncedAt: now
      });
    }
  }
  for (const rejectedItem of rejected) {
    const item = pending[rejectedItem.index];
    if (!item) continue;
    const message = rejectedItem.message ?? rejectedItem.code ?? "Sync push rejected";
    markOutboxFailed(state.manifestStore, item.id, message, now);
    await writeConflictRecord(state, item, message, now);
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

async function processJob(state: DaemonState, job: LocalJob): Promise<void> {
  try {
    if (job.kind !== "download_artifact" && job.kind !== "download_task_attachment" && job.kind !== "materialize_resource") {
      throw new Error(`Unsupported local job kind: ${job.kind}`);
    }
    const result = await downloadJobFile(state, job);
    await recordManifestJob(state, job, result);
    await completeJob(state, job, result);
    state.processedJobs += 1;
  } catch (error) {
    await failJob(state, job, error);
    throw error;
  }
}

async function performTick(state: DaemonState): Promise<void> {
  try {
    state.identity = await registerIfNeeded(state.config);
    const jobs = await claimJobs(state);
    for (const job of jobs) {
      await processJob(state, job);
    }
    await pullRemoteArtifactSyncState(state);
    await scanSyncFolder(state);
    await pushOutbox(state);
    await heartbeat(state);
    state.lastError = undefined;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
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
    localClientId: state.identity?.localClientId,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastClaimAt: state.lastClaimAt,
    lastScanAt: state.lastScanAt,
    lastPushAt: state.lastPushAt,
    lastRemotePullAt: state.lastRemotePullAt,
    remoteArtifactCursor: state.remoteArtifactCursor,
    lastError: state.lastError,
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

    if (url.pathname === "/api/sync/snapshot" && req.method === "GET") {
      const requestedDomains = typeof url.searchParams.get("domains") === "string"
        ? (url.searchParams.get("domains") ?? "").split(",").map((value) => value.trim()).filter(Boolean)
        : ["artifacts"];
      const domainSet = new Set(requestedDomains);
      const domains: Record<string, unknown> = {};
      if (domainSet.has("artifacts")) {
        domains.artifacts = await listLocalArtifactItems(state, {
          includeContent: parseBooleanQuery(url.searchParams.get("includeContent"))
        });
      }
      writeJson(res, {
        generatedAt: new Date().toISOString(),
        source: "local-daemon",
        domains
      });
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
