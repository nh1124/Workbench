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

type ServiceId = "notes" | "artifacts" | "tasks" | "projects" | "lbs" | "images" | "mindmaps" | "wbs" | "analyser";

type ServiceConfig = {
  id: ServiceId;
  baseUrl: string;
};

const notesService: ServiceConfig = { id: "notes", baseUrl: requireEnv("NOTES_SERVICE_URL") };
const artifactsService: ServiceConfig = { id: "artifacts", baseUrl: requireEnv("ARTIFACTS_SERVICE_URL") };
const tasksService: ServiceConfig = { id: "tasks", baseUrl: requireEnv("TASKS_SERVICE_URL") };
const imagesService: ServiceConfig = { id: "images", baseUrl: requireEnv("IMAGES_SERVICE_URL") };
const mindmapsService: ServiceConfig = { id: "mindmaps", baseUrl: requireEnv("MINDMAPS_SERVICE_URL") };
const wbsService: ServiceConfig = { id: "wbs", baseUrl: requireEnv("WBS_SERVICE_URL") };
const projectsBaseUrl = optionalEnv("PROJECTS_SERVICE_URL");
const projectsService: ServiceConfig | undefined = projectsBaseUrl ? { id: "projects", baseUrl: projectsBaseUrl } : undefined;

const lbsBaseUrl = optionalEnv("LBS_SERVICE_URL");
const lbsService: ServiceConfig | undefined = lbsBaseUrl ? { id: "lbs", baseUrl: lbsBaseUrl } : undefined;

const analyserBaseUrl = optionalEnv("ANALYSER_SERVICE_URL");
const analyserService: ServiceConfig | undefined = analyserBaseUrl ? { id: "analyser", baseUrl: analyserBaseUrl } : undefined;
const analyserInternalApiKey = optionalEnv("INTERNAL_API_KEY_ANALYSER");

const CORE_MUTATION_ORIGIN_HEADER = "x-workbench-core-mutation";
const CORE_MUTATION_TOKEN_HEADER = "x-workbench-core-mutation-token";
const coreMutationToken = optionalEnv("WORKBENCH_CORE_MUTATION_TOKEN");

export const serviceBaseUrls = {
  notes: notesService.baseUrl,
  artifacts: artifactsService.baseUrl,
  tasks: tasksService.baseUrl,
  images: imagesService.baseUrl,
  mindmaps: mindmapsService.baseUrl,
  wbs: wbsService.baseUrl,
  projects: projectsService?.baseUrl,
  lbs: lbsService?.baseUrl,
  analyser: analyserService?.baseUrl
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

function isMutationRequest(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function buildServiceHeaders(token: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);

  if (isMutationRequest(init)) {
    headers.set(CORE_MUTATION_ORIGIN_HEADER, "1");
    if (coreMutationToken) {
      headers.set(CORE_MUTATION_TOKEN_HEADER, coreMutationToken);
    }
  }

  return headers;
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
    headers: buildServiceHeaders(token, init)
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

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sp.set(key, String(value));
    }
  }
  const query = sp.toString();
  return query ? `?${query}` : "";
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function artifactTreeRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(asJsonRecord(item)));
  }

  const record = asJsonRecord(value);
  if (Array.isArray(record?.items)) {
    return record.items.filter((item): item is Record<string, unknown> => Boolean(asJsonRecord(item)));
  }

  return [];
}

function projectDisplayName(project: unknown): string | null {
  const record = asJsonRecord(project);
  const name = typeof record?.name === "string" ? record.name.trim() : "";
  return name || null;
}

async function resolveProjectDisplayNameBestEffort(token: string, projectId: string): Promise<string | null> {
  try {
    return projectDisplayName(await projectsClient.get(token, projectId));
  } catch {
    return null;
  }
}

export async function resolveArtifactTreeProjectNames<T>(token: string, payload: T): Promise<T> {
  const records = artifactTreeRecords(payload);
  const projectIds = [...new Set(
    records
      .map((record) => (typeof record.projectId === "string" ? record.projectId.trim() : ""))
      .filter((projectId) => projectId.length > 0)
  )];
  const projectNames = new Map<string, string | null>();

  await Promise.all(
    projectIds.map(async (projectId) => {
      projectNames.set(projectId, await resolveProjectDisplayNameBestEffort(token, projectId));
    })
  );

  for (const record of records) {
    const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
    if (projectId) {
      record.projectName = projectNames.get(projectId) ?? null;
    }
  }

  return payload;
}

export async function resolveArtifactItemProjectName<T>(token: string, payload: T): Promise<T> {
  const record = asJsonRecord(payload);
  if (!record) return payload;

  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
  record.projectName = projectId ? await resolveProjectDisplayNameBestEffort(token, projectId) : null;
  return payload;
}

export const notesClient = {
  list: (token: string, projectId?: string, limit?: number) =>
    serviceRequest<unknown[]>(notesService, `/notes${buildQuery({ projectId, limit })}`, token),
  listPage: (token: string, projectId?: string, limit?: number, cursor?: string) =>
    serviceRequest<unknown>(notesService, `/notes${buildQuery({ projectId, limit, cursor, page: true })}`, token),
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
  tree: async (token: string, projectId?: string) =>
    resolveArtifactTreeProjectNames(
      token,
      await serviceRequest<unknown[]>(artifactsService, `/artifacts/tree${buildQuery({ projectId })}`, token)
    ),
  treeList: (
    token: string,
    options: {
      projectId?: string;
      pathPrefix?: string;
      kinds?: string[];
      includeContent?: boolean;
      updatedSince?: string;
      limit?: number;
    }
  ) =>
    serviceRequest<unknown[]>(
      artifactsService,
      `/artifacts/tree/list${buildQuery({
        projectId: options.projectId,
        pathPrefix: options.pathPrefix,
        kinds: options.kinds?.join(","),
        includeContent: options.includeContent,
        updatedSince: options.updatedSince,
        limit: options.limit
      })}`,
      token
    ).then((result) => resolveArtifactTreeProjectNames(token, result)),
  treeListPage: (
    token: string,
    options: {
      projectId?: string;
      pathPrefix?: string;
      kinds?: string[];
      includeContent?: boolean;
      updatedSince?: string;
      limit?: number;
      cursor?: string;
    }
  ) =>
    serviceRequest<unknown>(
      artifactsService,
      `/artifacts/tree/list${buildQuery({
        projectId: options.projectId,
        pathPrefix: options.pathPrefix,
        kinds: options.kinds?.join(","),
        includeContent: options.includeContent,
        updatedSince: options.updatedSince,
        limit: options.limit,
        cursor: options.cursor,
        page: true
      })}`,
      token
    ).then((result) => resolveArtifactTreeProjectNames(token, result)),
  getItem: (token: string, id: string) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}`, token)
      .then((result) => resolveArtifactItemProjectName(token, result)),
  createFolder: (token: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, "/artifacts/folders", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((result) => resolveArtifactItemProjectName(token, result)),
  createNote: (token: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, "/artifacts/notes", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((result) => resolveArtifactItemProjectName(token, result)),
  updateItem: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((result) => resolveArtifactItemProjectName(token, result)),
  patchNoteContent: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}/content-patch`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((result) => resolveArtifactItemProjectName(token, result)),
  updateNoteSection: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(artifactsService, `/artifacts/items/${encodeURIComponent(id)}/section`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((result) => resolveArtifactItemProjectName(token, result)),
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
      headers: buildServiceHeaders(token, { method: "POST" }),
      body: formData
    });

    const text = await response.text();
    if (!response.ok) {
      throw new InternalServiceError(artifactsService.id, response.status, text || `HTTP ${response.status}`);
    }
    if (!text.trim()) {
      return undefined as unknown;
    }
    return resolveArtifactItemProjectName(token, JSON.parse(text) as unknown);
  },
  replaceFileContent: async (
    token: string,
    id: string,
    payload: {
      filename?: string;
      mimeType?: string;
      contentBase64: string;
      expectedVersion?: number;
    }
  ) => {
    const fileBuffer = Buffer.from(payload.contentBase64, "base64");
    const formData = new FormData();
    if (payload.expectedVersion !== undefined) {
      formData.append("expectedVersion", String(payload.expectedVersion));
    }
    if (payload.filename) {
      formData.append("filename", payload.filename);
    }
    formData.append(
      "file",
      new Blob([fileBuffer], { type: payload.mimeType || "application/octet-stream" }),
      payload.filename || id
    );

    const response = await fetch(`${artifactsService.baseUrl}/artifacts/items/${encodeURIComponent(id)}/file`, {
      method: "PUT",
      headers: buildServiceHeaders(token, { method: "PUT" }),
      body: formData
    });

    const text = await response.text();
    if (!response.ok) {
      throw new InternalServiceError(artifactsService.id, response.status, text || `HTTP ${response.status}`);
    }
    if (!text.trim()) {
      return undefined as unknown;
    }
    return resolveArtifactItemProjectName(token, JSON.parse(text) as unknown);
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

export const imagesClient = {
  defaults: (token: string) => serviceRequest<unknown>(imagesService, "/images/defaults", token),
  generate: (token: string, payload: unknown) =>
    serviceRequest<unknown>(imagesService, "/images/generations", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  list: (token: string, limit?: number) =>
    serviceRequest<unknown>(imagesService, `/images/generations${buildQuery({ limit })}`, token),
  getJob: (token: string, jobId: string) =>
    serviceRequest<unknown>(imagesService, `/images/generations/${encodeURIComponent(jobId)}`, token),
  cancel: (token: string, jobId: string) =>
    serviceRequest<unknown>(imagesService, `/images/generations/${encodeURIComponent(jobId)}/cancel`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }),
  deleteJob: (token: string, jobId: string) =>
    serviceRequest<void>(imagesService, `/images/generations/${encodeURIComponent(jobId)}`, token, { method: "DELETE" }),
  retry: (token: string, jobId: string, payload: unknown) =>
    serviceRequest<unknown>(imagesService, `/images/generations/${encodeURIComponent(jobId)}/retry`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {})
    }),
  getAsset: (token: string, assetId: string) =>
    serviceRequest<unknown>(imagesService, `/images/assets/${encodeURIComponent(assetId)}`, token),
  attachArtifact: (token: string, assetId: string, payload: unknown) =>
    serviceRequest<unknown>(imagesService, `/images/assets/${encodeURIComponent(assetId)}/artifact`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  downloadAsset: async (token: string, assetId: string, asAttachment = true) => {
    const suffix = asAttachment ? "?download=1" : "";
    const response = await fetch(`${imagesService.baseUrl}/images/assets/${encodeURIComponent(assetId)}/download${suffix}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const arrayBuffer = await response.arrayBuffer();
    if (!response.ok) {
      const text = Buffer.from(arrayBuffer).toString("utf8");
      throw new InternalServiceError(imagesService.id, response.status, text || `HTTP ${response.status}`);
    }

    const contentDisposition = response.headers.get("content-disposition");
    const fileName = decodeContentDispositionFilename(contentDisposition) ?? `${assetId}.png`;
    const mimeType = response.headers.get("content-type") ?? "image/png";
    const sizeBytes = arrayBuffer.byteLength;
    const contentBase64 = Buffer.from(arrayBuffer).toString("base64");
    return {
      id: assetId,
      fileName,
      mimeType,
      sizeBytes,
      contentBase64
    };
  },
  deleteAsset: (token: string, assetId: string) =>
    serviceRequest<void>(imagesService, `/images/assets/${encodeURIComponent(assetId)}`, token, { method: "DELETE" })
};

export const mindmapsClient = {
  list: (
    token: string,
    options: {
      projectId?: string;
      q?: string;
      mode?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ) =>
    serviceRequest<unknown>(
      mindmapsService,
      `/mindmaps${buildQuery({
        projectId: options.projectId,
        q: options.q,
        mode: options.mode,
        limit: options.limit,
        cursor: options.cursor
      })}`,
      token
    ),
  create: (token: string, payload: unknown) =>
    serviceRequest<unknown>(mindmapsService, "/mindmaps", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  get: (token: string, documentId: string) =>
    serviceRequest<unknown>(mindmapsService, `/mindmaps/${encodeURIComponent(documentId)}`, token),
  update: (token: string, documentId: string, payload: unknown) =>
    serviceRequest<unknown>(mindmapsService, `/mindmaps/${encodeURIComponent(documentId)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  remove: (token: string, documentId: string) =>
    serviceRequest<void>(mindmapsService, `/mindmaps/${encodeURIComponent(documentId)}`, token, { method: "DELETE" }),
  exportContent: (token: string, documentId: string, payload: unknown) =>
    serviceRequest<unknown>(mindmapsService, `/mindmaps/${encodeURIComponent(documentId)}/export`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {})
    }),
  recordArtifactExport: (token: string, documentId: string, payload: unknown) =>
    serviceRequest<unknown>(mindmapsService, `/mindmaps/${encodeURIComponent(documentId)}/artifact-exports`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
};

export const wbsClient = {
  listPlans: (
    token: string,
    options: {
      projectId?: string;
      q?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ) =>
    serviceRequest<unknown>(
      wbsService,
      `/wbs/plans${buildQuery({
        projectId: options.projectId,
        q: options.q,
        limit: options.limit,
        cursor: options.cursor
      })}`,
      token
    ),
  createPlan: (token: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, "/wbs/plans", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  getPlan: (token: string, planId: string) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}`, token),
  updatePlan: (token: string, planId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  removePlan: (token: string, planId: string, expectedVersion?: number) =>
    serviceRequest<void>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}`, token, {
      method: "DELETE",
      ...(expectedVersion !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion }) }
        : {})
    }),
  listItems: (token: string, planId: string) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}/items`, token),
  getItem: (token: string, itemId: string) =>
    serviceRequest<unknown>(wbsService, `/wbs/items/${encodeURIComponent(itemId)}`, token),
  createItem: (token: string, planId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}/items`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  updateItem: (token: string, itemId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/items/${encodeURIComponent(itemId)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  removeItem: (token: string, itemId: string, expectedVersion?: number) =>
    serviceRequest<unknown>(wbsService, `/wbs/items/${encodeURIComponent(itemId)}`, token, {
      method: "DELETE",
      ...(expectedVersion !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion }) }
        : {})
    }),
  moveItem: (token: string, itemId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/items/${encodeURIComponent(itemId)}/move`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listDependencies: (token: string, planId: string) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}/dependencies`, token),
  createDependency: (token: string, planId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}/dependencies`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  removeDependency: (token: string, dependencyId: string) =>
    serviceRequest<void>(wbsService, `/wbs/dependencies/${encodeURIComponent(dependencyId)}`, token, { method: "DELETE" }),
  exportContent: (token: string, planId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}/export`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {})
    }),
  recordArtifactExport: (token: string, planId: string, payload: unknown) =>
    serviceRequest<unknown>(wbsService, `/wbs/plans/${encodeURIComponent(planId)}/artifact-exports`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
};

function requireAnalyser(): ServiceConfig {
  if (!analyserService) throw new Error("Analyser service is not configured (ANALYSER_SERVICE_URL missing)");
  return analyserService;
}

function requireAnalyserInternalApiKey(): string {
  if (!analyserInternalApiKey) {
    throw new Error("Analyser service provisioning is not configured (INTERNAL_API_KEY_ANALYSER missing)");
  }
  return analyserInternalApiKey;
}

export type AnalyserInternalIngestResult = {
  ingested: number;
  duplicates: number;
  rejected: Record<string, number>;
};

export type AnalyserInternalEffectiveSettingsResult = {
  settings: { workbenchChanges: "off" | "metadata" };
  ownerVersion?: number;
  machineVersion?: number;
};

async function analyserInternalRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const service = requireAnalyser();
  const headers = new Headers(init?.headers ?? {});
  headers.set("x-api-key", requireAnalyserInternalApiKey());
  const response = await fetch(`${service.baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new InternalServiceError(service.id, response.status, text || `HTTP ${response.status}`);
  }
  return text.trim() ? JSON.parse(text) as T : undefined as T;
}

export const analyserInternalClient = {
  ingestObservations: (body: { coreUserId: string; machineId?: string; observations: unknown[] }) =>
    analyserInternalRequest<AnalyserInternalIngestResult>("/internal/observations/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
  getEffectiveSettings: (query: { coreUserId: string; machineId?: string }) =>
    analyserInternalRequest<AnalyserInternalEffectiveSettingsResult>(
      `/internal/settings/effective${buildQuery(query)}`
    )
};

type AnalyserEffectiveSettingsQuery = {
  machineId?: string;
};

type AnalyserObservationQuery = {
  source?: string;
  machineId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  limit?: string | number;
  cursor?: string;
};

type AnalyserActivityQuery = {
  from?: string;
  to?: string;
  machineId?: string;
};

type AnalyserSummaryQuery = {
  kind?: string;
  from?: string;
  to?: string;
  routineKey?: string;
  limit?: string | number;
  cursor?: string;
};

type AnalyserDerivedCaptureQuery = {
  kind?: string;
  machineId?: string;
  from?: string;
  to?: string;
  limit?: string | number;
  cursor?: string;
};

type AnalyserProposalQuery = {
  status?: string;
  kind?: string;
  routineKey?: string;
  limit?: string | number;
  cursor?: string;
};

type AnalyserOperationQuery = {
  operationKind?: string;
  result?: string;
  proposalId?: string;
  limit?: string | number;
  cursor?: string;
};

type AnalyserPublicationQuery = {
  sourceKind?: string;
  sourceId?: string;
  limit?: string | number;
  cursor?: string;
};

type AnalyserPublicationFindQuery = {
  sourceKind?: string;
  sourceId?: string;
  targetKind?: string;
  contentHash?: string;
};

export const analyserClient = {
  provisionAccount: async (payload: unknown) => {
    const service = requireAnalyser();
    const response = await fetch(`${service.baseUrl}/internal/accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": requireAnalyserInternalApiKey()
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new InternalServiceError(service.id, response.status, text || `HTTP ${response.status}`);
    }
    return text.trim() ? JSON.parse(text) as unknown : undefined;
  },
  registerMachine: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/machines/register", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listMachines: (token: string) => serviceRequest<unknown>(requireAnalyser(), "/machines", token),
  getSettings: (token: string) => serviceRequest<unknown>(requireAnalyser(), "/settings", token),
  getEffectiveSettings: (token: string, query: AnalyserEffectiveSettingsQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/settings/effective${buildQuery(query)}`, token),
  updateCollectionPolicy: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/settings/collection", token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  updateAutomationPolicy: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/settings/automation", token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  ingestObservations: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/observations/ingest", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listObservations: (token: string, query: AnalyserObservationQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/observations${buildQuery(query)}`, token),
  aggregateActivity: (token: string, query: AnalyserActivityQuery) =>
    serviceRequest<unknown>(requireAnalyser(), `/observations/aggregate${buildQuery(query)}`, token),
  listRoutines: (token: string) => serviceRequest<unknown>(requireAnalyser(), "/routines", token),
  routineStatus: (token: string) => serviceRequest<unknown>(requireAnalyser(), "/routines/status", token),
  seedRoutines: (token: string) =>
    serviceRequest<void>(requireAnalyser(), "/routines/seed", token, { method: "POST" }),
  createRoutine: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/routines", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  updateRoutine: (token: string, key: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/routines/${encodeURIComponent(key)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  deleteRoutine: (token: string, key: string) =>
    serviceRequest<void>(requireAnalyser(), `/routines/${encodeURIComponent(key)}`, token, { method: "DELETE" }),
  claimRoutine: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/routines/claim", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  heartbeatRun: (token: string, runId: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/runs/${encodeURIComponent(runId)}/heartbeat`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  pullRun: (token: string, runId: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/runs/${encodeURIComponent(runId)}/pull`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  completeRun: (token: string, runId: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/runs/${encodeURIComponent(runId)}/complete`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  failRun: (token: string, runId: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/runs/${encodeURIComponent(runId)}/fail`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  upsertSummary: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/summaries", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listSummaries: (token: string, query: AnalyserSummaryQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/summaries${buildQuery(query)}`, token),
  getSummary: (token: string, id: string) =>
    serviceRequest<unknown>(requireAnalyser(), `/summaries/${encodeURIComponent(id)}`, token),
  ingestDerivedCapture: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/captures/derived", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listDerivedCaptures: (token: string, query: AnalyserDerivedCaptureQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/captures/derived${buildQuery(query)}`, token),
  getDerivedCapture: (token: string, id: string) =>
    serviceRequest<unknown>(requireAnalyser(), `/captures/derived/${encodeURIComponent(id)}`, token),
  createProposal: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/proposals", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listProposals: (token: string, query: AnalyserProposalQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/proposals${buildQuery(query)}`, token),
  getProposal: (token: string, id: string) =>
    serviceRequest<unknown>(requireAnalyser(), `/proposals/${encodeURIComponent(id)}`, token),
  updateProposalContent: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/proposals/${encodeURIComponent(id)}/content`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  resolveProposal: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/proposals/${encodeURIComponent(id)}/resolve`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  supersedeProposal: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/proposals/${encodeURIComponent(id)}/supersede`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  markProposalExecuted: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/proposals/${encodeURIComponent(id)}/executed`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  recordOperation: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/operations", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listOperations: (token: string, query: AnalyserOperationQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/operations${buildQuery(query)}`, token),
  getOperation: (token: string, id: string) =>
    serviceRequest<unknown>(requireAnalyser(), `/operations/${encodeURIComponent(id)}`, token),
  recordPublication: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/publications", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  reservePublication: (token: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), "/publications/reserve", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  finalizePublication: (token: string, id: string, payload: unknown) =>
    serviceRequest<unknown>(requireAnalyser(), `/publications/${encodeURIComponent(id)}/finalize`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  listPublications: (token: string, query: AnalyserPublicationQuery = {}) =>
    serviceRequest<unknown>(requireAnalyser(), `/publications${buildQuery(query)}`, token),
  findPublication: (token: string, query: AnalyserPublicationFindQuery) =>
    serviceRequest<unknown>(requireAnalyser(), `/publications/find${buildQuery(query)}`, token),
  getStatus: (token: string) => serviceRequest<unknown>(requireAnalyser(), "/status", token)
};

export const tasksClient = {
  list: (token: string, context?: string, status?: string, limit?: number) =>
    serviceRequest<unknown[]>(tasksService, `/tasks${buildQuery({ context, status, limit })}`, token),
  listPage: (token: string, context?: string, status?: string, limit?: number, cursor?: string) =>
    serviceRequest<unknown>(tasksService, `/tasks${buildQuery({ context, status, limit, cursor, page: true })}`, token),
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
  replaceAttachment: async (
    token: string,
    taskId: string,
    attachmentId: string,
    payload: { filename?: string; mimeType?: string; contentBase64: string }
  ) => {
    const fileBuffer = Buffer.from(payload.contentBase64, "base64");
    const formData = new FormData();
    if (payload.filename) {
      formData.append("filename", payload.filename);
    }
    formData.append(
      "file",
      new Blob([fileBuffer], { type: payload.mimeType || "application/octet-stream" }),
      payload.filename || attachmentId
    );

    const response = await fetch(
      `${tasksService.baseUrl}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      }
    );

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
    ),

  // ── Today ("My Day") and Schedule ────────────────────────────────────────────
  // Returns TodayTask[] — Task objects enriched with occurrenceDate + schedule info.
  today: (token: string, date: string) =>
    serviceRequest<unknown[]>(tasksService, `/tasks/today${buildQuery({ date })}`, token),

  addToday: (
    token: string,
    taskId: string,
    scheduledDate: string,
    occurrenceDate: string,
    opts?: { startTime?: string; endTime?: string; timezone?: string }
  ) =>
    serviceRequest<{ id: number; taskId: string; occurrenceDate: string; scheduledDate: string }>(
      tasksService,
      "/tasks/today",
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, scheduledDate, occurrenceDate, ...opts })
      }
    ),

  removeFromToday: (token: string, taskId: string, scheduledDate: string, occurrenceDate?: string) =>
    serviceRequest<{ taskId: string; scheduledDate: string; removed: number }>(
      tasksService,
      `/tasks/today/${encodeURIComponent(taskId)}${buildQuery({ scheduledDate, occurrenceDate })}`,
      token,
      { method: "DELETE" }
    ),

  scheduleCalendar: (token: string, startDate: string, endDate: string) =>
    serviceRequest<unknown[]>(
      tasksService,
      `/tasks/schedule-calendar${buildQuery({ startDate, endDate })}`,
      token
    ),

  updateScheduleItem: (
    token: string,
    scheduleId: number,
    patch: { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null }
  ) =>
    serviceRequest<{ id: number; taskId: string; occurrenceDate: string; scheduledDate: string }>(
      tasksService,
      `/tasks/schedule-items/${scheduleId}`,
      token,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      }
    ),
  deleteScheduleItem: (token: string, scheduleId: number) =>
    serviceRequest<void>(tasksService, `/tasks/schedule-items/${scheduleId}`, token, { method: "DELETE" }),

  listScheduleItemsForTask: (token: string, taskId: string) =>
    serviceRequest<unknown[]>(tasksService, `/tasks/${encodeURIComponent(taskId)}/schedule-items`, token)
};

function requireLbs(): ServiceConfig {
  if (!lbsService) throw new Error("LBS service is not configured (LBS_SERVICE_URL missing)");
  return lbsService;
}

export const lbsClient = {
  // ── Analytics / Condition ──────────────────────────────────────────────────
  dashboard: (token: string, startDate?: string) =>
    serviceRequest<unknown>(requireLbs(), `/dashboard${buildQuery({ start_date: startDate })}`, token),

  calculate: (token: string, date: string, statuses?: string[]) => {
    const qs = statuses?.length ? `?${statuses.map(s => `status=${encodeURIComponent(s)}`).join("&")}` : "";
    return serviceRequest<unknown>(requireLbs(), `/calculate/${encodeURIComponent(date)}${qs}`, token);
  },

  heatmap: (token: string, startDate: string, endDate: string, statuses?: string[]) => {
    const params = new URLSearchParams({ start: startDate, end: endDate });
    for (const status of statuses ?? []) params.append("status", status);
    return serviceRequest<unknown>(requireLbs(), `/heatmap?${params.toString()}`, token);
  },

  trends: (token: string, weeks?: number, startDate?: string, statuses?: string[]) => {
    const params = new URLSearchParams();
    if (weeks !== undefined) params.set("weeks", String(weeks));
    if (startDate) params.set("start_date", startDate);
    for (const status of statuses ?? []) params.append("status", status);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return serviceRequest<unknown>(requireLbs(), `/trends${suffix}`, token);
  },

  contextDistribution: (token: string, startDate: string, endDate: string, statuses?: string[]) => {
    const params = new URLSearchParams({ start: startDate, end: endDate });
    for (const status of statuses ?? []) params.append("status", status);
    return serviceRequest<unknown>(requireLbs(), `/context-distribution?${params.toString()}`, token);
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

  // ── Conditions ───────────────────────────────────────────────────────────
  listConditions: (token: string, startDate: string, endDate: string) =>
    serviceRequest<unknown[]>(
      requireLbs(),
      `/conditions${buildQuery({ start_date: startDate, end_date: endDate })}`,
      token
    ),

  getCondition: (token: string, targetDate: string) =>
    serviceRequest<unknown>(requireLbs(), `/conditions/${encodeURIComponent(targetDate)}`, token),

  upsertCondition: (
    token: string,
    payload: { date: string; cognitive_fatigue: number; physical_fatigue?: number; note?: string }
  ) =>
    serviceRequest<unknown>(requireLbs(), "/conditions", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),

  deleteCondition: (token: string, targetDate: string) =>
    serviceRequest<void>(requireLbs(), `/conditions/${encodeURIComponent(targetDate)}`, token, { method: "DELETE" }),

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
  },
  getContext: (
    token: string,
    projectId: string,
    options: {
      q?: string;
      include?: string;
      memoryLimit?: number;
      indexLimit?: number;
      relationLimit?: number;
      maxChars?: number;
    } = {}
  ) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/context${buildQuery(options)}`,
      token
    );
  },
  getSyncContext: (token: string, projectId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/sync-context`,
      token
    );
  },
  getContextExport: (token: string, projectId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/context-export`,
      token
    );
  },
  getBrief: (token: string, projectId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(projectId)}/brief`, token);
  },
  updateBrief: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(projectId)}/brief`, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  listMemories: (
    token: string,
    projectId: string,
    options: { q?: string; kind?: string; authority?: string; status?: string; limit?: number; cursor?: string } = {}
  ) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/memories${buildQuery(options)}`,
      token
    );
  },
  appendMemory: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(projectId)}/memories`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  updateMemory: (token: string, memoryId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/project-memories/${encodeURIComponent(memoryId)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  listIndexEntries: (
    token: string,
    projectId: string,
    options: { q?: string; sourceService?: string; resourceType?: string; mode?: "any" | "all"; limit?: number; cursor?: string } = {}
  ) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/index-entries${buildQuery(options)}`,
      token
    );
  },
  upsertIndexEntry: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/index-entries/upsert`,
      token,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
  },
  tombstoneIndexEntry: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/index-entries/tombstone`,
      token,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
  },
  bulkUpsertIndexEntries: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/index-entries/bulk-upsert`,
      token,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
  },
  listRelations: (token: string, projectId: string, options: { limit?: number; cursor?: string } = {}) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/relations${buildQuery(options)}`,
      token
    );
  },
  createRelation: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(projectId)}/relations`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  updateRelation: (token: string, relationId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/project-relations/${encodeURIComponent(relationId)}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  getRelation: (token: string, relationId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/project-relations/${encodeURIComponent(relationId)}`, token);
  },
  removeRelation: (token: string, relationId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<void>(projectsService, `/project-relations/${encodeURIComponent(relationId)}`, token, {
      method: "DELETE"
    });
  },
  listLinks: (
    token: string,
    projectId: string,
    options: {
      targetService?: string;
      targetResourceType?: string;
      targetResourceId?: string;
      relationType?: string;
      limit?: number;
      cursor?: string;
    } = {}
  ) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/links${buildQuery(options)}`,
      token
    );
  },
  listLinksByTarget: (
    token: string,
    options: {
      targetService: string;
      targetResourceType: string;
      targetResourceId: string;
      relationType?: string;
      limit?: number;
      cursor?: string;
    }
  ) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/project-links${buildQuery(options)}`, token);
  },
  getLink: (token: string, linkId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/project-links/${encodeURIComponent(linkId)}`, token);
  },
  createLink: (token: string, projectId: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, `/projects/${encodeURIComponent(projectId)}/links`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },
  removeLink: (token: string, linkId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<void>(projectsService, `/project-links/${encodeURIComponent(linkId)}`, token, {
      method: "DELETE"
    });
  },
  getContextSummary: (token: string, projectId: string) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/context-summary`,
      token
    );
  },
  refreshContextSummary: (token: string, projectId: string, payload: unknown = {}) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(
      projectsService,
      `/projects/${encodeURIComponent(projectId)}/context-summary/refresh`,
      token,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
  },
  markIndexEntriesRead: (token: string, payload: unknown) => {
    if (!projectsService) throw new Error("Projects service is not configured");
    return serviceRequest<unknown>(projectsService, "/project-index/read-marks", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }
};
