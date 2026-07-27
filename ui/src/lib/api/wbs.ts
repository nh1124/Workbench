import {
  coreBaseUrl,
  fetchJson
} from "./transport";
import type {
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
  WbsUpdatePlanInput
} from "../../types/models";

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

