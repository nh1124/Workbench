import {
  coreBaseUrl,
  fetchJson,
  localDaemonBaseUrl,
  requestJson,
  requestLocalDaemonJson
} from "./transport";
import type {
  CaptureDaemonConfig,
  CaptureDaemonConfigPatch,
  CaptureDaemonState,
  CaptureSummaryListResult,
  CaptureSummaryRecord,
  CaptureSummaryResult,
  CaptureScreenshotListResult,
  IntegrationManifest,
  LocalClientAuditEventRecord,
  LocalClientRecord,
  LocalDaemonConflictRecord,
  LocalDaemonPendingJobConfirmation,
  LocalDaemonStatus,
  LocalJobRecord,
  LocalJobResultRecord,
  ServiceHealth,
  ServiceProvisioningState,
  StoredIntegrationConfig,
  WorkbenchAuthResponse,
  WorkbenchRefreshResponse,
  WorkbenchUserSession
} from "../../types/models";

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
  refresh: (refreshToken?: string): Promise<WorkbenchRefreshResponse> =>
    requestJson(
      `${coreBaseUrl()}/auth/refresh`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: refreshToken ? JSON.stringify({ refreshToken }) : undefined
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
  captureStatus: (): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/status"),
  captureConfig: (): Promise<CaptureDaemonConfig> =>
    requestLocalDaemonJson<CaptureDaemonConfig>("/capture/config"),
  updateCaptureConfig: (payload: CaptureDaemonConfigPatch): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/config", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  enableCapture: (): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/enable", {
      method: "POST"
    }),
  disableCapture: (): Promise<CaptureDaemonState> =>
    requestLocalDaemonJson<CaptureDaemonState>("/capture/disable", {
      method: "POST"
    }),
  summarizeCapture: (date?: string): Promise<CaptureSummaryResult> =>
    requestLocalDaemonJson<CaptureSummaryResult>("/capture/summarize", {
      method: "POST",
      body: JSON.stringify(date ? { date } : {})
    }),
  listCaptureSummaries: (
    options: { limit?: number; cursor?: string } = {}
  ): Promise<CaptureSummaryListResult> => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return requestLocalDaemonJson<CaptureSummaryListResult>(`/capture/summaries${query ? `?${query}` : ""}`);
  },
  getCaptureSummary: (summaryDate: string): Promise<CaptureSummaryRecord> =>
    requestLocalDaemonJson<CaptureSummaryRecord>(`/capture/summaries/${encodeURIComponent(summaryDate)}`),
  publishCaptureSummary: (summaryDate: string): Promise<CaptureSummaryRecord & { action?: "create" | "update"; title?: string }> =>
    requestLocalDaemonJson<CaptureSummaryRecord & { action?: "create" | "update"; title?: string }>(
      `/capture/summaries/${encodeURIComponent(summaryDate)}/publish`,
      {
        method: "POST",
        body: JSON.stringify({ target: "note" })
      }
    ),
  listCaptureScreenshots: (options: { date: string; limit?: number; cursor?: string }): Promise<CaptureScreenshotListResult> => {
    const params = new URLSearchParams({ date: options.date });
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    return requestLocalDaemonJson<CaptureScreenshotListResult>(`/capture/screenshots?${params.toString()}`);
  },
  captureScreenshotFileUrl: (id: number): string =>
    `${localDaemonBaseUrl()}/capture/screenshots/${encodeURIComponent(String(id))}/file`,
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
