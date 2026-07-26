import { createHash } from "node:crypto";
import { platform } from "node:os";
import { basename, dirname } from "node:path";
import { promises as fs } from "node:fs";
import {
  readIdentity,
  writeIdentity,
  type ClientIdentity
} from "./identityStorage.js";
import type { DaemonConfig } from "./config.js";
import {
  isPathInsideDirectory,
  normalizeSha256Checksum,
  parseContentDispositionFilename,
  sanitizeFileName,
  uniquePath
} from "./paths.js";
import { refreshManifestStats } from "./localStore.js";
import { stringFromUnknown } from "./remoteSync.js";
import type { DaemonState, LocalJob } from "./types.js";

export class CoreHttpError extends Error {
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

export async function coreJson<T>(
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

export async function heartbeat(state: DaemonState): Promise<void> {
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

export async function claimJobs(state: DaemonState): Promise<LocalJob[]> {
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

export function assertExpectedDownloadChecksum(expected: string | null, actualHex: string): void {
  const expectedHex = normalizeSha256Checksum(expected);
  if (expectedHex && expectedHex !== actualHex.toLowerCase()) {
    throw new Error("Download checksum mismatch");
  }
}

export async function downloadJobFile(state: DaemonState, job: LocalJob): Promise<{
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
