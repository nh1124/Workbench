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

type ServiceId = "notes" | "artifacts" | "tasks" | "projects";

type ServiceConfig = {
  id: ServiceId;
  baseUrl: string;
};

const notesService: ServiceConfig = { id: "notes", baseUrl: requireEnv("NOTES_SERVICE_URL") };
const artifactsService: ServiceConfig = { id: "artifacts", baseUrl: requireEnv("ARTIFACTS_SERVICE_URL") };
const tasksService: ServiceConfig = { id: "tasks", baseUrl: requireEnv("TASKS_SERVICE_URL") };
const projectsBaseUrl = optionalEnv("PROJECTS_SERVICE_URL");
const projectsService: ServiceConfig | undefined = projectsBaseUrl ? { id: "projects", baseUrl: projectsBaseUrl } : undefined;

export const serviceBaseUrls = {
  notes: notesService.baseUrl,
  artifacts: artifactsService.baseUrl,
  tasks: tasksService.baseUrl,
  projects: projectsService?.baseUrl
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
    serviceRequest<void>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}`, token, { method: "DELETE" })
};

export const tasksClient = {
  list: (token: string, context?: string, status?: string, limit?: number) =>
    serviceRequest<unknown[]>(tasksService, `/tasks${buildQuery({ context, status, limit })}`, token),
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
