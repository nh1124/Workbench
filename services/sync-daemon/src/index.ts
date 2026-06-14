import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
};

type DaemonState = {
  config: DaemonConfig;
  identity?: ClientIdentity;
  lastHeartbeatAt?: string;
  lastClaimAt?: string;
  lastError?: string;
  processedJobs: number;
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
    httpPort: Number.isFinite(httpPortRaw) ? Math.max(0, httpPortRaw) : 35780
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

async function heartbeat(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  await coreJson(state.config, `/api/local-clients/${encodeURIComponent(state.identity.localClientId)}/heartbeat`, {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      daemonVersion: "0.1.0",
      syncRootState: {
        syncRoot: state.config.syncRoot,
        downloadsDir: state.config.downloadsDir,
        processedJobs: state.processedJobs
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
  const manifest = (await readJsonFile<{ jobs?: unknown[] }>(manifestPath(config))) ?? {};
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
  jobs.push({
    jobId: job.id,
    kind: job.kind,
    target: job.target,
    result,
    completedAt: new Date().toISOString()
  });
  await writeJsonFile(manifestPath(config), { ...manifest, jobs: jobs.slice(-500) });
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
    await heartbeat(state);
    const jobs = await claimJobs(state);
    for (const job of jobs) {
      await processJob(state, job);
    }
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
        lastError: state.lastError,
        processedJobs: state.processedJobs
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
    processedJobs: 0
  };
  startStatusServer(state);
  await tick(state);
  setInterval(() => {
    void tick(state);
  }, config.intervalMs);
}

await main();
