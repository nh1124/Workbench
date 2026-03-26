import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

type ServiceId = "notes" | "artifacts" | "tasks" | "projects" | "lbs";

type ServiceConfig = {
  id: ServiceId;
  baseUrl: string;
};

const notesService: ServiceConfig = { id: "notes", baseUrl: requireEnv("NOTES_SERVICE_URL") };
const artifactsService: ServiceConfig = { id: "artifacts", baseUrl: requireEnv("ARTIFACTS_SERVICE_URL") };
const tasksService: ServiceConfig = { id: "tasks", baseUrl: requireEnv("TASKS_SERVICE_URL") };
const projectsBaseUrl = optionalEnv("PROJECTS_SERVICE_URL");
const projectsService: ServiceConfig | undefined = projectsBaseUrl ? { id: "projects", baseUrl: projectsBaseUrl } : undefined;

const lbsBaseUrl = optionalEnv("LBS_SERVICE_URL");
const lbsService: ServiceConfig | undefined = lbsBaseUrl ? { id: "lbs", baseUrl: lbsBaseUrl } : undefined;

export const serviceBaseUrls = {
  notes: notesService.baseUrl,
  artifacts: artifactsService.baseUrl,
  tasks: tasksService.baseUrl,
  projects: projectsService?.baseUrl,
  lbs: lbsService?.baseUrl
} as const;

export class InternalServiceError extends Error {
  status: number;
  service: ServiceId;
  body: string;

  constructor(service: ServiceId, status: number, body: string) {
    super(body || `${service} service request failed with HTTP ${status}`);
    this.status = status;
    this.service = service;
    this.body = body;
  }
}

async function serviceRequest<T>(
  service: ServiceConfig,
  path: string,
  token: string,
  init?: RequestInit,
  parse: "json" | "text" = "json"
): Promise<T> {
  const response = await fetch(`${service.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new InternalServiceError(service.id, response.status, text || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (parse === "text") {
    return text as T;
  }

  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

function decodeContentDispositionFilename(contentDisposition: string | null): string | undefined {
  if (!contentDisposition) {
    return undefined;
  }

  const utf8Match = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const quotedMatch = contentDisposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1];
  }

  const plainMatch = contentDisposition.match(/filename\s*=\s*([^;]+)/i);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim();
  }

  return undefined;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sp.set(key, String(value));
    }
  }
  const query = sp.toString();
  return query ? `?${query}` : "";
}

export const notesClient = {
  list: (token: string, projectId?: string, limit?: number) =>
    serviceRequest<unknown[]>(notesService, `/notes${buildQuery({ projectId, limit })}`, token),
  get: (token: string, id: string) => serviceRequest<unknown>(notesService, `/notes/${encodeURIComponent(id)}`, token),
  create: (token: string, payload: unknown) =>
    serviceRequest<unknown>(notesService, "/notes", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  update: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(notesService, `/notes/${encodeURIComponent(id)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  remove: (token: string, id: string) =>
    serviceRequest<void>(notesService, `/notes/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  projects: (token: string) => serviceRequest<unknown[]>(notesService, "/projects", token)
};

export const artifactsClient = {
  list: (token: string, projectId?: string, limit?: number) =>
    serviceRequest<unknown[]>(artifactsService, `/artifacts${buildQuery({ projectId, limit })}`, token),
  get: (token: string, id: string) => serviceRequest<unknown>(artifactsService, `/artifacts/${encodeURIComponent(id)}`, token),
  create: (token: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, "/artifacts", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  update: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/${encodeURIComponent(id)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  remove: (token: string, id: string) =>
    serviceRequest<void>(artifactsService, `/artifacts/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  projects: (token: string) => serviceRequest<unknown[]>(artifactsService, "/projects", token),
  tree: (token: string, projectId?: string) =>
    serviceRequest<unknown[]>(artifactsService, `/artifacts/tree${buildQuery({ projectId })}`, token),
  getItem: (token: string, id: string) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}`, token),
  createFolder: (token: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, "/artifacts/folders", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  createNote: (token: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, "/artifacts/notes", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  updateItem: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  removeItem: (token: string, id: string) =>
    serviceRequest<void>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  uploadFile: async (
    token: string,
    payload: {
      projectId?: string;
      projectName?: string;
      directoryPath?: string;
      scope?: "private" | "org" | "project";
      tags?: string[];
      filename: string;
      mimeType?: string;
      contentBase64: string;
    }
  ) => {
    const fileBuffer = Buffer.from(payload.contentBase64, "base64");
    const formData = new FormData();
    if (payload.projectId) formData.append("projectId", payload.projectId);
    if (payload.projectName) formData.append("projectName", payload.projectName);
    if (payload.directoryPath) formData.append("directoryPath", payload.directoryPath);
    if (payload.scope) formData.append("scope", payload.scope);
    if (payload.tags?.length) formData.append("tags", JSON.stringify(payload.tags));
    formData.append(
      "file",
      new Blob([fileBuffer], { type: payload.mimeType || "application/octet-stream" }),
      payload.filename
    );

    const response = await fetch(`${artifactsService.baseUrl}/artifacts/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: formData
    });

    const text = await response.text();
    if (!response.ok) {
      throw new InternalServiceError(artifactsService.id, response.status, text || `HTTP ${response.status}`);
    }
    if (!text.trim()) {
      return undefined as unknown;
    }
    return JSON.parse(text) as unknown;
  },
  downloadFile: async (token: string, id: string, asAttachment = true) => {
    const suffix = asAttachment ? "?download=1" : "";
    const response = await fetch(
      `${artifactsService.baseUrl}/artifacts/items/${encodeURIComponent(id)}/download${suffix}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const arrayBuffer = await response.arrayBuffer();
    if (!response.ok) {
      const text = Buffer.from(arrayBuffer).toString("utf8");
      throw new InternalServiceError(artifactsService.id, response.status, text || `HTTP ${response.status}`);
    }

    const contentDisposition = response.headers.get("content-disposition");
    const fileName = decodeContentDispositionFilename(contentDisposition) ?? id;
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    const sizeBytesHeader = response.headers.get("content-length");
    const sizeBytes = sizeBytesHeader ? Number(sizeBytesHeader) : arrayBuffer.byteLength;
    const contentBase64 = Buffer.from(arrayBuffer).toString("base64");

    return {
      id,
      fileName,
      mimeType,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : arrayBuffer.byteLength,
      contentBase64
    };
  }
};

export const tasksClient = {
  list: (token: string, context?: string, status?: string, limit?: number) =>
    serviceRequest<unknown[]>(tasksService, `/tasks${buildQuery({ context, status, limit })}`, token),
  pins: (token: string) => serviceRequest<{ taskIds: string[] }>(tasksService, "/tasks/pins", token),
  setPin: (token: string, id: string, pinned: boolean) =>
    serviceRequest<{ taskId: string; pinned: boolean }>(tasksService, `/tasks/${encodeURIComponent(id)}/pin`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned })
    }),
  schedule: (token: string, startDate: string, endDate: string, context?: string, status?: string) =>
    serviceRequest<unknown[]>(
      tasksService,
      `/tasks/schedule${buildQuery({ startDate, endDate, context, status })}`,
      token
    ),
  completeOccurrence: (token: string, id: string, targetDate: string, status: string) =>
    serviceRequest<{ taskId: string; targetDate: string; status: string }>(
      tasksService,
      `/tasks/${encodeURIComponent(id)}/occurrences/complete`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDate, status })
      }
    ),
  moveOccurrence: (token: string, id: string, sourceDate: string, targetDate: string) =>
    serviceRequest<{ taskId: string; sourceDate: string; targetDate: string }>(
      tasksService,
      `/tasks/${encodeURIComponent(id)}/occurrences/move`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceDate, targetDate })
      }
    ),
  skipOccurrenceException: (token: string, id: string, targetDate: string) =>
    serviceRequest<{ taskId: string; targetDate: string }>(
      tasksService,
      `/tasks/${encodeURIComponent(id)}/occurrences/skip-exception`,
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDate })
      }
    ),
  get: (token: string, id: string) => serviceRequest<unknown>(tasksService, `/tasks/${encodeURIComponent(id)}`, token),
  create: (token: string, payload: unknown) =>
    serviceRequest<unknown>(tasksService, "/tasks", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  update: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(tasksService, `/tasks/${encodeURIComponent(id)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  remove: (token: string, id: string) =>
    serviceRequest<void>(tasksService, `/tasks/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
  projects: (token: string) => serviceRequest<unknown[]>(tasksService, "/projects", token),
  history: (token: string, id: string) => serviceRequest<unknown[]>(tasksService, `/tasks/${encodeURIComponent(id)}/history`, token),
  exportCsv: (token: string) =>
    serviceRequest<string>(tasksService, "/tasks/export", token, { headers: { Accept: "text/csv" } }, "text"),
  importCsv: (token: string, csvContent: string) =>
    serviceRequest<{ imported: number }>(tasksService, "/tasks/import", token, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csvContent
    }),

  // ── Attachments ─────────────────────────────────────────────────────────────
  listAttachments: (token: string, taskId: string) =>
    serviceRequest<unknown[]>(tasksService, `/tasks/${encodeURIComponent(taskId)}/attachments`, token),

  uploadAttachment: async (
    token: string,
    taskId: string,
    payload: { filename: string; mimeType?: string; contentBase64: string }
  ) => {
    const fileBuffer = Buffer.from(payload.contentBase64, "base64");
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileBuffer], { type: payload.mimeType || "application/octet-stream" }),
      payload.filename
    );

    const response = await fetch(`${tasksService.baseUrl}/tasks/${encodeURIComponent(taskId)}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    });

    const text = await response.text();
    if (!response.ok) {
      throw new InternalServiceError(tasksService.id, response.status, text || `HTTP ${response.status}`);
    }
    return JSON.parse(text) as unknown;
  },

  downloadAttachment: async (token: string, taskId: string, attachmentId: string, asAttachment = true) => {
    const suffix = asAttachment ? "?download=1" : "";
    const response = await fetch(
      `${tasksService.baseUrl}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download${suffix}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const arrayBuffer = await response.arrayBuffer();
    if (!response.ok) {
      const text = Buffer.from(arrayBuffer).toString("utf8");
      throw new InternalServiceError(tasksService.id, response.status, text || `HTTP ${response.status}`);
    }

    const contentDisposition = response.headers.get("content-disposition");
    const fileName = decodeContentDispositionFilename(contentDisposition) ?? attachmentId;
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    const sizeBytes = arrayBuffer.byteLength;
    const contentBase64 = Buffer.from(arrayBuffer).toString("base64");
    return { attachmentId, fileName, mimeType, sizeBytes, contentBase64 };
  },

  deleteAttachment: (token: string, taskId: string, attachmentId: string) =>
    serviceRequest<void>(
      tasksService,
      `/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      token,
      { method: "DELETE" }
    ),

  // ── Subtasks ─────────────────────────────────────────────────────────────────
  listSubtasks: (token: string, taskId: string, occurrenceDate: string) =>
    serviceRequest<unknown[]>(
      tasksService,
      `/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks`,
      token
    ),

  createSubtask: (token: string, taskId: string, occurrenceDate: string, title: string) =>
    serviceRequest<unknown>(
      tasksService,
      `/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks`,
      token,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }
    ),

  updateSubtask: (
    token: string,
    taskId: string,
    occurrenceDate: string,
    subtaskId: string,
    updates: { title?: string; isDone?: boolean; sortOrder?: number }
  ) =>
    serviceRequest<unknown>(
      tasksService,
      `/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks/${encodeURIComponent(subtaskId)}`,
      token,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) }
    ),

  deleteSubtask: (token: string, taskId: string, occurrenceDate: string, subtaskId: string) =>
    serviceRequest<void>(
      tasksService,
      `/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(occurrenceDate)}/subtasks/${encodeURIComponent(subtaskId)}`,
      token,
      { method: "DELETE" }
    )
};

function requireLbs(): ServiceConfig {
  if (!lbsService) throw new Error("LBS service is not configured (LBS_SERVICE_URL missing)");
  return lbsService;
}

export const lbsClient = {
  // ── Analytics / Condition ──────────────────────────────────────────────────
  dashboard: (token: string) =>
    serviceRequest<unknown>(requireLbs(), "/dashboard", token),

  calculate: (token: string, date: string, statuses?: string[]) => {
    const qs = statuses?.length ? `?${statuses.map(s => `status=${encodeURIComponent(s)}`).join("&")}` : "";
    return serviceRequest<unknown>(requireLbs(), `/calculate/${encodeURIComponent(date)}${qs}`, token);
  },

  heatmap: (token: string, statuses?: string[]) => {
    const qs = statuses?.length ? `?${statuses.map(s => `status=${encodeURIComponent(s)}`).join("&")}` : "";
    return serviceRequest<unknown>(requireLbs(), `/heatmap${qs}`, token);
  },

  trends: (token: string, statuses?: string[]) => {
    const qs = statuses?.length ? `?${statuses.map(s => `status=${encodeURIComponent(s)}`).join("&")}` : "";
    return serviceRequest<unknown>(requireLbs(), `/trends${qs}`, token);
  },

  contextDistribution: (token: string, statuses?: string[]) => {
    const qs = statuses?.length ? `?${statuses.map(s => `status=${encodeURIComponent(s)}`).join("&")}` : "";
    return serviceRequest<unknown>(requireLbs(), `/context-distribution${qs}`, token);
  },

  // ── Schedule ───────────────────────────────────────────────────────────────
  schedule: (token: string, startDate: string, endDate: string) =>
    serviceRequest<unknown>(requireLbs(), `/schedule${buildQuery({ start_date: startDate, end_date: endDate })}`, token),

  // ── Task Execution ─────────────────────────────────────────────────────────
  recordExecution: (token: string, taskId: string, payload: { target_date: string; status: string; progress?: number; actual_time?: number }) =>
    serviceRequest<unknown>(requireLbs(), `/tasks/${encodeURIComponent(taskId)}/complete`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),

  taskHistory: (token: string, taskId: string) =>
    serviceRequest<unknown[]>(requireLbs(), `/tasks/${encodeURIComponent(taskId)}/history`, token),

  // ── Exceptions ─────────────────────────────────────────────────────────────
  listExceptions: (token: string, taskId?: string, startDate?: string, endDate?: string) =>
    serviceRequest<unknown[]>(requireLbs(), `/exceptions${buildQuery({ task_id: taskId, start_date: startDate, end_date: endDate })}`, token),

  createException: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireLbs(), "/exceptions", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),

  updateException: (token: string, id: string | number, payload: unknown) =>
    serviceRequest<unknown>(requireLbs(), `/exceptions/${encodeURIComponent(String(id))}`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),

  deleteException: (token: string, id: string | number) =>
    serviceRequest<void>(requireLbs(), `/exceptions/${encodeURIComponent(String(id))}`, token, { method: "DELETE" }),

  // ── Expansion ──────────────────────────────────────────────────────────────
  expand: (token: string, payload: { start_date: string; end_date: string }) =>
    serviceRequest<unknown>(requireLbs(), "/expand", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
};

export const projectsClient = {
  list: (token: string, query?: string, status?: string, limit?: number, cursor?: string) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<unknown>(projectsService, `/projects${buildQuery({ q: query, status, limit, cursor })}`, token);
  },
  get: (token: string, id: string) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(id)}`, token);
  },
  create: (token: string, payload: unknown) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<unknown>(projectsService, "/projects", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  update: (token: string, id: string, payload: unknown) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(id)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  remove: (token: string, id: string) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<void>(projectsService, `/projects/${encodeURIComponent(id)}`, token, {
      method: "DELETE"
    });
  },
  getDefault: (token: string) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<unknown>(projectsService, "/projects/default", token);
  },
  setDefault: (token: string, payload: unknown) => {
    if (!projectsService) {
      throw new Error("Projects service is not configured");
    }
    return serviceRequest<unknown>(projectsService, "/projects/default", token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
};
