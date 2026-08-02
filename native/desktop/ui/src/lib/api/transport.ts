import {
  getWorkbenchCoreUrl,
  getWorkbenchLocalDaemonToken,
  getWorkbenchLocalDaemonUrl,
  getWorkbenchAutoLocalFallbackActive,
  getWorkbenchLocalRoutingMode,
  setWorkbenchAutoLocalFallbackActive,
  setWorkbenchLocalDaemonToken
} from "../../config/services";
import { pushErrorNotification, pushNotification } from "../notificationService";
import type {
  LocalDaemonPreferences,
  LocalDaemonStatus,
  WorkbenchAuthResponse,
  WorkbenchRefreshResponse,
  WorkbenchUserSession
} from "../../types/models";

export const SESSION_KEY = "workbench-session";
export const LOCAL_DAEMON_REQUEST_TIMEOUT_MS = 2500;
export const OFFLINE_SAVE_NOTIFICATION_DEDUPE_MS = 10000;
export const NATIVE_LOCAL_DAEMON_URL = "http://127.0.0.1:35780";
export const NATIVE_SESSION_COMMANDS = {
  save: "secure_session_save",
  read: "secure_session_read",
  clear: "secure_session_clear"
} as const;

export type RequestNotificationOptions = {
  suppressConnectionError?: boolean;
};

export type StoredAuthSession = {
  user: WorkbenchUserSession;
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
  issuedAt: string;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
    };
    __WORKBENCH_VARIANT__?: string;
  }
}

let sessionCache: StoredAuthSession | undefined;
let storageReady = false;
let storageReadyPromise: Promise<void> | undefined;

export function parseStoredSession(raw: string | null | undefined): StoredAuthSession | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredAuthSession;
    if (!parsed?.accessToken || !parsed?.user?.username) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function isTauriNativeRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

export async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriNativeRuntime()) {
    throw new Error("Not running in Tauri runtime");
  }
  return window.__TAURI_INTERNALS__!.invoke<T>(command, args);
}


export const nativeDaemonApi = {
  chooseSyncFolder: (): Promise<string | null> => invokeNative<string | null>("choose_sync_folder"),
  chooseDownloadsFolder: (): Promise<string | null> => invokeNative<string | null>("choose_downloads_folder"),
  resetSyncFolder: (): Promise<LocalDaemonPreferences> =>
    invokeNative<LocalDaemonPreferences>("reset_sync_folder"),
  resetDownloadsFolder: (): Promise<LocalDaemonPreferences> =>
    invokeNative<LocalDaemonPreferences>("reset_downloads_folder"),
  openSyncFolder: (): Promise<boolean> => invokeNative<boolean>("open_sync_folder"),
  openDownloadsFolder: (): Promise<boolean> => invokeNative<boolean>("open_downloads_folder"),
  readStatus: (port?: number): Promise<LocalDaemonStatus> =>
    invokeNative<LocalDaemonStatus>("read_daemon_status", { port: port ?? null }),
  readPreferences: (): Promise<LocalDaemonPreferences> =>
    invokeNative<LocalDaemonPreferences>("read_daemon_preferences"),
  setAutoStart: (autoStart: boolean): Promise<LocalDaemonPreferences> =>
    invokeNative<LocalDaemonPreferences>("set_daemon_auto_start", { autoStart }),
  setResidentMode: (residentMode: boolean): Promise<LocalDaemonPreferences> =>
    invokeNative<LocalDaemonPreferences>("set_daemon_resident_mode", { residentMode }),
  setCoreUrl: (coreUrl: string): Promise<LocalDaemonPreferences> =>
    invokeNative<LocalDaemonPreferences>("set_daemon_core_url", { coreUrl }),
  start: (): Promise<boolean> => invokeNative<boolean>("start_daemon"),
  stop: (): Promise<boolean> => invokeNative<boolean>("stop_daemon"),
  readApiToken: (): Promise<string | null> => invokeNative<string | null>("read_local_daemon_api_token")
};

/**
 * Teaches this webview the token the daemon expects, so local requests stop coming back 401.
 *
 * The daemon writes the token under the sync root and asks the user to paste it into
 * Settings. The desktop app knows where that is, so it reads it instead. Failure is silent
 * on purpose: no daemon has run yet on a fresh install, and that must not surface as an
 * error every time the app starts.
 */
export async function syncNativeLocalDaemonToken(): Promise<string | undefined> {
  if (!isTauriNativeRuntime()) {
    return undefined;
  }
  try {
    const token = await nativeDaemonApi.readApiToken();
    if (!token) {
      return undefined;
    }
    setWorkbenchLocalDaemonToken(token);
    return token;
  } catch {
    return undefined;
  }
}

export async function syncNativeDaemonCoreUrl(): Promise<LocalDaemonPreferences | undefined> {
  if (!isTauriNativeRuntime()) return undefined;
  const coreUrl = getWorkbenchCoreUrl();
  if (!coreUrl) return undefined;
  return nativeDaemonApi.setCoreUrl(coreUrl);
}


export function sessionFromAuthResponse(payload: WorkbenchRefreshResponse | WorkbenchAuthResponse): StoredAuthSession {
  return {
    user: payload.user,
    accessToken: payload.accessToken,
    // Browsers never hold the refresh token; the HttpOnly cookie carries it.
    refreshToken: isTauriNativeRuntime() ? payload.refreshToken : undefined,
    tokenType: "Bearer",
    expiresInSeconds: payload.expiresInSeconds,
    issuedAt: new Date().toISOString()
  };
}

/**
 * Spends the HttpOnly refresh cookie to mint a fresh access token.
 *
 * Runs on boot for browser sessions, so it must stay quiet: a signed-out
 * visitor has no cookie and the 401 here is expected, not an error worth
 * surfacing.
 */
export async function restoreSessionFromCookie(): Promise<StoredAuthSession | undefined> {
  let url: string;
  try {
    url = `${coreBaseUrl()}/auth/refresh`;
  } catch {
    return undefined;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" }
    });
    if (!response.ok) return undefined;
    return sessionFromAuthResponse(await response.json() as WorkbenchRefreshResponse);
  } catch {
    return undefined;
  }
}

export async function revokeRefreshCookie(): Promise<void> {
  try {
    await fetch(`${coreBaseUrl()}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // Signing out locally must succeed even when Core is unreachable.
  }
}

/**
 * Browser sessions keep no token in localStorage. The refresh token lives in an
 * HttpOnly cookie the page cannot read, and the short-lived access token stays
 * in memory only, so an XSS payload has nothing durable to steal. A reload
 * restores the session by spending the cookie once (see restoreSessionFromCookie).
 *
 * Native (Tauri) builds keep using OS secure storage, which is already outside
 * the page's reach and survives restarts without a network round-trip.
 */
export async function loadSessionFromStorage(): Promise<StoredAuthSession | undefined> {
  if (isTauriNativeRuntime()) {
    const raw = await invokeNative<string | null>(NATIVE_SESSION_COMMANDS.read);
    return parseStoredSession(raw);
  }
  return restoreSessionFromCookie();
}

export async function persistSessionToStorage(session: StoredAuthSession): Promise<void> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>(NATIVE_SESSION_COMMANDS.save, { sessionJson: JSON.stringify(session) });
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  // Drop any session written by a previous build that stored tokens here.
  localStorage.removeItem(SESSION_KEY);
}

export async function clearSessionFromStorage(): Promise<void> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>(NATIVE_SESSION_COMMANDS.clear);
  } else {
    await revokeRefreshCookie();
  }
  localStorage.removeItem(SESSION_KEY);
}

export async function initializeSessionStorage(): Promise<void> {
  if (storageReady) return;
  if (!storageReadyPromise) {
    storageReadyPromise = (async () => {
      sessionCache = await loadSessionFromStorage();
      storageReady = true;
    })().finally(() => {
      storageReadyPromise = undefined;
    });
  }
  await storageReadyPromise;
}

export function readStoredSession(): StoredAuthSession | undefined {
  return sessionCache;
}

export function coreBaseUrl(): string {
  const configuredUrl = getWorkbenchCoreUrl();
  if (!configuredUrl) {
    throw new Error("Workbench Core URL is not configured. Set it on the sign-in or sign-up page.");
  }
  return configuredUrl;
}

export function localDaemonBaseUrl(): string {
  if (isTauriNativeRuntime()) {
    return NATIVE_LOCAL_DAEMON_URL;
  }
  const configuredUrl = getWorkbenchLocalDaemonUrl();
  if (!configuredUrl) {
    throw new Error("Workbench local daemon URL is not configured.");
  }
  return configuredUrl;
}

export function sessionAuthHeaders(extra?: HeadersInit): HeadersInit {
  const session = readStoredSession();
  const headers = new Headers(extra);
  if (session && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${session.accessToken}`);
  }
  return headers;
}

export function localDaemonHeaders(extra?: HeadersInit): HeadersInit {
  const headers = new Headers(extra);
  const token = getWorkbenchLocalDaemonToken();
  if (token) {
    headers.set("x-workbench-daemon-token", token);
  }
  return headers;
}

export type ApiBackend = "core" | "local";

export class ApiError extends Error {
  status?: number;
  code?: string;
  backend: ApiBackend;
  method: string;
  path: string;
  url: string;
  responseBody?: string;
  responseMessage?: string;
  networkFailure: boolean;

  constructor(options: {
    backend: ApiBackend;
    method: string;
    path: string;
    url: string;
    detail: string;
    status?: number;
    code?: string;
    responseBody?: string;
    responseMessage?: string;
    networkFailure?: boolean;
  }) {
    const statusPart = options.status == null ? "" : `, ${options.status}`;
    super(`(${options.backend} ${options.method} ${options.path}${statusPart}): ${options.detail}`);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.backend = options.backend;
    this.method = options.method;
    this.path = options.path;
    this.url = options.url;
    this.responseBody = options.responseBody;
    this.responseMessage = options.responseMessage;
    this.networkFailure = options.networkFailure === true;
  }
}

export function formatApiErrorMessage(action: string, error: unknown): string {
  if (error instanceof ApiError) {
    return `${action} ${error.message}`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `${action}: ${detail}`;
}

export function requestMethod(options?: RequestInit): string {
  return (options?.method || "GET").toUpperCase();
}

export function requestPath(url: string): string {
  try {
    const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function logApiFailure(error: ApiError): void {
  console.error(`[api] ${error.backend} ${error.method} ${error.url} failed`, {
    status: error.status,
    responseBody: error.responseBody,
    error
  });
}

export function connectionApiError(backend: ApiBackend, url: string, options: RequestInit | undefined, detail: string): ApiError {
  const error = new ApiError({
    backend,
    method: requestMethod(options),
    path: requestPath(url),
    url,
    detail: `Connection failed: ${detail}`,
    networkFailure: true
  });
  logApiFailure(error);
  return error;
}

export async function responseApiError(
  backend: ApiBackend,
  url: string,
  options: RequestInit | undefined,
  response: Response
): Promise<ApiError> {
  const responseBody = await response.text();
  let parsed: { message?: string; code?: string } | undefined;
  try {
    parsed = responseBody ? JSON.parse(responseBody) as { message?: string; code?: string } : undefined;
  } catch {
    parsed = undefined;
  }
  const responseMessage = typeof parsed?.message === "string" && parsed.message.trim()
    ? parsed.message.trim()
    : undefined;
  const fallback = responseBody
    ? (looksLikeHtmlResponse(responseBody)
      ? normalizeHtmlErrorMessage(responseBody, response.status, url)
      : responseBody)
    : `Request failed: ${response.status}`;
  const error = new ApiError({
    backend,
    method: requestMethod(options),
    path: requestPath(url),
    url,
    status: response.status,
    code: parsed?.code,
    responseBody,
    responseMessage,
    detail: responseMessage ?? fallback
  });
  logApiFailure(error);
  return error;
}

export function isAuthRefreshRoute(url: string): boolean {
  return url.endsWith("/auth/refresh");
}

export function looksLikeHtmlResponse(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith("<!doctype html") || normalized.startsWith("<html");
}

export function normalizeHtmlErrorMessage(text: string, status: number, url: string): string {
  const cannotGetMatch = text.match(/Cannot\s+GET\s+([^\s<]+)/i);
  if (cannotGetMatch?.[1]) {
    return `Endpoint not available (HTTP ${status}): ${cannotGetMatch[1]}`;
  }

  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const title = titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (title) {
      return `Service error (HTTP ${status}) for ${url}: ${title}`;
    }
  }

  return `Service returned an HTML error page (HTTP ${status}) for ${url}`;
}

export function isDeepResearchHistoryRoute(url: string): boolean {
  return /\/api\/deep-research\/jobs(?:\?|$)/.test(url);
}

export async function requestJson<T>(
  url: string,
  options?: RequestInit,
  withSessionAuth = true,
  notificationOptions: RequestNotificationOptions = {}
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(withSessionAuth ? sessionAuthHeaders(options?.headers) : options?.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    response = await fetch(url, {
      ...options,
      headers
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    const apiError = connectionApiError("core", url, options, detail);
    if (!notificationOptions.suppressConnectionError) {
      pushErrorNotification(apiError.message, "Connection Error");
    }
    throw apiError;
  }

  if (!response.ok) {
    const apiError = await responseApiError("core", url, options, response);
    let shouldNotify = !(response.status === 401 && !isAuthRefreshRoute(url));
    if (response.status === 404 && isDeepResearchHistoryRoute(url)) {
      // Backward compatibility: old core may not expose history endpoint yet.
      shouldNotify = false;
    }
    if (apiError.responseMessage) {
        if (apiError.code === "LBS_UNREACHABLE" && response.status !== 401) {
          if (shouldNotify) {
            pushErrorNotification(
              "Tasks backend (LBS) is unreachable. Please start/check LBS and retry.",
              "Tasks Service Error"
            );
          }
          throw apiError;
        }
        if (shouldNotify) {
          pushErrorNotification(apiError.responseMessage, "Service Error");
        }
        throw apiError;
    }
    if (shouldNotify) {
      pushErrorNotification(apiError.message, "Service Error");
    }
    throw apiError;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const responseText = await response.text();
  if (!responseText.trim()) {
    return undefined as T;
  }
  try {
    return JSON.parse(responseText) as T;
  } catch {
    const normalized = responseText.trim().toLowerCase();
    const isHtml = normalized.startsWith("<!doctype html") || normalized.startsWith("<html");
    const message = isHtml
      ? `Service returned an HTML error page instead of JSON for ${url}`
      : `Service returned invalid JSON for ${url}`;
    pushErrorNotification(message, "Service Error");
    const error = new ApiError({
      backend: "core",
      method: requestMethod(options),
      path: requestPath(url),
      url,
      status: response.status,
      responseBody: responseText,
      detail: message
    });
    logApiFailure(error);
    throw error;
  }
}


export async function requestLocalDaemon(path: string, options?: RequestInit): Promise<Response> {
  const url = `${localDaemonBaseUrl()}${path}`;
  const { signal: upstreamSignal, ...requestOptions } = options ?? {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCAL_DAEMON_REQUEST_TIMEOUT_MS);
  const onUpstreamAbort = () => controller.abort();
  if (upstreamSignal?.aborted) {
    controller.abort();
  } else {
    upstreamSignal?.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...requestOptions,
      headers: localDaemonHeaders(requestOptions.headers),
      signal: controller.signal
    });
  } catch (error) {
    const detail = controller.signal.aborted
      ? `timeout after ${LOCAL_DAEMON_REQUEST_TIMEOUT_MS}ms`
      : error instanceof Error
        ? error.message
        : "network error";
    throw connectionApiError("local", url, options, detail);
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", onUpstreamAbort);
  }

  return response;
}

export async function requestLocalDaemonJson<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await requestLocalDaemon(path, {
    ...options,
    headers
  });
  if (!response.ok) {
    throw await responseApiError("local", `${localDaemonBaseUrl()}${path}`, options, response);
  }
  const text = await response.text();
  if (!text.trim()) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const url = `${localDaemonBaseUrl()}${path}`;
    const error = new ApiError({
      backend: "local",
      method: requestMethod(options),
      path: requestPath(url),
      url,
      status: response.status,
      responseBody: text,
      detail: `Local daemon returned invalid JSON for ${path}`
    });
    logApiFailure(error);
    throw error;
  }
}

export function isReadRequest(options?: RequestInit): boolean {
  const method = requestMethod(options);
  return method === "GET" || method === "HEAD";
}

export const CLIENT_OP_ID_HEADER = "x-workbench-client-op-id";

export function withFacadeClientOpId(options?: RequestInit): RequestInit | undefined {
  if (isReadRequest(options)) return options;
  const headers = new Headers(options?.headers);
  headers.set(CLIENT_OP_ID_HEADER, crypto.randomUUID());
  return { ...options, headers };
}

export const LOCAL_DAEMON_WRITE_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/notes$/ },
  { method: "PATCH", path: /^\/api\/notes\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/notes\/[^/]+$/ },
  { method: "POST", path: /^\/api\/artifacts\/(folders|notes|upload)$/ },
  { method: "PATCH", path: /^\/api\/artifacts\/items\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/artifacts\/items\/[^/]+$/ },
  { method: "POST", path: /^\/api\/projects$/ },
  { method: "PATCH", path: /^\/api\/projects\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/projects\/[^/]+$/ },
  { method: "PUT", path: /^\/api\/projects\/default$/ },
  { method: "PUT", path: /^\/api\/projects\/[^/]+\/brief$/ },
  { method: "POST", path: /^\/api\/projects\/[^/]+\/memories$/ },
  { method: "PATCH", path: /^\/api\/project-memories\/[^/]+$/ },
  { method: "POST", path: /^\/api\/projects\/[^/]+\/relations$/ },
  { method: "PATCH", path: /^\/api\/project-relations\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/project-relations\/[^/]+$/ },
  { method: "POST", path: /^\/api\/tasks$/ },
  { method: "PATCH", path: /^\/api\/tasks\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/tasks\/[^/]+$/ },
  { method: "PUT", path: /^\/api\/tasks\/[^/]+\/pin$/ },
  { method: "POST", path: /^\/api\/tasks\/today$/ },
  { method: "DELETE", path: /^\/api\/tasks\/today\/[^/]+$/ },
  { method: "PUT", path: /^\/api\/tasks\/schedule-items\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/tasks\/schedule-items\/[^/]+$/ },
  { method: "POST", path: /^\/api\/tasks\/[^/]+\/occurrences\/(complete|move|skip-exception)$/ },
  { method: "POST", path: /^\/api\/tasks\/import$/ },
  { method: "POST", path: /^\/api\/tasks\/[^/]+\/attachments$/ },
  { method: "PUT", path: /^\/api\/tasks\/[^/]+\/attachments\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/tasks\/[^/]+\/attachments\/[^/]+$/ },
  { method: "POST", path: /^\/api\/tasks\/[^/]+\/occurrences\/[^/]+\/subtasks$/ },
  { method: "PATCH", path: /^\/api\/tasks\/[^/]+\/occurrences\/[^/]+\/subtasks\/[^/]+$/ },
  { method: "DELETE", path: /^\/api\/tasks\/[^/]+\/occurrences\/[^/]+\/subtasks\/[^/]+$/ }
];

export function localDaemonSupportsWriteRequest(path: string, options?: RequestInit): boolean {
  const pathname = path.split("?", 1)[0];
  const method = requestMethod(options);
  return LOCAL_DAEMON_WRITE_ROUTES.some((route) => route.method === method && route.path.test(pathname));
}

export function requestCanUseLocalDaemon(path: string, options?: RequestInit): boolean {
  return isReadRequest(options) || localDaemonSupportsWriteRequest(path, options);
}

export function browserReportsOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

export function autoRoutingCanFallbackToLocal(error: unknown, path: string, options?: RequestInit): boolean {
  if (getWorkbenchLocalRoutingMode() !== "auto") return false;
  if (!requestCanUseLocalDaemon(path, options)) return false;
  if (options?.signal?.aborted) return false;
  return error instanceof ApiError && error.backend === "core" && error.networkFailure;
}

export function facadeRoutesToLocal(path: string, options?: RequestInit): boolean {
  const mode = getWorkbenchLocalRoutingMode();
  if (mode === "local") return true;
  return mode === "auto"
    && requestCanUseLocalDaemon(path, options)
    && (getWorkbenchAutoLocalFallbackActive() || !browserReportsOnline());
}

let lastOfflineSaveNotificationAt: number | undefined;

export function markSuccessfulLocalRequest(options?: RequestInit): void {
  const mode = getWorkbenchLocalRoutingMode();
  if (mode === "auto") {
    setWorkbenchAutoLocalFallbackActive(true);
  }
  if (isReadRequest(options)) return;
  if (mode !== "auto") return;

  const now = Date.now();
  const elapsed = lastOfflineSaveNotificationAt === undefined ? undefined : now - lastOfflineSaveNotificationAt;
  if (elapsed !== undefined && elapsed >= 0 && elapsed < OFFLINE_SAVE_NOTIFICATION_DEDUPE_MS) return;
  lastOfflineSaveNotificationAt = now;
  pushNotification({
    title: "Offline Save",
    message: "Saved locally. Changes will sync when the server is reachable.",
    level: "info"
  });
}

export function markSuccessfulCoreRequest(): void {
  if (getWorkbenchLocalRoutingMode() === "auto") {
    setWorkbenchAutoLocalFallbackActive(false);
  }
}

export function artifactsFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

export function notesFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

export function projectsFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

export function tasksFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

export function coreArtifactPath(path: string): string {
  return `${coreBaseUrl()}${path}`;
}

export function coreApiPath(path: string): string {
  return `${coreBaseUrl()}${path}`;
}


export async function requestFacade(
  path: string,
  options: RequestInit | undefined,
  corePath: (path: string) => string
): Promise<Response> {
  const requestOptions = withFacadeClientOpId(options);
  if (facadeRoutesToLocal(path, requestOptions)) {
    const response = await requestLocalDaemon(path, requestOptions);
    if (!response.ok) {
      throw await responseApiError("local", `${localDaemonBaseUrl()}${path}`, requestOptions, response);
    }
    markSuccessfulLocalRequest(requestOptions);
    return response;
  }
  try {
    const response = await fetchWithSessionAuth(corePath(path), requestOptions, {
      suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto"
    });
    markSuccessfulCoreRequest();
    return response;
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, path, requestOptions)) {
      const response = await requestLocalDaemon(path, requestOptions);
      if (!response.ok) {
        throw await responseApiError("local", `${localDaemonBaseUrl()}${path}`, requestOptions, response);
      }
      markSuccessfulLocalRequest(requestOptions);
      return response;
    }
    throw error;
  }
}

export async function requestArtifactFacade(path: string, options?: RequestInit): Promise<Response> {
  return requestFacade(path, options, coreArtifactPath);
}

export async function requestTasksFacade(path: string, options?: RequestInit): Promise<Response> {
  return requestFacade(path, options, coreApiPath);
}

export async function fetchArtifactFacadeBlob(path: string): Promise<Blob> {
  const response = await requestArtifactFacade(path);
  return response.blob();
}

export async function fetchFacadeJson<T>(
  path: string,
  options: RequestInit | undefined,
  corePath: (path: string) => string
): Promise<T> {
  const requestOptions = withFacadeClientOpId(options);
  if (facadeRoutesToLocal(path, requestOptions)) {
    const result = await requestLocalDaemonJson<T>(path, requestOptions);
    markSuccessfulLocalRequest(requestOptions);
    return result;
  }
  try {
    const result = await fetchJson<T>(corePath(path), requestOptions, {
      suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto"
    });
    markSuccessfulCoreRequest();
    return result;
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, path, requestOptions)) {
      const result = await requestLocalDaemonJson<T>(path, requestOptions);
      markSuccessfulLocalRequest(requestOptions);
      return result;
    }
    throw error;
  }
}

export async function fetchArtifactFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreArtifactPath);
}

export async function fetchNotesFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreApiPath);
}

export async function fetchProjectsFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreApiPath);
}

export async function fetchTasksFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreApiPath);
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function filenameFromDisposition(disposition: string | null, fallback: string): string {
  const value = disposition ?? "";
  const utf8Match = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const quotedMatch = value.match(/filename\s*=\s*"([^"]+)"/i);
  return utf8Match?.[1]
    ? decodeURIComponent(utf8Match[1])
    : (quotedMatch?.[1] ?? fallback);
}

/**
 * Native builds can only refresh with a token from secure storage. Browsers
 * always can: the HttpOnly cookie is invisible here, so the attempt itself is
 * the only way to find out whether a session is still alive.
 */

export function canAttemptRefresh(session: StoredAuthSession | undefined): boolean {
  return isTauriNativeRuntime() ? Boolean(session?.refreshToken) : true;
}

export async function refreshAccessToken(refreshToken?: string): Promise<void> {
  const refreshed = await requestJson<WorkbenchRefreshResponse>(
    `${coreBaseUrl()}/auth/refresh`,
    {
      method: "POST",
      // Browsers send nothing: Core reads the HttpOnly cookie instead.
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: refreshToken ? JSON.stringify({ refreshToken }) : undefined
    },
    false
  );
  await saveWorkbenchSession(refreshed);
}

export async function fetchJson<T>(
  url: string,
  options?: RequestInit,
  notificationOptions: RequestNotificationOptions = {}
): Promise<T> {
  await initializeSessionStorage();
  try {
    const result = await requestJson<T>(url, options, true, notificationOptions);
    markSuccessfulCoreRequest();
    return result;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || isAuthRefreshRoute(url)) {
      throw error;
    }

    const session = readStoredSession();
    if (!canAttemptRefresh(session)) {
      throw error;
    }

    try {
      await refreshAccessToken(session?.refreshToken);
      const result = await requestJson<T>(url, options, true, notificationOptions);
      markSuccessfulCoreRequest();
      return result;
    } catch {
      await clearWorkbenchSession();
      throw error;
    }
  }
}

export async function fetchWithSessionAuth(
  url: string,
  options?: RequestInit,
  notificationOptions: RequestNotificationOptions = {}
): Promise<Response> {
  await initializeSessionStorage();

  const requestOnce = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        ...options,
        headers: sessionAuthHeaders(options?.headers)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network error";
      const apiError = connectionApiError("core", url, options, detail);
      if (!notificationOptions.suppressConnectionError) {
        pushErrorNotification(apiError.message, "Connection Error");
      }
      throw apiError;
    }
  };

  let response = await requestOnce();
  if (response.status === 401 && !isAuthRefreshRoute(url)) {
    const session = readStoredSession();
    if (canAttemptRefresh(session)) {
      try {
        await refreshAccessToken(session?.refreshToken);
        response = await requestOnce();
      } catch {
        await clearWorkbenchSession();
      }
    }
  }
  if (!response.ok) {
    throw await responseApiError("core", url, options, response);
  }
  markSuccessfulCoreRequest();
  return response;
}


export async function saveWorkbenchSession(session: WorkbenchAuthResponse | WorkbenchRefreshResponse): Promise<void> {
  const stored = sessionFromAuthResponse(session);
  sessionCache = stored;
  await persistSessionToStorage(stored);
  try {
    await syncNativeDaemonCoreUrl();
  } catch (error) {
    console.warn("Failed to sync native daemon Core URL", error);
  }
}

export async function clearWorkbenchSession(): Promise<void> {
  sessionCache = undefined;
  await clearSessionFromStorage();
}

export function readWorkbenchSession(): WorkbenchUserSession | undefined {
  return readStoredSession()?.user;
}
