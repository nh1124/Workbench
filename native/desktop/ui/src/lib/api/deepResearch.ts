import {
  ApiError,
  coreBaseUrl,
  fetchJson
} from "./transport";
import type {
  DeepResearchCancelResponse,
  DeepResearchDefaultsResponse,
  DeepResearchHistoryEntry,
  DeepResearchRunResponse,
  DeepResearchStatusResponse
} from "../../types/models";

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

