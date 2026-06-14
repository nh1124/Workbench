import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { config as loadEnv } from "dotenv";

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

type DaemonConfig = {
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
};

type DaemonState = {
  config: DaemonConfig;
  identity?: ClientIdentity;
  lastHeartbeatAt?: string;
  lastClaimAt?: string;
  lastScanAt?: string;
  lastPushAt?: string;
  lastError?: string;
  processedJobs: number;
  outboxPending: number;
  outboxFailed: number;
};

type ManifestResource = {
  relativePath: string;
  domain: "artifacts";
  kind: "note" | "file";
  resourceId?: string;
  checksum?: string;
  sizeBytes?: number;
  dirty?: boolean;
  lastSeenAt?: string;
  lastSyncedAt?: string;
  localUpdatedAt?: string;
};

type OutboxItem = {
  id: string;
  clientOpId: string;
  relativePath: string;
  domain: "artifacts";
  action: "create" | "update" | "delete";
  resourceId?: string;
  payload: Record<string, unknown>;
  status: "pending" | "applied" | "failed";
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
};

type Manifest = {
  jobs?: unknown[];
  resources?: ManifestResource[];
  outbox?: OutboxItem[];
  lastScanAt?: string;
  lastPushAt?: string;
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
    maxSyncFileBytes: Number.isFinite(maxSyncFileBytesRaw) ? Math.max(1024, maxSyncFileBytesRaw) : 10 * 1024 * 1024
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

function manifestPath(config: DaemonConfig): string {
  return join(config.syncRoot, ".workbench", "manifest.json");
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

async function readManifest(config: DaemonConfig): Promise<Manifest> {
  const manifest = (await readJsonFile<Manifest>(manifestPath(config))) ?? {};
  return {
    ...manifest,
    jobs: Array.isArray(manifest.jobs) ? manifest.jobs : [],
    resources: Array.isArray(manifest.resources) ? manifest.resources : [],
    outbox: Array.isArray(manifest.outbox) ? manifest.outbox : []
  };
}

async function writeManifest(config: DaemonConfig, manifest: Manifest): Promise<void> {
  await writeJsonFile(manifestPath(config), {
    ...manifest,
    resources: (manifest.resources ?? []).sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    outbox: manifest.outbox ?? []
  });
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
  const manifest = await readManifest(state.config);
  const outbox = manifest.outbox ?? [];
  state.outboxPending = outbox.filter((item) => item.status === "pending").length;
  state.outboxFailed = outbox.filter((item) => item.status === "failed").length;
  state.lastScanAt = manifest.lastScanAt ?? state.lastScanAt;
  state.lastPushAt = manifest.lastPushAt ?? state.lastPushAt;
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

async function walkSyncFiles(root: string, current = root, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".workbench") continue;
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkSyncFiles(root, absolutePath, files);
    } else if (entry.isFile()) {
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

function findResource(manifest: Manifest, relativePath: string): ManifestResource | undefined {
  return (manifest.resources ?? []).find((resource) => resource.relativePath === relativePath);
}

function upsertResource(manifest: Manifest, resource: ManifestResource): void {
  const resources = manifest.resources ?? [];
  const index = resources.findIndex((item) => item.relativePath === resource.relativePath);
  if (index >= 0) {
    resources[index] = { ...resources[index], ...resource };
  } else {
    resources.push(resource);
  }
  manifest.resources = resources;
}

function hasPendingOutbox(manifest: Manifest, relativePath: string): boolean {
  return (manifest.outbox ?? []).some((item) => item.relativePath === relativePath && item.status !== "applied");
}

function enqueueOutbox(manifest: Manifest, item: Omit<OutboxItem, "id" | "clientOpId" | "status" | "attempts" | "createdAt" | "updatedAt">): void {
  const now = new Date().toISOString();
  const id = randomUUID();
  const outboxItem: OutboxItem = {
    ...item,
    id,
    clientOpId: `daemon-${id}`,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };
  manifest.outbox = [...(manifest.outbox ?? []), outboxItem].slice(-1000);
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

async function scanSyncFolder(state: DaemonState): Promise<void> {
  const manifest = await readManifest(state.config);
  const currentPaths = new Set<string>();
  const files = await walkSyncFiles(state.config.syncRoot);
  const now = new Date().toISOString();

  for (const absolutePath of files) {
    const relativePath = relativeSyncPath(state.config, absolutePath);
    if (!relativePath) continue;
    currentPaths.add(relativePath);
    const stat = await fs.stat(absolutePath);
    const kind = artifactKindForPath(relativePath);
    const existing = findResource(manifest, relativePath);
    if (stat.size > state.config.maxSyncFileBytes) {
      upsertResource(manifest, {
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
    if (existing?.checksum === checksum && !existing.dirty) {
      upsertResource(manifest, {
        ...existing,
        lastSeenAt: now,
        localUpdatedAt: stat.mtime.toISOString()
      });
      continue;
    }
    if (hasPendingOutbox(manifest, relativePath)) continue;

    const payload = await buildOutboxPayloadForFile(state.config, absolutePath, relativePath, kind);
    const action = kind === "note" && existing?.resourceId ? "update" : "create";
    enqueueOutbox(manifest, {
      relativePath,
      domain: "artifacts",
      action,
      resourceId: action === "update" ? existing?.resourceId : undefined,
      payload
    });
    upsertResource(manifest, {
      ...(existing ?? { relativePath, domain: "artifacts", kind }),
      kind,
      checksum,
      sizeBytes: stat.size,
      dirty: true,
      lastSeenAt: now,
      localUpdatedAt: stat.mtime.toISOString()
    });
  }

  for (const resource of manifest.resources ?? []) {
    if (currentPaths.has(resource.relativePath) || hasPendingOutbox(manifest, resource.relativePath)) continue;
    if (!resource.resourceId) continue;
    enqueueOutbox(manifest, {
      relativePath: resource.relativePath,
      domain: "artifacts",
      action: "delete",
      resourceId: resource.resourceId,
      payload: {}
    });
    upsertResource(manifest, {
      ...resource,
      dirty: true,
      lastSeenAt: now
    });
  }

  manifest.lastScanAt = now;
  await writeManifest(state.config, manifest);
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

async function pushOutbox(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  const manifest = await readManifest(state.config);
  const pending = (manifest.outbox ?? []).filter((item) => item.status === "pending").slice(0, 20);
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
    item.status = "applied";
    item.appliedAt = now;
    item.updatedAt = now;
    item.attempts += 1;
    const resourceId = appliedItem.resourceId ?? extractResourceId(appliedItem.result);
    const existing = findResource(manifest, item.relativePath);
    if (item.action === "delete") {
      manifest.resources = (manifest.resources ?? []).filter((resource) => resource.relativePath !== item.relativePath);
    } else {
      upsertResource(manifest, {
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
    item.status = "failed";
    item.lastError = rejectedItem.message ?? rejectedItem.code ?? "Sync push rejected";
    item.updatedAt = now;
    item.attempts += 1;
  }
  manifest.lastPushAt = now;
  await writeManifest(state.config, manifest);
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

async function recordManifestJob(config: DaemonConfig, job: LocalJob, result: Record<string, unknown>): Promise<void> {
  const manifest = await readManifest(config);
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
  jobs.push({
    jobId: job.id,
    kind: job.kind,
    target: job.target,
    result,
    completedAt: new Date().toISOString()
  });
  manifest.jobs = jobs.slice(-500);

  const localPath = typeof result.localPath === "string" ? result.localPath : undefined;
  const relativePath = localPath && job.target === "sync-folder" ? relativeSyncPath(config, localPath) : undefined;
  if (relativePath) {
    upsertResource(manifest, {
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
      lastSeenAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString()
    });
  }

  await writeManifest(config, manifest);
}

async function processJob(state: DaemonState, job: LocalJob): Promise<void> {
  try {
    if (job.kind !== "download_artifact" && job.kind !== "download_task_attachment" && job.kind !== "materialize_resource") {
      throw new Error(`Unsupported local job kind: ${job.kind}`);
    }
    const result = await downloadJobFile(state, job);
    await recordManifestJob(state.config, job, result);
    await completeJob(state, job, result);
    state.processedJobs += 1;
  } catch (error) {
    await failJob(state, job, error);
    throw error;
  }
}

async function tick(state: DaemonState): Promise<void> {
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

function startStatusServer(state: DaemonState): void {
  if (state.config.httpPort === 0) return;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/health" || url === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
        coreUrl: state.config.coreUrl,
        syncRoot: state.config.syncRoot,
        downloadsDir: state.config.downloadsDir,
        localClientId: state.identity?.localClientId,
        lastHeartbeatAt: state.lastHeartbeatAt,
        lastClaimAt: state.lastClaimAt,
        lastScanAt: state.lastScanAt,
        lastPushAt: state.lastPushAt,
        lastError: state.lastError,
        processedJobs: state.processedJobs,
        outboxPending: state.outboxPending,
        outboxFailed: state.outboxFailed
      }, null, 2));
      return;
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
  const state: DaemonState = {
    config,
    identity: await readIdentity(config),
    processedJobs: 0,
    outboxPending: 0,
    outboxFailed: 0
  };
  startStatusServer(state);
  await tick(state);
  setInterval(() => {
    void tick(state);
  }, config.intervalMs);
}

await main();
