import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { normalizeConfiguredOrigin, type DaemonConfig } from "./config.js";
import {
  getOutboxByClientOpId,
  getRemoteResource,
  type ConflictResolution,
  type ConflictStatus,
  type OutboxItem
} from "./manifestStore.js";
import { CLIENT_OP_ID_HEADER } from "./localStore.js";
import { LocalProjectContextError } from "./projectContextCache.js";
import { ProjectContextExportError, PROJECT_CONTEXT_EXPORT_CODES } from "./projectContextExport.js";
import { CaptureError } from "./capture/index.js";
import { mimeTypeForPath, resolveSyncRootRelativePath } from "./paths.js";
import type { DaemonState, LocalArtifactItem } from "./types.js";
export async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await readRequestBuffer(req)).toString("utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

export async function readRequestText(req: IncomingMessage): Promise<string> {
  return (await readRequestBuffer(req)).toString("utf8");
}

export async function readRequestFormData(req: IncomingMessage): Promise<FormData> {
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

export function getFormDataString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseConflictStatus(value: string | null): ConflictStatus | "all" | undefined {
  if (value === "open" || value === "resolved" || value === "ignored" || value === "all") return value;
  return undefined;
}

export function parseConflictResolution(value: unknown): ConflictResolution | undefined {
  return value === "retry" || value === "ignore" || value === "close" ? value : undefined;
}

export function parseBooleanQuery(value: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

export function isDefaultLoopbackOrigin(origin: string): boolean {
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

export function setLoopbackCorsHeaders(config: DaemonConfig, req: IncomingMessage, res: ServerResponse): boolean {
  const origin = requestOrigin(req);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-workbench-daemon-token, x-workbench-client-op-id"
  );
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

export function requestHasValidLoopbackToken(
  req: IncomingMessage,
  expectedToken?: string,
  allowAnonymous = false
): boolean {
  // Fail closed: an unconfigured token must not leave the local API open, because
  // requests without an Origin header (any local process) bypass the CORS allowlist.
  if (!expectedToken) return allowAnonymous;
  const headerToken = req.headers["x-workbench-daemon-token"];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (token === expectedToken) return true;

  const authorization = req.headers.authorization;
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] === expectedToken;
}

export function requireLoopbackAuth(state: DaemonState, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (loopbackAuthBypassed(pathname, req.method)) return true;
  if (requestHasValidLoopbackToken(req, state.config.apiToken, state.config.allowAnonymousApi === true)) return true;

  writeJson(res, {
    code: LOOPBACK_AUTH_ERROR_CODE,
    message: LOOPBACK_AUTH_ERROR_MESSAGE
  }, 401);
  return false;
}

export function writeJson(res: ServerResponse, value: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value, null, 2));
}

export function requestClientOpId(req: IncomingMessage): string | undefined {
  const value = req.headers[CLIENT_OP_ID_HEADER];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function existingClientOpWriteResult(
  state: Pick<DaemonState, "manifestStore">,
  clientOpId: string
): { item: OutboxItem; result: Record<string, unknown> } | undefined {
  const item = getOutboxByClientOpId(state.manifestStore, clientOpId);
  if (!item) return undefined;
  const remote = item.resourceId
    ? getRemoteResource(state.manifestStore, item.domain, item.resourceId)
    : undefined;
  const resolved = remote?.payload ?? item.payload;
  const { contentBase64: _contentBase64, ...result } = resolved;
  return { item, result };
}

export function writeCaptureError(res: ServerResponse, error: unknown): void {
  if (error instanceof CaptureError) {
    writeJson(res, { code: error.code, message: error.message }, error.status);
    return;
  }
  writeJson(res, {
    code: "CAPTURE_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error)
  }, 400);
}

export function writeLocalProjectContextError(res: ServerResponse, error: unknown): void {
  if (error instanceof LocalProjectContextError) {
    writeJson(res, { code: error.code, message: error.message }, error.status);
    return;
  }
  writeJson(res, {
    code: "LOCAL_PROJECT_CONTEXT_READ_FAILED",
    message: error instanceof Error ? error.message : String(error)
  }, 500);
}

export function writeProjectContextExportError(res: ServerResponse, error: unknown): void {
  if (error instanceof ProjectContextExportError) {
    writeJson(res, { code: error.code, message: error.message }, error.status);
    return;
  }
  writeJson(res, {
    code: PROJECT_CONTEXT_EXPORT_CODES.writeFailed,
    message: error instanceof Error ? error.message : String(error)
  }, 500);
}

export function requestString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumberQuery(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function isLocalProjectContextMutation(pathname: string, method: string | undefined): boolean {
  if (!method || method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const cachedContextMutation = /^\/api\/projects\/[^/]+\/(brief|memories|relations|links|context-summary)(\/refresh)?$/.test(pathname)
    || /^\/api\/projects\/[^/]+\/index\/rebuild$/.test(pathname)
    || /^\/api\/project-(memories|relations|links)\/[^/]+$/.test(pathname)
    || /^\/api\/artifacts\/items\/[^/]+\/projects(?:\/[^/]+)?$/.test(pathname);
  return cachedContextMutation && !isSupportedLocalProjectContextWrite(pathname, method);
}

export function isSupportedLocalProjectContextWrite(pathname: string, method: string | undefined): boolean {
  if (method === "PUT" && /^\/api\/projects\/[^/]+\/brief$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/projects\/[^/]+\/(memories|relations)$/.test(pathname)) return true;
  if (method === "PATCH" && /^\/api\/project-(memories|relations)\/[^/]+$/.test(pathname)) return true;
  return method === "DELETE" && /^\/api\/project-relations\/[^/]+$/.test(pathname);
}

export async function sendLocalArtifactDownload(state: DaemonState, item: LocalArtifactItem, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
