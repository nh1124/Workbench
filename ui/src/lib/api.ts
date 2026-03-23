import { workbenchCoreUrl } from "../config/services";
import { pushErrorNotification } from "./notificationService";
import type {
  Artifact,
  DeepResearchCancelResponse,
  DeepResearchDefaultsResponse,
  DeepResearchHistoryEntry,
  DeepResearchRunResponse,
  DeepResearchStatusResponse,
  ArtifactItem,
  ArtifactProjectSummary,
  IntegrationManifest,
  Note,
  NoteProjectSummary,
  ProjectDefaultSelection,
  ProjectListResult,
  ProjectRecord,
  ServiceHealth,
  ServiceProvisioningState,
  StoredIntegrationConfig,
  Task,
  TaskHistoryEntry,
  TaskProjectSummary,
  TaskStatus,
  WorkbenchAuthResponse,
  WorkbenchRefreshResponse,
  WorkbenchUserSession
} from "../types/models";

const SESSION_KEY = "workbench-session";
const NATIVE_SESSION_COMMANDS = {
  save: "secure_session_save",
  read: "secure_session_read",
  clear: "secure_session_clear"
} as const;

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

function authHeaders(extra?: HeadersInit): HeadersInit {
  const session = readStoredSession();
  return {
    ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    ...(extra ?? {})
  };
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

async function requestJson<T>(url: string, options?: RequestInit, withSessionAuth = true): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(withSessionAuth ? authHeaders(options?.headers) : (options?.headers ?? {}))
      },
      ...options
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    const message = `Connection failed for ${url}: ${detail}`;
    pushErrorNotification(message, "Connection Error");
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

async function refreshAccessToken(refreshToken: string): Promise<void> {
  const refreshed = await requestJson<WorkbenchRefreshResponse>(
    `${workbenchCoreUrl}/auth/refresh`,
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

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  await initializeSessionStorage();
  try {
    return await requestJson<T>(url, options, true);
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
      return await requestJson<T>(url, options, true);
    } catch {
      await clearWorkbenchSession();
      throw error;
    }
  }
}

async function fetchWithSessionAuth(url: string, options?: RequestInit): Promise<Response> {
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
      pushErrorNotification(message, "Connection Error");
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
    return fetchJson<Note[]>(`${workbenchCoreUrl}/api/notes?${params.toString()}`);
  },
  get: (id: string): Promise<Note> => fetchJson<Note>(`${workbenchCoreUrl}/api/notes/${encodeURIComponent(id)}`),
  create: (payload: Omit<Note, "id" | "createdAt" | "updatedAt">): Promise<Note> =>
    fetchJson<Note>(`${workbenchCoreUrl}/api/notes`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Note, "id" | "createdAt" | "updatedAt">>
  ): Promise<Note> =>
    fetchJson<Note>(`${workbenchCoreUrl}/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchJson<void>(`${workbenchCoreUrl}/api/notes/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<NoteProjectSummary[]> => fetchJson<NoteProjectSummary[]>(`${workbenchCoreUrl}/api/notes/projects`)
};

export const artifactsApi = {
  list: (projectId?: string, limit?: number): Promise<Artifact[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (limit) params.set("limit", String(limit));
    return fetchJson<Artifact[]>(`${workbenchCoreUrl}/api/artifacts?${params.toString()}`);
  },
  get: (id: string): Promise<Artifact> => fetchJson<Artifact>(`${workbenchCoreUrl}/api/artifacts/${encodeURIComponent(id)}`),
  create: (payload: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Promise<Artifact> =>
    fetchJson<Artifact>(`${workbenchCoreUrl}/api/artifacts`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Artifact, "id" | "createdAt" | "updatedAt">>
  ): Promise<Artifact> =>
    fetchJson<Artifact>(`${workbenchCoreUrl}/api/artifacts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchJson<void>(`${workbenchCoreUrl}/api/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<ArtifactProjectSummary[]> =>
    fetchJson<ArtifactProjectSummary[]>(`${workbenchCoreUrl}/api/artifacts/projects`),
  tree: (projectId?: string): Promise<ArtifactItem[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    return fetchJson<ArtifactItem[]>(`${workbenchCoreUrl}/api/artifacts/tree?${params.toString()}`);
  },
  getItem: (id: string): Promise<ArtifactItem> =>
    fetchJson<ArtifactItem>(`${workbenchCoreUrl}/api/artifacts/items/${encodeURIComponent(id)}`),
  createFolder: (payload: {
    projectId: string;
    projectName?: string;
    path: string;
    title?: string;
    scope?: "private" | "org" | "project";
  }): Promise<ArtifactItem> =>
    fetchJson<ArtifactItem>(`${workbenchCoreUrl}/api/artifacts/folders`, {
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
    fetchJson<ArtifactItem>(`${workbenchCoreUrl}/api/artifacts/notes`, {
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

    const response = await fetchWithSessionAuth(`${workbenchCoreUrl}/api/artifacts/upload`, {
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
      scope?: "private" | "org" | "project";
      tags?: string[];
      contentMarkdown?: string;
      projectName?: string;
    }
  ): Promise<ArtifactItem> =>
    fetchJson<ArtifactItem>(`${workbenchCoreUrl}/api/artifacts/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeItem: (id: string): Promise<void> =>
    fetchJson<void>(`${workbenchCoreUrl}/api/artifacts/items/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  downloadFile: async (id: string, asAttachment = false): Promise<Blob> => {
    const params = new URLSearchParams();
    if (asAttachment) params.set("download", "1");
    const suffix = params.toString() ? `?${params.toString()}` : "";

    const response = await fetchWithSessionAuth(
      `${workbenchCoreUrl}/api/artifacts/items/${encodeURIComponent(id)}/download${suffix}`
    );

    if (!response.ok) {
      const message = `Download failed: ${response.status}`;
      pushErrorNotification(message, "Artifacts Download Error");
      throw new Error(message);
    }

    return response.blob();
  }
};

export const deepResearchApi = {
  defaults: (): Promise<DeepResearchDefaultsResponse> =>
    fetchJson<DeepResearchDefaultsResponse>(`${workbenchCoreUrl}/api/deep-research/defaults`),
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
    fetchJson<DeepResearchRunResponse>(`${workbenchCoreUrl}/api/deep-research`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  status: (jobId: string): Promise<DeepResearchStatusResponse> =>
    fetchJson<DeepResearchStatusResponse>(`${workbenchCoreUrl}/api/deep-research/jobs/${encodeURIComponent(jobId)}`),
  list: async (limit = 50): Promise<{ items: DeepResearchHistoryEntry[]; unsupported?: boolean }> => {
    try {
      return await fetchJson<{ items: DeepResearchHistoryEntry[]; unsupported?: boolean }>(
        `${workbenchCoreUrl}/api/deep-research/jobs?limit=${encodeURIComponent(String(limit))}`
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
      `${workbenchCoreUrl}/api/deep-research/jobs/${encodeURIComponent(jobId)}/cancel`,
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
    }
  ): Promise<{ status: string; artifact: DeepResearchRunResponse["artifact"] }> =>
    fetchJson<{ status: string; artifact: DeepResearchRunResponse["artifact"] }>(
      `${workbenchCoreUrl}/api/deep-research/jobs/${encodeURIComponent(jobId)}/save`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {})
      }
    )
};

export const tasksApi = {
  list: (context?: string, status?: TaskStatus, limit?: number): Promise<Task[]> => {
    const params = new URLSearchParams();
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    return fetchJson<Task[]>(`${workbenchCoreUrl}/api/tasks?${params.toString()}`);
  },
  get: (id: string): Promise<Task> => fetchJson<Task>(`${workbenchCoreUrl}/api/tasks/${encodeURIComponent(id)}`),
  create: (payload: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> =>
    fetchJson<Task>(`${workbenchCoreUrl}/api/tasks`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>
  ): Promise<Task> =>
    fetchJson<Task>(`${workbenchCoreUrl}/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchJson<void>(`${workbenchCoreUrl}/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<TaskProjectSummary[]> => fetchJson<TaskProjectSummary[]>(`${workbenchCoreUrl}/api/tasks/projects`),
  history: (id: string): Promise<TaskHistoryEntry[]> =>
    fetchJson<TaskHistoryEntry[]>(`${workbenchCoreUrl}/api/tasks/${encodeURIComponent(id)}/history`),
  exportCsv: async (): Promise<Blob> => {
    await initializeSessionStorage();
    const requestExport = async (): Promise<Response> =>
      fetch(`${workbenchCoreUrl}/api/tasks/export`, {
        headers: {
          Accept: "text/csv",
          ...authHeaders()
        }
      });

    let response = await requestExport();
    if (response.status === 401) {
      const session = readStoredSession();
      if (session?.refreshToken) {
        await refreshAccessToken(session.refreshToken);
        response = await requestExport();
      }
    }

    if (!response.ok) {
      throw new Error(`Export failed: ${response.status}`);
    }
    return response.blob();
  },
  importCsv: (file: File): Promise<{ imported: number }> => {
    const formData = new FormData();
    formData.append("file", file);
    return file.text().then((text) =>
      fetchJson<{ imported: number }>(`${workbenchCoreUrl}/api/tasks/import`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text
      })
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
    return fetchJson<ProjectListResult>(`${workbenchCoreUrl}/api/projects?${params.toString()}`);
  },
  get: (id: string): Promise<ProjectRecord> =>
    fetchJson<ProjectRecord>(`${workbenchCoreUrl}/api/projects/${encodeURIComponent(id)}`),
  create: (payload: { name: string; description?: string; status?: "draft" | "active" | "archived" }): Promise<ProjectRecord> =>
    fetchJson<ProjectRecord>(`${workbenchCoreUrl}/api/projects`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (id: string, payload: Partial<Pick<ProjectRecord, "name" | "description" | "status">>): Promise<ProjectRecord> =>
    fetchJson<ProjectRecord>(`${workbenchCoreUrl}/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchJson<void>(`${workbenchCoreUrl}/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  getDefault: (): Promise<ProjectDefaultSelection> =>
    fetchJson<ProjectDefaultSelection>(`${workbenchCoreUrl}/api/projects/default`),
  setDefault: (projectId: string): Promise<ProjectDefaultSelection> =>
    fetchJson<ProjectDefaultSelection>(`${workbenchCoreUrl}/api/projects/default`, {
      method: "PUT",
      body: JSON.stringify({ projectId })
    })
};

export async function checkServiceHealth(serviceId: "notes" | "artifacts" | "tasks"): Promise<ServiceHealth> {
  try {
    const health = await fetchJson<ServiceHealth>(`${workbenchCoreUrl}/health`);
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
    return await fetchJson<IntegrationManifest[]>(`${workbenchCoreUrl}/integrations/manifests`);
  } catch {
    return [];
  }
}

export const coreApi = {
  register: (username: string, password: string): Promise<WorkbenchAuthResponse> =>
    fetchJson(`${workbenchCoreUrl}/accounts/register`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  login: (username: string, password: string): Promise<WorkbenchAuthResponse> =>
    fetchJson(`${workbenchCoreUrl}/accounts/login`, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  refresh: (refreshToken: string): Promise<WorkbenchRefreshResponse> =>
    requestJson(
      `${workbenchCoreUrl}/auth/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken })
      },
      false
    ),
  me: (): Promise<{ user: WorkbenchUserSession; provisioning: ServiceProvisioningState[] }> =>
    fetchJson(`${workbenchCoreUrl}/auth/me`),
  listIntegrationConfigs: (): Promise<StoredIntegrationConfig[]> =>
    fetchJson(`${workbenchCoreUrl}/integrations/configs`),
  saveIntegrationConfig: (
    integrationId: string,
    payload: { enabled: boolean; values: Record<string, string | number | boolean> }
  ): Promise<{ status: string }> =>
    fetchJson(`${workbenchCoreUrl}/integrations/configs/${encodeURIComponent(integrationId)}`, {
      method: "PUT",
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
}

export async function clearWorkbenchSession(): Promise<void> {
  sessionCache = undefined;
  await clearSessionFromStorage();
}

export function readWorkbenchSession(): WorkbenchUserSession | undefined {
  return readStoredSession()?.user;
}
