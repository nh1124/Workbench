import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { config as loadEnv } from "dotenv";
import {
  enqueueOutbox as enqueueManifestOutbox,
  getResource,
  hasOpenOutboxForPath,
  listConflicts,
  listOpenOutboxForPath,
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

type ClientIdentity = {
  localClientId: string;
  localClientToken: string;
  deviceId: string;
  syncRootId: string;
};

export type DaemonConfig = {
  coreUrl: string;
  accessToken?: string;
  syncRoot: string;
  downloadsDir: string;
  deviceId: string;
  clientName: string;
  syncRootId: string;
  syncRootLabel: string;
  intervalMs: number;
  httpPort: number;
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
    syncRoot,
    downloadsDir,
    deviceId: env("WORKBENCH_DEVICE_ID") ?? `${hostname()}-${randomUUID()}`,
    clientName: env("WORKBENCH_CLIENT_NAME") ?? `${hostname()} Workbench daemon`,
    syncRootId: env("WORKBENCH_SYNC_ROOT_ID") ?? "default",
    syncRootLabel: env("WORKBENCH_SYNC_ROOT_LABEL") ?? "Workbench Sync",
    intervalMs: Number.isFinite(intervalRaw) ? Math.max(1000, intervalRaw) : 5000,
    httpPort: Number.isFinite(httpPortRaw) ? Math.max(0, httpPortRaw) : 35780,
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
        lastPushAt: state.lastPushAt
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

function sanitizeFileName(raw: string): string {
  const fallback = "download.bin";
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
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

  const requestedName = typeof job.payload.filename === "string" ? job.payload.filename : undefined;
  const headerName = parseContentDispositionFilename(response.headers.get("content-disposition"));
  const filename = sanitizeFileName(requestedName || headerName || basename(job.id));
  const directory = job.target === "sync-folder" ? state.config.syncRoot : state.config.downloadsDir;
  const localPath = await uniquePath(directory, filename);
  await fs.mkdir(dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, buffer);

  return {
    localPath,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.byteLength
  };
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/");
}

function relativeSyncPath(config: DaemonConfig, absolutePath: string): string | undefined {
  const rel = relative(config.syncRoot, absolutePath);
  if (!rel || rel.startsWith("..") || resolve(config.syncRoot, rel) === resolve(config.syncRoot, ".workbench")) {
    return undefined;
  }
  return normalizeRelativePath(rel);
}

function isIgnoredSyncRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\/+/, "");
  const fileName = basename(normalized).toLowerCase();
  if (!normalized || normalized === ".workbench" || normalized.startsWith(".workbench/")) return true;
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

    const payload = await buildOutboxPayloadForFile(state.config, absolutePath, relativePath, kind);
    const action = kind === "note" && existing?.resourceId ? "update" : "create";
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

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseConflictStatus(value: string | null): ConflictStatus | "all" | undefined {
  if (value === "open" || value === "resolved" || value === "ignored" || value === "all") return value;
  return undefined;
}

function parseConflictResolution(value: unknown): ConflictResolution | undefined {
  return value === "retry" || value === "ignore" || value === "close" ? value : undefined;
}

function setLoopbackCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function startStatusServer(state: DaemonState): void {
  if (state.config.httpPort === 0) return;
  const server = createServer(async (req, res) => {
    setLoopbackCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health" || url.pathname === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
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
        lastError: state.lastError,
        processedJobs: state.processedJobs,
        outboxPending: state.outboxPending,
        outboxFailed: state.outboxFailed,
        conflictsOpen: state.conflictsOpen
      }, null, 2));
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
