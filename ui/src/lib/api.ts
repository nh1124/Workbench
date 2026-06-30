import {
  getWorkbenchCoreUrl,
  getWorkbenchLocalDaemonToken,
  getWorkbenchLocalDaemonUrl,
  getWorkbenchLocalRoutingMode,
  resolveWorkbenchLocalRoutingTarget
} from "../config/services";
import {
  getNativeGlobalShortcutRegistrations,
  type ShortcutBindings
} from "./keyboardShortcuts";
import { pushErrorNotification } from "./notificationService";
import { buildProjectIndexQuery, buildProjectMemoryQuery } from "../projects/projectContextQueries";
import type {
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
  WorkbenchAuthResponse,
  WorkbenchRefreshResponse,
  WorkbenchUserSession
} from "../types/models";

const SESSION_KEY = "workbench-session";
const LOCAL_DAEMON_REQUEST_TIMEOUT_MS = 2500;
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

function authHeaders(extra?: HeadersInit): HeadersInit {
  const session = readStoredSession();
  return {
    ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    ...(extra ?? {})
  };
}

function localDaemonHeaders(extra?: HeadersInit): HeadersInit {
  const headers = new Headers(extra);
  const token = getWorkbenchLocalDaemonToken();
  if (token) {
    headers.set("x-workbench-daemon-token", token);
  }
  return headers;
}

class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
    response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(withSessionAuth ? authHeaders(options?.headers) : (options?.headers ?? {}))
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    const message = `Connection failed for ${url}: ${detail}`;
    if (!notificationOptions.suppressConnectionError) {
      pushErrorNotification(message, "Connection Error");
    }
    throw new Error(message);
  }

  if (!response.ok) {
    const text = await response.text();
    let shouldNotify = !(response.status === 401 && !isAuthRefreshRoute(url));
    if (response.status === 404 && isDeepResearchHistoryRoute(url)) {
      // Backward compatibility: old core may not expose history endpoint yet.
      shouldNotify = false;
    }
    if (text) {
      let parsed: { message?: string; code?: string } | undefined;
      try {
        parsed = JSON.parse(text) as { message?: string; code?: string };
      } catch {
        parsed = undefined;
      }

      const normalizedText = looksLikeHtmlResponse(text) ? normalizeHtmlErrorMessage(text, response.status, url) : text;

      if (parsed && typeof parsed.message === "string" && parsed.message.trim().length > 0) {
        if (parsed.code === "LBS_UNREACHABLE" && response.status !== 401) {
          if (shouldNotify) {
            pushErrorNotification(
              "Tasks backend (LBS) is unreachable. Please start/check LBS and retry.",
              "Tasks Service Error"
            );
          }
          throw new ApiError(
            "Tasks backend (LBS) is unreachable. Please start/check LBS and retry.",
            response.status,
            parsed.code
          );
        }
        if (shouldNotify) {
          pushErrorNotification(parsed.message, "Service Error");
        }
        throw new ApiError(parsed.message, response.status, parsed.code);
      }

      if (shouldNotify) {
        pushErrorNotification(normalizedText, "Service Error");
      }
      throw new ApiError(normalizedText, response.status);
    }
    if (shouldNotify) {
      pushErrorNotification(`Request failed: ${response.status}`, "Service Error");
    }
    throw new ApiError(`Request failed: ${response.status}`, response.status);
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
    throw new Error(message);
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
    throw new Error(`Local daemon connection failed for ${url}: ${detail}`);
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", onUpstreamAbort);
  }

  return response;
}

async function requestLocalDaemonJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await requestLocalDaemon(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    let parsed: { message?: string; code?: string } | undefined;
    try {
      parsed = JSON.parse(text) as { message?: string; code?: string };
    } catch {
      parsed = undefined;
    }
    throw new ApiError(
      parsed?.message ?? (text || `Local daemon request failed: ${response.status}`),
      response.status,
      parsed?.code
    );
  }
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

async function requestArtifactFacade(path: string, options?: RequestInit): Promise<Response> {
  if (artifactsFacadeEnabled()) {
    return requestLocalDaemon(path, options);
  }
  try {
    return await fetchWithSessionAuth(coreArtifactPath(path), options, {
      suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto"
    });
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, options)) {
      return requestLocalDaemon(path, options);
    }
    throw error;
  }
}

async function requestTasksFacade(path: string, options?: RequestInit): Promise<Response> {
  if (tasksFacadeEnabled()) {
    return requestLocalDaemon(path, options);
  }
  try {
    return await fetchWithSessionAuth(coreApiPath(path), options, {
      suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto"
    });
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, options)) {
      return requestLocalDaemon(path, options);
    }
    throw error;
  }
}

async function fetchArtifactFacadeBlob(path: string): Promise<Blob> {
  const response = await requestArtifactFacade(path);

  if (!response.ok) {
    const message = `Download failed: ${response.status}`;
    pushErrorNotification(message, "Artifacts Download Error");
    throw new Error(message);
  }

  return response.blob();
}

function browserReportsOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

function localRoutingTarget(): "core" | "local" {
  return resolveWorkbenchLocalRoutingTarget(getWorkbenchLocalRoutingMode(), browserReportsOnline());
}

function autoRoutingCanFallbackToLocal(error: unknown, options?: RequestInit): boolean {
  if (getWorkbenchLocalRoutingMode() !== "auto") return false;
  if (options?.signal?.aborted) return false;
  return error instanceof Error && error.message.startsWith("Connection failed for ");
}

function artifactsFacadeEnabled(): boolean {
  return localRoutingTarget() === "local";
}

function notesFacadeEnabled(): boolean {
  return localRoutingTarget() === "local";
}

function projectsFacadeEnabled(): boolean {
  return localRoutingTarget() === "local";
}

function tasksFacadeEnabled(): boolean {
  return localRoutingTarget() === "local";
}

function coreArtifactPath(path: string): string {
  return `${coreBaseUrl()}${path}`;
}

function coreApiPath(path: string): string {
  return `${coreBaseUrl()}${path}`;
}

async function fetchArtifactFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  if (artifactsFacadeEnabled()) {
    return requestLocalDaemonJson<T>(path, options);
  }
  try {
    return await fetchJson<T>(coreArtifactPath(path), options, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, options)) {
      return requestLocalDaemonJson<T>(path, options);
    }
    throw error;
  }
}

async function fetchNotesFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  if (notesFacadeEnabled()) {
    return requestLocalDaemonJson<T>(path, options);
  }
  try {
    return await fetchJson<T>(coreApiPath(path), options, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, options)) {
      return requestLocalDaemonJson<T>(path, options);
    }
    throw error;
  }
}

async function fetchProjectsFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  if (projectsFacadeEnabled()) {
    return requestLocalDaemonJson<T>(path, options);
  }
  try {
    return await fetchJson<T>(coreApiPath(path), options, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, options)) {
      return requestLocalDaemonJson<T>(path, options);
    }
    throw error;
  }
}

async function fetchTasksFacadeJson<T>(path: string, options?: RequestInit): Promise<T> {
  if (tasksFacadeEnabled()) {
    return requestLocalDaemonJson<T>(path, options);
  }
  try {
    return await fetchJson<T>(coreApiPath(path), options, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
  } catch (error) {
    if (autoRoutingCanFallbackToLocal(error, options)) {
      return requestLocalDaemonJson<T>(path, options);
    }
    throw error;
  }
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
    return await requestJson<T>(url, options, true, notificationOptions);
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
      return await requestJson<T>(url, options, true, notificationOptions);
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
        headers: authHeaders(options?.headers)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network error";
      const message = `Connection failed for ${url}: ${detail}`;
      if (!notificationOptions.suppressConnectionError) {
        pushErrorNotification(message, "Connection Error");
      }
      throw new Error(message);
    }
  };

  let response = await requestOnce();
  if (response.status !== 401 || isAuthRefreshRoute(url)) {
    return response;
  }

  const session = readStoredSession();
  if (!session?.refreshToken) {
    return response;
  }

  try {
    await refreshAccessToken(session.refreshToken);
    response = await requestOnce();
    return response;
  } catch {
    await clearWorkbenchSession();
    return response;
  }
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
  completeOccurrence: (id: string, targetDate: string, status: TaskStatus): Promise<{ taskId: string; targetDate: string; status: TaskStatus }> =>
    fetchTasksFacadeJson<{ taskId: string; targetDate: string; status: TaskStatus }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/complete`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate, status })
      }
    ),
  moveOccurrence: (id: string, sourceDate: string, targetDate: string): Promise<{ taskId: string; sourceDate: string; targetDate: string }> =>
    fetchTasksFacadeJson<{ taskId: string; sourceDate: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/move`,
      {
        method: "POST",
        body: JSON.stringify({ sourceDate, targetDate })
      }
    ),
  skipOccurrenceException: (id: string, targetDate: string): Promise<{ taskId: string; targetDate: string }> =>
    fetchTasksFacadeJson<{ taskId: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/skip-exception`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate })
      }
    ),
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
    if (tasksFacadeEnabled()) {
      return fetchTasksFacadeJson<TaskAttachment>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await fileToBase64(file)
        })
      });
    }

    const formData = new FormData();
    formData.append("file", file);

    let response: Response;
    try {
      response = await fetchWithSessionAuth(`${coreBaseUrl()}/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
        method: "POST",
        body: formData
      }, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
    } catch (error) {
      if (autoRoutingCanFallbackToLocal(error)) {
        return fetchTasksFacadeJson<TaskAttachment>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            contentBase64: await fileToBase64(file)
          })
        });
      }
      throw error;
    }

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
  list: (taskId: string, occurrenceDate: string): Promise<TaskSubtask[]> =>
    fetchTasksFacadeJson<TaskSubtask[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks`
    ),

  create: (taskId: string, occurrenceDate: string, title: string): Promise<TaskSubtask> =>
    fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks`,
      { method: "POST", body: JSON.stringify({ title }) }
    ),

  update: (
    taskId: string,
    occurrenceDate: string,
    subtaskId: string,
    updates: { title?: string; isDone?: boolean; sortOrder?: number }
  ): Promise<TaskSubtask> =>
    fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "PATCH", body: JSON.stringify(updates) }
    ),

  remove: (taskId: string, occurrenceDate: string, subtaskId: string): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "DELETE" }
    )
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
