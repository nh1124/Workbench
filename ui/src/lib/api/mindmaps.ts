import {
  coreBaseUrl,
  fetchJson
} from "./transport";
import type {
  MindmapArtifactSaveResponse,
  MindmapCreateInput,
  MindmapDocument,
  MindmapExportContent,
  MindmapExportFormat,
  MindmapListResult,
  MindmapMode,
  MindmapUpdateInput
} from "../../types/models";

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

