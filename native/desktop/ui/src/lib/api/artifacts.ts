import { pushErrorNotification } from "../notificationService";
import {
  coreBaseUrl,
  fetchArtifactFacadeBlob,
  fetchArtifactFacadeJson,
  fetchJson,
  fetchWithSessionAuth,
  requestArtifactFacade
} from "./transport";
import type {
  Artifact,
  ArtifactProjectMembershipsResult,
  ArtifactItem,
  ArtifactProjectSummary
} from "../../types/models";

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

