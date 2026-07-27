import { pushErrorNotification } from "../notificationService";
import {
  coreBaseUrl,
  fetchJson,
  fetchWithSessionAuth
} from "./transport";
import type {
  ImageAssetRecord,
  ImageContextRef,
  ImageDefaultsResponse,
  ImageIntent,
  ImageJobRecord,
  ImageProvider,
  ImageQuality,
  ImageReferenceRecord,
  ImageSize
} from "../../types/models";

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

