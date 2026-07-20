import {
  getWorkbenchCoreUrl,
  getWorkbenchLocalDaemonToken,
  getWorkbenchLocalDaemonUrl,
  getWorkbenchAutoLocalFallbackActive,
  getWorkbenchLocalRoutingMode,
  setWorkbenchAutoLocalFallbackActive
} from "../config/services";
import {
  getNativeGlobalShortcutRegistrations,
  type ShortcutBindings
} from "./keyboardShortcuts";
import { pushErrorNotification, pushNotification } from "./notificationService";
import { buildProjectIndexQuery, buildProjectMemoryQuery } from "../projects/projectContextQueries";
import { normalizeDateKey } from "../tasks/lib/taskOccurrenceIdentity";
import type {
  AnalyserActivityAggregate,
  AnalyserAutomationPolicy,
  AnalyserAutomationPolicyRecord,
  AnalyserCollectionPolicyRecord,
  AnalyserCollectionSettingsOverride,
  AnalyserExportInput,
  AnalyserExportResult,
  AnalyserMachineRecord,
  AnalyserObservationRecord,
  AnalyserObservationSource,
  AnalyserOperationKind,
  AnalyserOperationRecord,
  AnalyserProposalListItem,
  AnalyserProposalRecord,
  AnalyserProposalStatus,
  AnalyserProjectorFlushResult,
  AnalyserPublicationRecord,
  AnalyserRoutineRecord,
  AnalyserRoutineStatusSummary,
  AnalyserSettingsResult,
  AnalyserStatusResult,
  AnalyserSummaryListItem,
  AnalyserSummaryRecord,
  Artifact,
  ArtifactProjectMembershipsResult,
  DeepResearchCancelResponse,
  DeepResearchDefaultsResponse,
  DeepResearchHistoryEntry,
  DeepResearchRunResponse,
  DeepResearchStatusResponse,
  ImageAssetRecord,
  ImageContextRef,
  ImageDefaultsResponse,
  ImageIntent,
  ImageJobRecord,
  ImageProvider,
  ImageQuality,
  ImageReferenceRecord,
  ImageSize,
  ArtifactItem,
  ArtifactProjectSummary,
  CaptureDaemonConfig,
  CaptureDaemonConfigPatch,
  CaptureDaemonState,
  CaptureSummaryListResult,
  CaptureSummaryRecord,
  CaptureSummaryResult,
  CaptureScreenshotListResult,
  IntegrationManifest,
  LocalClientAuditEventRecord,
  LocalClientRecord,
  LocalDaemonConflictRecord,
  LocalDaemonPendingJobConfirmation,
  LocalDaemonPreferences,
  LocalDaemonStatus,
  LocalJobRecord,
  LocalJobResultRecord,
  MindmapArtifactSaveResponse,
  MindmapCreateInput,
  MindmapDocument,
  MindmapExportContent,
  MindmapExportFormat,
  MindmapListResult,
  MindmapMode,
  MindmapUpdateInput,
  Note,
  NoteProjectSummary,
  ProjectDefaultSelection,
  ProjectBriefRecord,
  ProjectContextPack,
  ProjectContextSummary,
  ProjectDeletionImpact,
  ProjectIndexListResult,
  ProjectLinkListResult,
  ProjectLinkRecord,
  ProjectListResult,
  ProjectMemoryAuthority,
  ProjectMemoryEntry,
  ProjectMemoryKind,
  ProjectMemoryListResult,
  ProjectMemoryStatus,
  ProjectRecord,
  ProjectRelation,
  ProjectRelationDirectionality,
  ProjectRelationListResult,
  ProjectRelationType,
  ServiceHealth,
  ServiceProvisioningState,
  StoredIntegrationConfig,
  Task,
  TaskAttachment,
  TaskHistoryEntry,
  TaskProjectSummary,
  TaskScheduleDay,
  TaskStatus,
  TaskSubtask,
  TodayTask,
  ScheduleItem,
  ScheduleCalendarDay,
  WbsArtifactSaveResponse,
  WbsCreateItemInput,
  WbsCreatePlanInput,
  WbsDependency,
  WbsExportContent,
  WbsExportFormat,
  WbsItem,
  WbsMoveItemInput,
  WbsPlan,
  WbsPlanListResult,
  WbsUpdateItemInput,
  WbsUpdatePlanInput,
  WorkbenchAuthResponse,
  WorkbenchRefreshResponse,
  WorkbenchUserSession
} from "../types/models";

const SESSION_KEY = "workbench-session";
const LOCAL_DAEMON_REQUEST_TIMEOUT_MS = 2500;
const OFFLINE_SAVE_NOTIFICATION_DEDUPE_MS = 10000;
const NATIVE_LOCAL_DAEMON_URL = "http://127.0.0.1:35780";
const NATIVE_SESSION_COMMANDS = {
  save: "secure_session_save",
  read: "secure_session_read",
  clear: "secure_session_clear"
} as const;

type RequestNotificationOptions = {
  suppressConnectionError?: boolean;
};

type StoredAuthSession = {
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
  }
}

let sessionCache: StoredAuthSession | undefined;
let storageReady = false;
let storageReadyPromise: Promise<void> | undefined;

function parseStoredSession(raw: string | null | undefined): StoredAuthSession | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredAuthSession;
    if (!parsed?.accessToken || !parsed?.user?.username) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isTauriNativeRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.__TAURI_INTERNALS__?.invoke === "function";
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriNativeRuntime()) {
    throw new Error("Not running in Tauri runtime");
  }
  return window.__TAURI_INTERNALS__!.invoke<T>(command, args);
}

export async function closeQuickNoteWindow(): Promise<void> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>("close_quick_note_window");
    return;
  }
  if (typeof window !== "undefined") {
    window.close();
  }
}

export async function openQuickNoteWindow(): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("open_quick_note_window");
  return true;
}

export async function openCalendarWindow(url: string): Promise<boolean> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>("open_calendar_window", { url });
    return true;
  }
  if (typeof window === "undefined") return false;
  const calendarWindow = window.open(url, "workbench-calendar", "width=1100,height=800");
  calendarWindow?.focus();
  return calendarWindow !== null;
}

export async function openMainWindow(): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("open_main_window");
  return true;
}

export async function syncNativeGlobalShortcuts(bindings: ShortcutBindings): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("set_global_shortcuts", {
    shortcuts: getNativeGlobalShortcutRegistrations(bindings)
  });
  return true;
}

/**
 * Open a native Save-As dialog and write the blob to the chosen path.
 * Only available in Tauri desktop runtime. Returns true if saved, false if cancelled.
 * Falls back to browser download when not running in Tauri.
 */
export async function saveFileWithDialog(blob: Blob, defaultName: string): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  return invokeNative<boolean>("save_file_with_dialog", { bytes, defaultName });
}

/**
 * Save a temporary file and ask the OS to open it with the default associated app.
 * Intended for editing Office documents in their native editor from desktop runtime.
 */
export async function openFileWithDefaultApp(blob: Blob, defaultName: string): Promise<boolean> {
  if (isTauriNativeRuntime()) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(arrayBuffer));
    return invokeNative<boolean>("open_file_in_os_app", { bytes, defaultName });
  }

  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

export { isTauriNativeRuntime };

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
  stop: (): Promise<boolean> => invokeNative<boolean>("stop_daemon")
};

export async function syncNativeDaemonCoreUrl(): Promise<LocalDaemonPreferences | undefined> {
  if (!isTauriNativeRuntime()) return undefined;
  const coreUrl = getWorkbenchCoreUrl();
  if (!coreUrl) return undefined;
  return nativeDaemonApi.setCoreUrl(coreUrl);
}

async function loadSessionFromStorage(): Promise<StoredAuthSession | undefined> {
  if (isTauriNativeRuntime()) {
    const raw = await invokeNative<string | null>(NATIVE_SESSION_COMMANDS.read);
    return parseStoredSession(raw);
  }
  return parseStoredSession(localStorage.getItem(SESSION_KEY));
}

async function persistSessionToStorage(session: StoredAuthSession): Promise<void> {
  const serialized = JSON.stringify(session);
  if (isTauriNativeRuntime()) {
    await invokeNative<void>(NATIVE_SESSION_COMMANDS.save, { sessionJson: serialized });
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, serialized);
}

async function clearSessionFromStorage(): Promise<void> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>(NATIVE_SESSION_COMMANDS.clear);
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

function readStoredSession(): StoredAuthSession | undefined {
  return sessionCache;
}

function coreBaseUrl(): string {
  const configuredUrl = getWorkbenchCoreUrl();
  if (!configuredUrl) {
    throw new Error("Workbench Core URL is not configured. Set it on the sign-in or sign-up page.");
  }
  return configuredUrl;
}

function localDaemonBaseUrl(): string {
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

function localDaemonHeaders(extra?: HeadersInit): HeadersInit {
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

function requestMethod(options?: RequestInit): string {
  return (options?.method || "GET").toUpperCase();
}

function requestPath(url: string): string {
  try {
    const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function logApiFailure(error: ApiError): void {
  console.error(`[api] ${error.backend} ${error.method} ${error.url} failed`, {
    status: error.status,
    responseBody: error.responseBody,
    error
  });
}

function connectionApiError(backend: ApiBackend, url: string, options: RequestInit | undefined, detail: string): ApiError {
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

async function responseApiError(
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

function isAuthRefreshRoute(url: string): boolean {
  return url.endsWith("/auth/refresh");
}

function looksLikeHtmlResponse(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.startsWith("<!doctype html") || normalized.startsWith("<html");
}

function normalizeHtmlErrorMessage(text: string, status: number, url: string): string {
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

function isDeepResearchHistoryRoute(url: string): boolean {
  return /\/api\/deep-research\/jobs(?:\?|$)/.test(url);
}

async function requestJson<T>(
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

async function requestLocalDaemon(path: string, options?: RequestInit): Promise<Response> {
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

async function requestLocalDaemonJson<T>(path: string, options?: RequestInit): Promise<T> {
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

function isReadRequest(options?: RequestInit): boolean {
  const method = requestMethod(options);
  return method === "GET" || method === "HEAD";
}

const CLIENT_OP_ID_HEADER = "x-workbench-client-op-id";

function withFacadeClientOpId(options?: RequestInit): RequestInit | undefined {
  if (isReadRequest(options)) return options;
  const headers = new Headers(options?.headers);
  headers.set(CLIENT_OP_ID_HEADER, crypto.randomUUID());
  return { ...options, headers };
}

const LOCAL_DAEMON_WRITE_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
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

function requestCanUseLocalDaemon(path: string, options?: RequestInit): boolean {
  return isReadRequest(options) || localDaemonSupportsWriteRequest(path, options);
}

function browserReportsOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

export function autoRoutingCanFallbackToLocal(error: unknown, path: string, options?: RequestInit): boolean {
  if (getWorkbenchLocalRoutingMode() !== "auto") return false;
  if (!requestCanUseLocalDaemon(path, options)) return false;
  if (options?.signal?.aborted) return false;
  return error instanceof ApiError && error.backend === "core" && error.networkFailure;
}

function facadeRoutesToLocal(path: string, options?: RequestInit): boolean {
  const mode = getWorkbenchLocalRoutingMode();
  if (mode === "local") return true;
  return mode === "auto"
    && requestCanUseLocalDaemon(path, options)
    && (getWorkbenchAutoLocalFallbackActive() || !browserReportsOnline());
}

let lastOfflineSaveNotificationAt: number | undefined;

function markSuccessfulLocalRequest(options?: RequestInit): void {
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

function markSuccessfulCoreRequest(): void {
  if (getWorkbenchLocalRoutingMode() === "auto") {
    setWorkbenchAutoLocalFallbackActive(false);
  }
}

function artifactsFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

function notesFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

function projectsFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

function tasksFacadeEnabled(path: string, options?: RequestInit): boolean {
  return facadeRoutesToLocal(path, options);
}

function coreArtifactPath(path: string): string {
  return `${coreBaseUrl()}${path}`;
}

export function coreApiPath(path: string): string {
  return `${coreBaseUrl()}${path}`;
}

async function requestFacade(
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

async function requestArtifactFacade(path: string, options?: RequestInit): Promise<Response> {
  return requestFacade(path, options, coreArtifactPath);
}

async function requestTasksFacade(path: string, options?: RequestInit): Promise<Response> {
  return requestFacade(path, options, coreApiPath);
}

async function fetchArtifactFacadeBlob(path: string): Promise<Blob> {
  const response = await requestArtifactFacade(path);
  return response.blob();
}

async function fetchFacadeJson<T>(
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

async function fetchArtifactFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreArtifactPath);
}

async function fetchNotesFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreApiPath);
}

async function fetchProjectsFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreApiPath);
}

async function fetchTasksFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchFacadeJson<T>(path, options, coreApiPath);
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  const value = disposition ?? "";
  const utf8Match = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const quotedMatch = value.match(/filename\s*=\s*"([^"]+)"/i);
  return utf8Match?.[1]
    ? decodeURIComponent(utf8Match[1])
    : (quotedMatch?.[1] ?? fallback);
}

async function refreshAccessToken(refreshToken: string): Promise<void> {
  const refreshed = await requestJson<WorkbenchRefreshResponse>(
    `${coreBaseUrl()}/auth/refresh`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ refreshToken })
    },
    false
  );
  await saveWorkbenchSession(refreshed);
}

async function fetchJson<T>(
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
    if (!session?.refreshToken) {
      throw error;
    }

    try {
      await refreshAccessToken(session.refreshToken);
      const result = await requestJson<T>(url, options, true, notificationOptions);
      markSuccessfulCoreRequest();
      return result;
    } catch {
      await clearWorkbenchSession();
      throw error;
    }
  }
}

async function fetchWithSessionAuth(
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
    if (session?.refreshToken) {
      try {
        await refreshAccessToken(session.refreshToken);
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

export const notesApi = {
  list: (projectId?: string, limit?: number): Promise<Note[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return fetchNotesFacadeJson<Note[]>(`/api/notes${query ? `?${query}` : ""}`);
  },
  get: (id: string): Promise<Note> => fetchNotesFacadeJson<Note>(`/api/notes/${encodeURIComponent(id)}`),
  create: (payload: Omit<Note, "id" | "createdAt" | "updatedAt">): Promise<Note> =>
    fetchNotesFacadeJson<Note>("/api/notes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Note, "id" | "createdAt" | "updatedAt">>
  ): Promise<Note> =>
    fetchNotesFacadeJson<Note>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchNotesFacadeJson<void>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<NoteProjectSummary[]> => fetchNotesFacadeJson<NoteProjectSummary[]>("/api/notes/projects")
};

function analyserApiUrl(path: string, query: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return coreApiPath(`/api/analyser${path}${encoded ? `?${encoded}` : ""}`);
}

export const analyserApi = {
  status: (): Promise<AnalyserStatusResult> =>
    fetchJson(analyserApiUrl("/status")),
  machines: (): Promise<{ items: AnalyserMachineRecord[] }> =>
    fetchJson(analyserApiUrl("/machines")),
  settings: (): Promise<AnalyserSettingsResult> =>
    fetchJson(analyserApiUrl("/settings")),
  updateCollectionPolicy: (body: {
    machineId?: string | null;
    settings: AnalyserCollectionSettingsOverride;
    expectedVersion?: number;
  }): Promise<AnalyserCollectionPolicyRecord> =>
    fetchJson(analyserApiUrl("/settings/collection"), {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  updateAutomationPolicy: (body: {
    policy: AnalyserAutomationPolicy;
    expectedVersion?: number;
  }): Promise<AnalyserAutomationPolicyRecord> =>
    fetchJson(analyserApiUrl("/settings/automation"), {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  observations: (query: {
    source?: AnalyserObservationSource;
    machineId?: string;
    projectId?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserObservationRecord[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/observations", query)),
  activityAggregate: (query: {
    from: string;
    to: string;
    machineId?: string;
  }): Promise<AnalyserActivityAggregate> =>
    fetchJson(analyserApiUrl("/observations/aggregate", query)),
  routines: (): Promise<{ items: AnalyserRoutineRecord[] }> =>
    fetchJson(analyserApiUrl("/routines")),
  routineStatus: (): Promise<{ items: AnalyserRoutineStatusSummary[] }> =>
    fetchJson(analyserApiUrl("/routines/status")),
  seedRoutines: (): Promise<void> =>
    fetchJson(analyserApiUrl("/routines/seed"), {
      method: "POST",
      body: JSON.stringify({})
    }),
  updateRoutine: (key: string, body: {
    name?: string;
    enabled?: boolean;
    scheduleKind?: "interval" | "cron";
    scheduleExpr?: string;
    timezone?: string;
    maxRetries?: number;
    backoffMinutes?: number;
    skillVersion?: string;
    expectedVersion?: number;
  }): Promise<AnalyserRoutineRecord> =>
    fetchJson(analyserApiUrl(`/routines/${encodeURIComponent(key)}`), {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  summaries: (query: {
    kind?: string;
    from?: string;
    to?: string;
    routineKey?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserSummaryListItem[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/summaries", query)),
  summary: (id: string): Promise<AnalyserSummaryRecord> =>
    fetchJson(analyserApiUrl(`/summaries/${encodeURIComponent(id)}`)),
  proposals: (query: {
    status?: AnalyserProposalStatus;
    kind?: string;
    routineKey?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserProposalListItem[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/proposals", query)),
  proposal: (id: string): Promise<AnalyserProposalRecord> =>
    fetchJson(analyserApiUrl(`/proposals/${encodeURIComponent(id)}`)),
  export: (body: AnalyserExportInput): Promise<AnalyserExportResult> =>
    fetchJson(analyserApiUrl("/export"), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  resolveProposal: (id: string, body: {
    status: "approved" | "rejected";
    provenance: string;
    expectedVersion: number;
  }): Promise<AnalyserProposalRecord> =>
    fetchJson(analyserApiUrl(`/proposals/${encodeURIComponent(id)}/resolve`), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  supersedeProposal: (id: string, body: { expectedVersion: number }): Promise<AnalyserProposalRecord> =>
    fetchJson(analyserApiUrl(`/proposals/${encodeURIComponent(id)}/supersede`), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  publications: (query: {
    sourceKind?: "summary" | "proposal";
    sourceId?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserPublicationRecord[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/publications", query)),
  operations: (query: {
    operationKind?: AnalyserOperationKind;
    result?: AnalyserOperationRecord["result"];
    proposalId?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserOperationRecord[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/operations", query)),
  projectorFlush: (): Promise<AnalyserProjectorFlushResult> =>
    fetchJson(analyserApiUrl("/projector/flush"), {
      method: "POST",
      body: JSON.stringify({})
    })
};

export const artifactsApi = {
  list: (projectId?: string, limit?: number): Promise<Artifact[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (limit) params.set("limit", String(limit));
    return fetchJson<Artifact[]>(`${coreBaseUrl()}/api/artifacts?${params.toString()}`);
  },
  get: (id: string): Promise<Artifact> => fetchJson<Artifact>(`${coreBaseUrl()}/api/artifacts/${encodeURIComponent(id)}`),
  create: (payload: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Promise<Artifact> =>
    fetchJson<Artifact>(`${coreBaseUrl()}/api/artifacts`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Artifact, "id" | "createdAt" | "updatedAt">>
  ): Promise<Artifact> =>
    fetchJson<Artifact>(`${coreBaseUrl()}/api/artifacts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchJson<void>(`${coreBaseUrl()}/api/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<ArtifactProjectSummary[]> =>
    fetchJson<ArtifactProjectSummary[]>(`${coreBaseUrl()}/api/artifacts/projects`),
  tree: (projectId?: string): Promise<ArtifactItem[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    const query = params.toString();
    return fetchArtifactFacadeJson<ArtifactItem[]>(`/api/artifacts/tree${query ? `?${query}` : ""}`);
  },
  getItem: (id: string): Promise<ArtifactItem> =>
    fetchArtifactFacadeJson<ArtifactItem>(`/api/artifacts/items/${encodeURIComponent(id)}`),
  listProjectMemberships: (id: string): Promise<ArtifactProjectMembershipsResult> =>
    fetchArtifactFacadeJson<ArtifactProjectMembershipsResult>(
      `/api/artifacts/items/${encodeURIComponent(id)}/projects`
    ),
  linkProject: (
    id: string,
    payload: { projectId: string; note?: string; expectedArtifactVersion?: number }
  ): Promise<ArtifactProjectMembershipsResult> =>
    fetchArtifactFacadeJson<ArtifactProjectMembershipsResult>(
      `/api/artifacts/items/${encodeURIComponent(id)}/projects`,
      { method: "POST", body: JSON.stringify(payload) }
    ),
  unlinkProject: (id: string, projectId: string): Promise<void> =>
    fetchArtifactFacadeJson<void>(
      `/api/artifacts/items/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" }
    ),
  createFolder: (payload: {
    projectId: string;
    projectName?: string;
    path: string;
    title?: string;
    scope?: "private" | "org" | "project";
  }): Promise<ArtifactItem> =>
    fetchArtifactFacadeJson<ArtifactItem>("/api/artifacts/folders", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createNote: (payload: {
    projectId: string;
    projectName?: string;
    path?: string;
    title: string;
    scope?: "private" | "org" | "project";
    tags?: string[];
    contentMarkdown?: string;
  }): Promise<ArtifactItem> =>
    fetchArtifactFacadeJson<ArtifactItem>("/api/artifacts/notes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  uploadFile: async (payload: {
    projectId: string;
    projectName?: string;
    directoryPath?: string;
    scope?: "private" | "org" | "project";
    tags?: string[];
    file: File;
  }): Promise<ArtifactItem> => {
    const formData = new FormData();
    formData.append("projectId", payload.projectId);
    if (payload.projectName) formData.append("projectName", payload.projectName);
    if (payload.directoryPath) formData.append("directoryPath", payload.directoryPath);
    if (payload.scope) formData.append("scope", payload.scope);
    if (payload.tags?.length) formData.append("tags", JSON.stringify(payload.tags));
    formData.append("file", payload.file);

    const response = await requestArtifactFacade("/api/artifacts/upload", {
      method: "POST",
      body: formData
    });

    const text = await response.text();
    if (!response.ok) {
      const message = text || `Upload failed: ${response.status}`;
      pushErrorNotification(message, "Artifacts Upload Error");
      throw new Error(message);
    }

    return text ? (JSON.parse(text) as ArtifactItem) : (undefined as unknown as ArtifactItem);
  },
  updateItem: (
    id: string,
    payload: {
      title?: string;
      path?: string;
      projectId?: string;
      scope?: "private" | "org" | "project";
      tags?: string[];
      contentMarkdown?: string;
      projectName?: string;
    }
  ): Promise<ArtifactItem> =>
    fetchArtifactFacadeJson<ArtifactItem>(`/api/artifacts/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeItem: (id: string): Promise<void> =>
    fetchArtifactFacadeJson<void>(`/api/artifacts/items/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  downloadFile: async (id: string, asAttachment = false): Promise<Blob> => {
    const params = new URLSearchParams();
    if (asAttachment) params.set("download", "1");
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return fetchArtifactFacadeBlob(`/api/artifacts/items/${encodeURIComponent(id)}/download${suffix}`);
  },
  downloadPreviewPdf: async (id: string): Promise<Blob> => {
    const response = await fetchWithSessionAuth(
      `${coreBaseUrl()}/api/artifacts/items/${encodeURIComponent(id)}/preview-pdf`
    );

    if (!response.ok) {
      const message = `Preview download failed: ${response.status}`;
      pushErrorNotification(message, "Artifacts Preview Error");
      throw new Error(message);
    }

    return response.blob();
  }
};

export const deepResearchApi = {
  defaults: (): Promise<DeepResearchDefaultsResponse> =>
    fetchJson<DeepResearchDefaultsResponse>(`${coreBaseUrl()}/api/deep-research/defaults`),
  run: (payload: {
    query: string;
    provider?: "auto" | "gemini" | "openai" | "anthropic";
    speed?: "deep" | "fast";
    timeoutSec?: number;
    asyncOnTimeout?: boolean;
    saveToArtifacts?: boolean;
    artifactTitle?: string;
    artifactPath?: string;
    projectId?: string;
    projectName?: string;
  }): Promise<DeepResearchRunResponse> =>
    fetchJson<DeepResearchRunResponse>(`${coreBaseUrl()}/api/deep-research`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  status: (jobId: string): Promise<DeepResearchStatusResponse> =>
    fetchJson<DeepResearchStatusResponse>(`${coreBaseUrl()}/api/deep-research/jobs/${encodeURIComponent(jobId)}`),
  list: async (limit = 50): Promise<{ items: DeepResearchHistoryEntry[]; unsupported?: boolean }> => {
    try {
      return await fetchJson<{ items: DeepResearchHistoryEntry[]; unsupported?: boolean }>(
        `${coreBaseUrl()}/api/deep-research/jobs?limit=${encodeURIComponent(String(limit))}`
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return { items: [], unsupported: true };
      }
      throw error;
    }
  },
  cancel: (jobId: string): Promise<DeepResearchCancelResponse> =>
    fetchJson<DeepResearchCancelResponse>(
      `${coreBaseUrl()}/api/deep-research/jobs/${encodeURIComponent(jobId)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({})
      }
    ),
  save: (
    jobId: string,
    payload?: {
      artifactTitle?: string;
      artifactPath?: string;
      projectId?: string;
      projectName?: string;
      createNew?: boolean;
    }
  ): Promise<{ status: string; artifact: DeepResearchRunResponse["artifact"] }> =>
    fetchJson<{ status: string; artifact: DeepResearchRunResponse["artifact"] }>(
      `${coreBaseUrl()}/api/deep-research/jobs/${encodeURIComponent(jobId)}/save`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {})
      }
    )
};

type ImageGeneratePayload = {
  intent?: ImageIntent;
  prompt: string;
  instruction?: string;
  negativePrompt?: string;
  provider?: ImageProvider;
  model?: string;
  size?: ImageSize;
  count?: number;
  quality?: ImageQuality;
  stylePreset?: string;
  seed?: number;
  referenceImageIds?: string[];
  sourceAssetIds?: string[];
  contextRefs?: ImageContextRef[];
  preserve?: Array<"composition" | "subject" | "style" | "colors" | "text" | "layout">;
  saveToArtifacts?: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
};

export const imagesApi = {
  defaults: (): Promise<ImageDefaultsResponse> =>
    fetchJson<ImageDefaultsResponse>(`${coreBaseUrl()}/api/images/defaults`),
  uploadReference: async (payload: {
    file: File;
    purpose: "reference" | "source" | "mask";
    projectId?: string;
  }): Promise<ImageReferenceRecord> => {
    const formData = new FormData();
    formData.append("file", payload.file);
    formData.append("purpose", payload.purpose);
    if (payload.projectId) formData.append("projectId", payload.projectId);

    const response = await fetchWithSessionAuth(`${coreBaseUrl()}/api/images/references`, {
      method: "POST",
      body: formData
    });
    const text = await response.text();
    if (!response.ok) {
      const message = text || `Reference upload failed: ${response.status}`;
      pushErrorNotification(message, "Images Upload Error");
      throw new Error(message);
    }
    return JSON.parse(text) as ImageReferenceRecord;
  },
  generate: (payload: ImageGeneratePayload): Promise<ImageJobRecord> =>
    fetchJson<ImageJobRecord>(`${coreBaseUrl()}/api/images/generations`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  list: (limit = 50): Promise<{ items: ImageJobRecord[] }> =>
    fetchJson<{ items: ImageJobRecord[] }>(`${coreBaseUrl()}/api/images/generations?limit=${encodeURIComponent(String(limit))}`),
  getJob: (jobId: string): Promise<ImageJobRecord> =>
    fetchJson<ImageJobRecord>(`${coreBaseUrl()}/api/images/generations/${encodeURIComponent(jobId)}`),
  cancel: (jobId: string): Promise<ImageJobRecord> =>
    fetchJson<ImageJobRecord>(`${coreBaseUrl()}/api/images/generations/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  removeJob: (jobId: string): Promise<void> =>
    fetchJson<void>(`${coreBaseUrl()}/api/images/generations/${encodeURIComponent(jobId)}`, {
      method: "DELETE"
    }),
  retry: (jobId: string, payload: Partial<ImageGeneratePayload>): Promise<ImageJobRecord> =>
    fetchJson<ImageJobRecord>(`${coreBaseUrl()}/api/images/generations/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getAsset: (assetId: string): Promise<ImageAssetRecord> =>
    fetchJson<ImageAssetRecord>(`${coreBaseUrl()}/api/images/assets/${encodeURIComponent(assetId)}`),
  downloadAsset: async (assetId: string, asAttachment = false): Promise<Blob> => {
    const params = new URLSearchParams();
    if (asAttachment) params.set("download", "1");
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const response = await fetchWithSessionAuth(`${coreBaseUrl()}/api/images/assets/${encodeURIComponent(assetId)}/download${suffix}`);
    if (!response.ok) {
      const message = `Image download failed: ${response.status}`;
      pushErrorNotification(message, "Images Download Error");
      throw new Error(message);
    }
    return response.blob();
  },
  saveArtifact: (
    assetId: string,
    payload?: {
      artifactTitle?: string;
      artifactPath?: string;
      projectId?: string;
      projectName?: string;
    }
  ): Promise<{ status: string; artifact: unknown }> =>
    fetchJson<{ status: string; artifact: unknown }>(
      `${coreBaseUrl()}/api/images/assets/${encodeURIComponent(assetId)}/artifact`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {})
      }
    ),
  removeAsset: (assetId: string): Promise<void> =>
    fetchJson<void>(`${coreBaseUrl()}/api/images/assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE"
    })
};

export const mindmapsApi = {
  list: (
    options: {
      projectId?: string;
      q?: string;
      mode?: MindmapMode;
      limit?: number;
    } = {}
  ): Promise<MindmapListResult> => {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.q) params.set("q", options.q);
    if (options.mode) params.set("mode", options.mode);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return fetchJson<MindmapListResult>(`${coreBaseUrl()}/api/mindmaps${query ? `?${query}` : ""}`);
  },
  create: (payload: MindmapCreateInput): Promise<MindmapDocument> =>
    fetchJson<MindmapDocument>(`${coreBaseUrl()}/api/mindmaps`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  get: (documentId: string): Promise<MindmapDocument> =>
    fetchJson<MindmapDocument>(`${coreBaseUrl()}/api/mindmaps/${encodeURIComponent(documentId)}`),
  update: (documentId: string, payload: MindmapUpdateInput): Promise<MindmapDocument> =>
    fetchJson<MindmapDocument>(`${coreBaseUrl()}/api/mindmaps/${encodeURIComponent(documentId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (documentId: string): Promise<void> =>
    fetchJson<void>(`${coreBaseUrl()}/api/mindmaps/${encodeURIComponent(documentId)}`, {
      method: "DELETE"
    }),
  exportContent: (documentId: string, format: MindmapExportFormat): Promise<MindmapExportContent> =>
    fetchJson<MindmapExportContent>(`${coreBaseUrl()}/api/mindmaps/${encodeURIComponent(documentId)}/export`, {
      method: "POST",
      body: JSON.stringify({ format })
    }),
  saveArtifact: (
    documentId: string,
    payload?: {
      format?: MindmapExportFormat;
      artifactTitle?: string;
      artifactPath?: string;
      projectId?: string;
      projectName?: string;
    }
  ): Promise<MindmapArtifactSaveResponse> =>
    fetchJson<MindmapArtifactSaveResponse>(`${coreBaseUrl()}/api/mindmaps/${encodeURIComponent(documentId)}/artifact`, {
      method: "POST",
      body: JSON.stringify(payload ?? {})
    })
};

export const wbsApi = {
  listPlans: (
    options: {
      projectId?: string;
      q?: string;
      limit?: number;
    } = {}
  ): Promise<WbsPlanListResult> => {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.q) params.set("q", options.q);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return fetchJson<WbsPlanListResult>(`${coreBaseUrl()}/api/wbs/plans${query ? `?${query}` : ""}`);
  },
  createPlan: (payload: WbsCreatePlanInput): Promise<WbsPlan> =>
    fetchJson<WbsPlan>(`${coreBaseUrl()}/api/wbs/plans`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getPlan: (planId: string): Promise<WbsPlan> =>
    fetchJson<WbsPlan>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}`),
  updatePlan: (planId: string, payload: WbsUpdatePlanInput): Promise<WbsPlan> =>
    fetchJson<WbsPlan>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removePlan: (planId: string): Promise<void> =>
    fetchJson<void>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}`, {
      method: "DELETE"
    }),
  listItems: (planId: string): Promise<WbsItem[]> =>
    fetchJson<WbsItem[]>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}/items`),
  createItem: (planId: string, payload: WbsCreateItemInput): Promise<WbsItem[]> =>
    fetchJson<WbsItem[]>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}/items`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateItem: (itemId: string, payload: WbsUpdateItemInput): Promise<WbsItem[]> =>
    fetchJson<WbsItem[]>(`${coreBaseUrl()}/api/wbs/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeItem: (itemId: string): Promise<WbsItem[]> =>
    fetchJson<WbsItem[]>(`${coreBaseUrl()}/api/wbs/items/${encodeURIComponent(itemId)}`, {
      method: "DELETE"
    }),
  moveItem: (itemId: string, payload: WbsMoveItemInput): Promise<WbsItem[]> =>
    fetchJson<WbsItem[]>(`${coreBaseUrl()}/api/wbs/items/${encodeURIComponent(itemId)}/move`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  listDependencies: (planId: string): Promise<WbsDependency[]> =>
    fetchJson<WbsDependency[]>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}/dependencies`),
  exportContent: (planId: string, format: WbsExportFormat): Promise<WbsExportContent> =>
    fetchJson<WbsExportContent>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}/export`, {
      method: "POST",
      body: JSON.stringify({ format })
    }),
  saveArtifact: (
    planId: string,
    payload?: {
      format?: WbsExportFormat;
      artifactTitle?: string;
      artifactPath?: string;
      projectId?: string;
      projectName?: string;
    }
  ): Promise<WbsArtifactSaveResponse> =>
    fetchJson<WbsArtifactSaveResponse>(`${coreBaseUrl()}/api/wbs/plans/${encodeURIComponent(planId)}/artifact`, {
      method: "POST",
      body: JSON.stringify(payload ?? {})
    })
};

function requireTaskDate(value: string, fieldName: string): string {
  const normalized = normalizeDateKey(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a valid YYYY-MM-DD date.`);
  }
  return normalized;
}

export const tasksApi = {
  list: (context?: string, status?: TaskStatus, limit?: number): Promise<Task[]> => {
    const params = new URLSearchParams();
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return fetchTasksFacadeJson<Task[]>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  get: (id: string): Promise<Task> => fetchTasksFacadeJson<Task>(`/api/tasks/${encodeURIComponent(id)}`),
  create: (payload: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> =>
    fetchTasksFacadeJson<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>
  ): Promise<Task> =>
    fetchTasksFacadeJson<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchTasksFacadeJson<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<TaskProjectSummary[]> => fetchTasksFacadeJson<TaskProjectSummary[]>("/api/tasks/projects"),
  pins: (): Promise<{ taskIds: string[] }> => fetchTasksFacadeJson<{ taskIds: string[] }>("/api/tasks/pins"),
  setPin: (id: string, pinned: boolean): Promise<{ taskId: string; pinned: boolean }> =>
    fetchTasksFacadeJson<{ taskId: string; pinned: boolean }>(`/api/tasks/${encodeURIComponent(id)}/pin`, {
      method: "PUT",
      body: JSON.stringify({ pinned })
    }),
  todayList: (date: string): Promise<TodayTask[]> =>
    fetchTasksFacadeJson<TodayTask[]>(`/api/tasks/today?date=${encodeURIComponent(date)}`),
  addToToday: (
    taskId: string,
    scheduledDate: string,
    occurrenceDate: string,
    opts?: { startTime?: string; endTime?: string; timezone?: string }
  ): Promise<ScheduleItem> =>
    fetchTasksFacadeJson<ScheduleItem>(
      "/api/tasks/today",
      { method: "POST", body: JSON.stringify({ taskId, scheduledDate, occurrenceDate, ...opts }) }
    ),
  removeFromToday: (
    taskId: string,
    scheduledDate: string,
    occurrenceDate?: string
  ): Promise<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }> => {
    const params = new URLSearchParams({ scheduledDate });
    if (occurrenceDate) params.set("occurrenceDate", occurrenceDate);
    return fetchTasksFacadeJson<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }>(
      `/api/tasks/today/${encodeURIComponent(taskId)}?${params.toString()}`,
      { method: "DELETE" }
    );
  },
  scheduleCalendar: (startDate: string, endDate: string): Promise<ScheduleCalendarDay[]> => {
    const params = new URLSearchParams({ startDate, endDate });
    return fetchTasksFacadeJson<ScheduleCalendarDay[]>(`/api/tasks/schedule-calendar?${params.toString()}`);
  },
  updateScheduleItem: (
    scheduleId: number,
    patch: { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null }
  ): Promise<ScheduleItem> =>
    fetchTasksFacadeJson<ScheduleItem>(
      `/api/tasks/schedule-items/${scheduleId}`,
      { method: "PUT", body: JSON.stringify(patch) }
    ),
  removeScheduleItem: (scheduleId: number): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/schedule-items/${scheduleId}`,
      { method: "DELETE" }
    ),
  scheduleItemsForTask: (taskId: string): Promise<ScheduleItem[]> =>
    fetchTasksFacadeJson<ScheduleItem[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/schedule-items`
    ),
  completeOccurrence: (id: string, targetDate: string, status: TaskStatus): Promise<{ taskId: string; targetDate: string; status: TaskStatus }> => {
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; targetDate: string; status: TaskStatus }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/complete`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate: normalizedTargetDate, status })
      }
    );
  },
  moveOccurrence: (id: string, sourceDate: string, targetDate: string): Promise<{ taskId: string; sourceDate: string; targetDate: string }> => {
    const normalizedSourceDate = requireTaskDate(sourceDate, "Occurrence source date");
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; sourceDate: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/move`,
      {
        method: "POST",
        body: JSON.stringify({ sourceDate: normalizedSourceDate, targetDate: normalizedTargetDate })
      }
    );
  },
  skipOccurrenceException: (id: string, targetDate: string): Promise<{ taskId: string; targetDate: string }> => {
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/skip-exception`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate: normalizedTargetDate })
      }
    );
  },
  schedule: (startDate: string, endDate: string, context?: string, status?: TaskStatus): Promise<TaskScheduleDay[]> => {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    return fetchTasksFacadeJson<TaskScheduleDay[]>(`/api/tasks/schedule?${params.toString()}`);
  },
  history: (id: string): Promise<TaskHistoryEntry[]> =>
    fetchTasksFacadeJson<TaskHistoryEntry[]>(`/api/tasks/${encodeURIComponent(id)}/history`),
  exportCsv: async (): Promise<Blob> => {
    const response = await requestTasksFacade("/api/tasks/export", {
      headers: { Accept: "text/csv" }
    });

    if (!response.ok) {
      throw new Error(`Export failed: ${response.status}`);
    }
    return response.blob();
  },
  importCsv: (file: File): Promise<{ imported: number }> => {
    return file.text().then((text) =>
      fetchTasksFacadeJson<{ imported: number }>("/api/tasks/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text
      })
    );
  }
};

export const taskAttachmentsApi = {
  list: (taskId: string): Promise<TaskAttachment[]> =>
    fetchTasksFacadeJson<TaskAttachment[]>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`),

  upload: async (taskId: string, file: File): Promise<TaskAttachment> => {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments`;
    const clientOpId = crypto.randomUUID();
    const uploadOptions: RequestInit = {
      method: "POST",
      headers: { [CLIENT_OP_ID_HEADER]: clientOpId }
    };
    const uploadToLocal = async (): Promise<TaskAttachment> => {
      const result = await requestLocalDaemonJson<TaskAttachment>(path, {
        method: "POST",
        headers: { [CLIENT_OP_ID_HEADER]: clientOpId },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await fileToBase64(file)
        })
      });
      markSuccessfulLocalRequest(uploadOptions);
      return result;
    };

    if (tasksFacadeEnabled(path, uploadOptions)) {
      return uploadToLocal();
    }

    const formData = new FormData();
    formData.append("file", file);

    let response: Response;
    try {
      response = await fetchWithSessionAuth(`${coreBaseUrl()}${path}`, {
        method: "POST",
        headers: { [CLIENT_OP_ID_HEADER]: clientOpId },
        body: formData
      }, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
    } catch (error) {
      if (autoRoutingCanFallbackToLocal(error, path, uploadOptions)) {
        return uploadToLocal();
      }
      throw error;
    }
    markSuccessfulCoreRequest();

    if (!response.ok) {
      const text = await response.text();
      let message = `Upload failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* ignore */ }
      pushErrorNotification(message, "Upload Error");
      throw new Error(message);
    }

    return response.json() as Promise<TaskAttachment>;
  },

  download: async (taskId: string, attachmentId: string, inline = false): Promise<void> => {
    const suffix = inline ? "" : "?download=1";
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download${suffix}`;
    const response = await requestTasksFacade(path);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), attachmentId);

    if (inline) {
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  },

  fetchBlob: async (taskId: string, attachmentId: string): Promise<{ blob: Blob; filename: string; mimeType: string }> => {
    const response = await requestTasksFacade(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download`
    );
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), attachmentId);
    const mimeType = (response.headers.get("content-type") ?? blob.type ?? "").split(";")[0].trim();
    return { blob, filename, mimeType };
  },

  remove: (taskId: string, attachmentId: string): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" }
    )
};

export const taskSubtasksApi = {
  list: (taskId: string, occurrenceDate: string): Promise<TaskSubtask[]> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks`
    );
  },

  create: (taskId: string, occurrenceDate: string, title: string): Promise<TaskSubtask> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks`,
      { method: "POST", body: JSON.stringify({ title }) }
    );
  },

  update: (
    taskId: string,
    occurrenceDate: string,
    subtaskId: string,
    updates: { title?: string; isDone?: boolean; sortOrder?: number }
  ): Promise<TaskSubtask> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "PATCH", body: JSON.stringify(updates) }
    );
  },

  remove: (taskId: string, occurrenceDate: string, subtaskId: string): Promise<void> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "DELETE" }
    );
  }
};

export const projectsApi = {
  list: (query?: string, status?: "draft" | "active" | "archived", limit?: number, cursor?: string): Promise<ProjectListResult> => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const queryString = params.toString();
    return fetchProjectsFacadeJson<ProjectListResult>(`/api/projects${queryString ? `?${queryString}` : ""}`);
  },
  get: (id: string): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`),
  create: (payload: { name: string; description?: string; status?: "draft" | "active" | "archived" }): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (id: string, payload: Partial<Pick<ProjectRecord, "name" | "description" | "status">>): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  getDefault: (): Promise<ProjectDefaultSelection> =>
    fetchProjectsFacadeJson<ProjectDefaultSelection>("/api/projects/default"),
  setDefault: (projectId: string): Promise<ProjectDefaultSelection> =>
    fetchProjectsFacadeJson<ProjectDefaultSelection>("/api/projects/default", {
      method: "PUT",
      body: JSON.stringify({ projectId })
    }),
  getContext: (
    id: string,
    options?: {
      q?: string;
      include?: Array<"brief" | "summary" | "memory" | "index" | "relations" | "links">;
      memoryLimit?: number;
      indexLimit?: number;
      relationLimit?: number;
      maxChars?: number;
    }
  ): Promise<ProjectContextPack> => {
    const params = new URLSearchParams();
    if (options?.q) params.set("q", options.q);
    if (options?.include?.length) params.set("include", options.include.join(","));
    if (options?.memoryLimit) params.set("memoryLimit", String(options.memoryLimit));
    if (options?.indexLimit) params.set("indexLimit", String(options.indexLimit));
    if (options?.relationLimit) params.set("relationLimit", String(options.relationLimit));
    if (options?.maxChars) params.set("maxChars", String(options.maxChars));
    const query = params.toString();
    return fetchProjectsFacadeJson<ProjectContextPack>(
      `/api/projects/${encodeURIComponent(id)}/context${query ? `?${query}` : ""}`
    );
  },
  getBrief: (id: string): Promise<ProjectBriefRecord> =>
    fetchProjectsFacadeJson<ProjectBriefRecord>(`/api/projects/${encodeURIComponent(id)}/brief`),
  updateBrief: (
    id: string,
    payload: { contentMarkdown: string; expectedVersion: number }
  ): Promise<ProjectBriefRecord> =>
    fetchProjectsFacadeJson<ProjectBriefRecord>(`/api/projects/${encodeURIComponent(id)}/brief`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  listMemories: (
    id: string,
    options?: {
      q?: string;
      kind?: ProjectMemoryKind;
      authority?: ProjectMemoryAuthority;
      status?: ProjectMemoryStatus;
      limit?: number;
      cursor?: string;
    }
  ): Promise<ProjectMemoryListResult> => {
    const query = buildProjectMemoryQuery(options);
    return fetchProjectsFacadeJson<ProjectMemoryListResult>(
      `/api/projects/${encodeURIComponent(id)}/memories${query ? `?${query}` : ""}`
    );
  },
  appendMemory: (
    id: string,
    payload: {
      kind: ProjectMemoryKind;
      bodyMarkdown: string;
      authority?: ProjectMemoryAuthority;
      sourceService?: string;
      sourceResourceType?: string;
      sourceResourceId?: string;
      confidence?: number;
      supersedesId?: string;
    }
  ): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/projects/${encodeURIComponent(id)}/memories`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateMemory: (
    memoryId: string,
    payload: Partial<Pick<ProjectMemoryEntry, "bodyMarkdown" | "status">>
  ): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/project-memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  archiveMemory: (memoryId: string): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/project-memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" })
    }),
  searchIndex: (
    id: string,
    options?: { q?: string; sourceService?: string; resourceType?: string; limit?: number; cursor?: string }
  ): Promise<ProjectIndexListResult> => {
    const query = buildProjectIndexQuery(options);
    return fetchProjectsFacadeJson<ProjectIndexListResult>(
      `/api/projects/${encodeURIComponent(id)}/index${query ? `?${query}` : ""}`
    );
  },
  rebuildIndex: (id: string): Promise<{
    projectId: string;
    indexed: number;
    primary: number;
    secondary: number;
    tombstoned: number;
    staleLinksRemoved: number;
  }> =>
    fetchProjectsFacadeJson<{
      projectId: string;
      indexed: number;
      primary: number;
      secondary: number;
      tombstoned: number;
      staleLinksRemoved: number;
    }>(
      `/api/projects/${encodeURIComponent(id)}/index/rebuild`,
      { method: "POST" }
    ),
  listRelations: (id: string): Promise<ProjectRelationListResult> =>
    fetchProjectsFacadeJson<ProjectRelationListResult>(`/api/projects/${encodeURIComponent(id)}/relations`),
  addRelation: (
    id: string,
    payload: {
      targetProjectId: string;
      relationType: ProjectRelationType;
      directionality: ProjectRelationDirectionality;
      note?: string;
      strength?: number;
    }
  ): Promise<ProjectRelation> =>
    fetchProjectsFacadeJson<ProjectRelation>(`/api/projects/${encodeURIComponent(id)}/relations`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateRelation: (
    relationId: string,
    payload: Partial<Pick<ProjectRelation, "relationType" | "directionality" | "note" | "strength">> & {
      expectedVersion: number;
    }
  ): Promise<ProjectRelation> =>
    fetchProjectsFacadeJson<ProjectRelation>(`/api/project-relations/${encodeURIComponent(relationId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeRelation: (relationId: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/project-relations/${encodeURIComponent(relationId)}`, {
      method: "DELETE"
    }),
  listLinks: (
    id: string,
    options?: {
      targetService?: string;
      targetResourceType?: string;
      relationType?: string;
      limit?: number;
      cursor?: string;
    }
  ): Promise<ProjectLinkListResult> => {
    const params = new URLSearchParams();
    if (options?.targetService) params.set("targetService", options.targetService);
    if (options?.targetResourceType) params.set("targetResourceType", options.targetResourceType);
    if (options?.relationType) params.set("relationType", options.relationType);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return fetchProjectsFacadeJson<ProjectLinkListResult>(
      `/api/projects/${encodeURIComponent(id)}/links${query ? `?${query}` : ""}`
    );
  },
  addLink: (
    id: string,
    payload: {
      targetService: string;
      targetResourceType: string;
      targetResourceId: string;
      relationType?: string;
      titleSnapshot?: string;
      summarySnapshot?: string;
      metadataJson?: Record<string, unknown>;
    }
  ): Promise<ProjectLinkRecord> =>
    fetchProjectsFacadeJson<ProjectLinkRecord>(`/api/projects/${encodeURIComponent(id)}/links`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  removeLink: (linkId: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/project-links/${encodeURIComponent(linkId)}`, { method: "DELETE" }),
  getContextSummary: (id: string): Promise<ProjectContextSummary> =>
    fetchProjectsFacadeJson<ProjectContextSummary>(`/api/projects/${encodeURIComponent(id)}/context-summary`),
  refreshContextSummary: (id: string): Promise<ProjectContextSummary> =>
    fetchProjectsFacadeJson<ProjectContextSummary>(
      `/api/projects/${encodeURIComponent(id)}/context-summary/refresh`,
      { method: "POST" }
    ),
  getDeletionImpact: (id: string): Promise<ProjectDeletionImpact> =>
    fetchProjectsFacadeJson<ProjectDeletionImpact>(`/api/projects/${encodeURIComponent(id)}/deletion-impact`)
};

export async function checkServiceHealth(serviceId: "notes" | "artifacts" | "tasks"): Promise<ServiceHealth> {
  try {
    const health = await fetchJson<ServiceHealth>(`${coreBaseUrl()}/health`);
    return {
      service: serviceId,
      status: health.status,
      timestamp: health.timestamp
    };
  } catch {
    return {
      service: serviceId,
      status: "error",
      timestamp: new Date().toISOString()
    };
  }
}

export async function fetchServiceManifest(
  serviceId: "notes" | "artifacts" | "tasks"
): Promise<IntegrationManifest | undefined> {
  const manifests = await fetchAllServiceManifests();
  const manifestId = serviceId;
  return manifests.find((manifest) => manifest.id === manifestId);
}

export async function fetchAllServiceManifests(): Promise<IntegrationManifest[]> {
  try {
    return await fetchJson<IntegrationManifest[]>(`${coreBaseUrl()}/integrations/manifests`);
  } catch {
    return [];
  }
}

export const coreApi = {
  register: (username: string, password: string): Promise<WorkbenchAuthResponse> =>
    fetchJson(`${coreBaseUrl()}/accounts/register`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  login: (username: string, password: string): Promise<WorkbenchAuthResponse> =>
    fetchJson(`${coreBaseUrl()}/accounts/login`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  refresh: (refreshToken: string): Promise<WorkbenchRefreshResponse> =>
    requestJson(
      `${coreBaseUrl()}/auth/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken })
      },
      false
    ),
  me: (): Promise<{ user: WorkbenchUserSession; provisioning: ServiceProvisioningState[] }> =>
    fetchJson(`${coreBaseUrl()}/auth/me`),
  listIntegrationConfigs: (): Promise<StoredIntegrationConfig[]> =>
    fetchJson(`${coreBaseUrl()}/integrations/configs`),
  saveIntegrationConfig: (
    integrationId: string,
    payload: { enabled: boolean; values: Record<string, string | number | boolean> }
  ): Promise<{ status: string }> =>
    fetchJson(`${coreBaseUrl()}/integrations/configs/${encodeURIComponent(integrationId)}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  listLocalClients: (): Promise<{ items: LocalClientRecord[] }> =>
    fetchJson(`${coreBaseUrl()}/api/local-clients`),
  listLocalClientAuditEvents: (
    options: { localClientId?: string; limit?: number } = {}
  ): Promise<{ items: LocalClientAuditEventRecord[] }> => {
    const params = new URLSearchParams();
    if (options.localClientId) params.set("localClientId", options.localClientId);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return fetchJson(`${coreBaseUrl()}/api/local-clients/audit-events${query ? `?${query}` : ""}`);
  },
  updateLocalClient: (
    id: string,
    payload: { clientName?: string; enabled?: boolean; capabilities?: Record<string, unknown>; syncRootLabel?: string; default?: boolean }
  ): Promise<LocalClientRecord> =>
    fetchJson(`${coreBaseUrl()}/api/local-clients/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  revokeLocalClient: (id: string): Promise<{ revoked: true; client?: LocalClientRecord }> =>
    fetchJson(`${coreBaseUrl()}/api/local-clients/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      body: JSON.stringify({})
    }),
  deleteLocalClient: (id: string): Promise<void> =>
    fetchJson(`${coreBaseUrl()}/api/local-clients/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  listLocalJobs: (
    options: {
      localClientId?: string;
      status?: LocalJobRecord["status"];
      limit?: number;
      includeLocalPaths?: boolean;
    } = {}
  ): Promise<{ items: LocalJobRecord[] }> => {
    const params = new URLSearchParams();
    if (options.localClientId) params.set("localClientId", options.localClientId);
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.includeLocalPaths) params.set("includeLocalPaths", "true");
    const query = params.toString();
    return fetchJson(`${coreBaseUrl()}/api/local-jobs${query ? `?${query}` : ""}`);
  },
  getLocalJob: (id: string, options: { includeLocalPaths?: boolean } = {}): Promise<LocalJobRecord> => {
    const params = new URLSearchParams();
    if (options.includeLocalPaths) params.set("includeLocalPaths", "true");
    const query = params.toString();
    return fetchJson(`${coreBaseUrl()}/api/local-jobs/${encodeURIComponent(id)}${query ? `?${query}` : ""}`);
  }
};

export const localDaemonApi = {
  status: (): Promise<LocalDaemonStatus> =>
    requestLocalDaemonJson<LocalDaemonStatus>("/status"),
  captureStatus: (): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/status"),
  captureConfig: (): Promise<CaptureDaemonConfig> =>
    requestLocalDaemonJson<CaptureDaemonConfig>("/capture/config"),
  updateCaptureConfig: (payload: CaptureDaemonConfigPatch): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/config", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  enableCapture: (): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/enable", {
      method: "POST"
    }),
  disableCapture: (): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/disable", {
      method: "POST"
    }),
  summarizeCapture: (date?: string): Promise<CaptureSummaryResult> =>
    requestLocalDaemonJson<CaptureSummaryResult>("/capture/summarize", {
      method: "POST",
      body: JSON.stringify(date ? { date } : {})
    }),
  listCaptureSummaries: (
    options: { limit?: number; cursor?: string } = {}
  ): Promise<CaptureSummaryListResult> => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return requestLocalDaemonJson<CaptureSummaryListResult>(`/capture/summaries${query ? `?${query}` : ""}`);
  },
  getCaptureSummary: (summaryDate: string): Promise<CaptureSummaryRecord> =>
    requestLocalDaemonJson<CaptureSummaryRecord>(`/capture/summaries/${encodeURIComponent(summaryDate)}`),
  publishCaptureSummary: (summaryDate: string): Promise<CaptureSummaryRecord & { action?: "create" | "update"; title?: string }> =>
    requestLocalDaemonJson<CaptureSummaryRecord & { action?: "create" | "update"; title?: string }>(
      `/capture/summaries/${encodeURIComponent(summaryDate)}/publish`,
      {
        method: "POST",
        body: JSON.stringify({ target: "note" })
      }
    ),
  listCaptureScreenshots: (options: { date: string; limit?: number; cursor?: string }): Promise<CaptureScreenshotListResult> => {
    const params = new URLSearchParams({ date: options.date });
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    return requestLocalDaemonJson<CaptureScreenshotListResult>(`/capture/screenshots?${params.toString()}`);
  },
  captureScreenshotFileUrl: (id: number): string =>
    `${localDaemonBaseUrl()}/capture/screenshots/${encodeURIComponent(String(id))}/file`,
  requestRescan: (): Promise<{ scheduled: boolean; status: LocalDaemonStatus }> =>
    requestLocalDaemonJson<{ scheduled: boolean; status: LocalDaemonStatus }>("/api/sync/rescan", {
      method: "POST"
    }),
  listPendingJobConfirmations: (): Promise<{
    policy: LocalDaemonStatus["localJobConfirmationPolicy"];
    items: LocalDaemonPendingJobConfirmation[];
  }> =>
    requestLocalDaemonJson<{
      policy: LocalDaemonStatus["localJobConfirmationPolicy"];
      items: LocalDaemonPendingJobConfirmation[];
    }>("/api/local-jobs/pending-confirmations"),
  approveJobConfirmation: (jobId: string): Promise<{ status: "completed"; result: LocalJobResultRecord }> =>
    requestLocalDaemonJson<{ status: "completed"; result: LocalJobResultRecord }>(
      `/api/local-jobs/${encodeURIComponent(jobId)}/approve`,
      { method: "POST" }
    ),
  rejectJobConfirmation: (jobId: string, reason?: string): Promise<{ status: "rejected" }> =>
    requestLocalDaemonJson<{ status: "rejected" }>(
      `/api/local-jobs/${encodeURIComponent(jobId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify({ reason })
      }
    ),
  listConflicts: (
    options: { status?: LocalDaemonConflictRecord["status"] | "all"; limit?: number } = {}
  ): Promise<{ items: LocalDaemonConflictRecord[] }> => {
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return requestLocalDaemonJson<{ items: LocalDaemonConflictRecord[] }>(`/conflicts${query ? `?${query}` : ""}`);
  },
  resolveConflict: (
    id: string,
    payload: { resolution: "retry" | "ignore" | "close"; note?: string }
  ): Promise<LocalDaemonConflictRecord> =>
    requestLocalDaemonJson<LocalDaemonConflictRecord>(`/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(payload)
    })
};

export async function saveWorkbenchSession(session: WorkbenchAuthResponse | WorkbenchRefreshResponse): Promise<void> {
  const stored: StoredAuthSession = {
    user: session.user,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenType: session.tokenType,
    expiresInSeconds: session.expiresInSeconds,
    issuedAt: new Date().toISOString()
  };
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
