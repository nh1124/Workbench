import { getWorkbenchLocalRoutingMode } from "../config/services";
import {
  getNativeGlobalShortcutRegistrations,
  type ShortcutBindings
} from "./keyboardShortcuts";
import { pushErrorNotification } from "./notificationService";
import {
  ApiError,
  CLIENT_OP_ID_HEADER,
  autoRoutingCanFallbackToLocal,
  coreApiPath,
  coreBaseUrl,
  fetchArtifactFacadeBlob,
  fetchArtifactFacadeJson,
  fetchJson,
  fetchNotesFacadeJson,
  fetchProjectsFacadeJson,
  fetchTasksFacadeJson,
  fetchWithSessionAuth,
  fileToBase64,
  filenameFromDisposition,
  invokeNative,
  isTauriNativeRuntime,
  localDaemonBaseUrl,
  markSuccessfulCoreRequest,
  markSuccessfulLocalRequest,
  requestArtifactFacade,
  requestJson,
  requestLocalDaemonJson,
  requestTasksFacade,
  tasksFacadeEnabled
} from "./api/transport";
export {
  ApiError,
  autoRoutingCanFallbackToLocal,
  clearWorkbenchSession,
  coreApiPath,
  formatApiErrorMessage,
  initializeSessionStorage,
  isTauriNativeRuntime,
  localDaemonSupportsWriteRequest,
  nativeDaemonApi,
  readWorkbenchSession,
  saveWorkbenchSession,
  sessionAuthHeaders,
  syncNativeDaemonCoreUrl
} from "./api/transport";
export type { ApiBackend } from "./api/transport";
import { buildProjectIndexQuery, buildProjectMemoryQuery } from "../projects/projectContextQueries";
import { normalizeDateKey } from "../tasks/lib/taskOccurrenceIdentity";
import type {
  AnalyserActivityAggregate,
  AnalyserAutomationPolicy,
  AnalyserAutomationPolicyRecord,
  AnalyserCollectionPolicyRecord,
  AnalyserCollectionSettingsOverride,
  AnalyserDerivedCapture,
  AnalyserExportInput,
  AnalyserExportResult,
  AnalyserMachineRecord,
  AnalyserObservationRecord,
  AnalyserObservationSource,
  AnalyserOperationKind,
  AnalyserOperationRecord,
  AnalyserProposalListItem,
  AnalyserProposalRecord,
  AnalyserProposalStatus,
  AnalyserProjectorFlushResult,
  AnalyserPublicationRecord,
  AnalyserRoutineRecord,
  AnalyserRoutineStatusSummary,
  AnalyserSettingsResult,
  AnalyserStatusResult,
  AnalyserSummaryListItem,
  AnalyserSummaryRecord,
  Artifact,
  ArtifactProjectMembershipsResult,
  DeepResearchCancelResponse,
  DeepResearchDefaultsResponse,
  DeepResearchHistoryEntry,
  DeepResearchRunResponse,
  DeepResearchStatusResponse,
  ImageAssetRecord,
  ImageContextRef,
  ImageDefaultsResponse,
  ImageIntent,
  ImageJobRecord,
  ImageProvider,
  ImageQuality,
  ImageReferenceRecord,
  ImageSize,
  ArtifactItem,
  ArtifactProjectSummary,
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
  MindmapArtifactSaveResponse,
  MindmapCreateInput,
  MindmapDocument,
  MindmapExportContent,
  MindmapExportFormat,
  MindmapListResult,
  MindmapMode,
  MindmapUpdateInput,
  Note,
  NoteProjectSummary,
  ProjectDefaultSelection,
  ProjectBriefRecord,
  ProjectContextPack,
  ProjectContextSummary,
  ProjectDeletionImpact,
  ProjectIndexListResult,
  ProjectLinkListResult,
  ProjectLinkRecord,
  ProjectListResult,
  ProjectMemoryAuthority,
  ProjectMemoryEntry,
  ProjectMemoryKind,
  ProjectMemoryListResult,
  ProjectMemoryStatus,
  ProjectRecord,
  ProjectRelation,
  ProjectRelationDirectionality,
  ProjectRelationListResult,
  ProjectRelationType,
  ServiceHealth,
  ServiceProvisioningState,
  StoredIntegrationConfig,
  Task,
  TaskAttachment,
  TaskHistoryEntry,
  TaskProjectSummary,
  TaskScheduleDay,
  TaskStatus,
  TaskSubtask,
  TodayTask,
  ScheduleItem,
  ScheduleCalendarDay,
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
  WbsUpdatePlanInput,
  WorkbenchAuthResponse,
  WorkbenchRefreshResponse,
  WorkbenchUserSession
} from "../types/models";

export async function closeQuickNoteWindow(): Promise<void> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>("close_quick_note_window");
    return;
  }
  if (typeof window !== "undefined") {
    window.close();
  }
}

export async function openQuickNoteWindow(): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("open_quick_note_window");
  return true;
}

export async function openCalendarWindow(url: string): Promise<boolean> {
  if (isTauriNativeRuntime()) {
    await invokeNative<void>("open_calendar_window", { url });
    return true;
  }
  if (typeof window === "undefined") return false;
  const calendarWindow = window.open(url, "workbench-calendar", "width=1100,height=800");
  calendarWindow?.focus();
  return calendarWindow !== null;
}

export async function openMainWindow(): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("open_main_window");
  return true;
}

export async function syncNativeGlobalShortcuts(bindings: ShortcutBindings): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  await invokeNative<void>("set_global_shortcuts", {
    shortcuts: getNativeGlobalShortcutRegistrations(bindings)
  });
  return true;
}

/**
 * Open a native Save-As dialog and write the blob to the chosen path.
 * Only available in Tauri desktop runtime. Returns true if saved, false if cancelled.
 * Falls back to browser download when not running in Tauri.
 */
export async function saveFileWithDialog(blob: Blob, defaultName: string): Promise<boolean> {
  if (!isTauriNativeRuntime()) {
    return false;
  }
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  return invokeNative<boolean>("save_file_with_dialog", { bytes, defaultName });
}

/**
 * Save a temporary file and ask the OS to open it with the default associated app.
 * Intended for editing Office documents in their native editor from desktop runtime.
 */
export async function openFileWithDefaultApp(blob: Blob, defaultName: string): Promise<boolean> {
  if (isTauriNativeRuntime()) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = Array.from(new Uint8Array(arrayBuffer));
    return invokeNative<boolean>("open_file_in_os_app", { bytes, defaultName });
  }

  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

export const notesApi = {
  list: (projectId?: string, limit?: number): Promise<Note[]> => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return fetchNotesFacadeJson<Note[]>(`/api/notes${query ? `?${query}` : ""}`);
  },
  get: (id: string): Promise<Note> => fetchNotesFacadeJson<Note>(`/api/notes/${encodeURIComponent(id)}`),
  create: (payload: Omit<Note, "id" | "createdAt" | "updatedAt">): Promise<Note> =>
    fetchNotesFacadeJson<Note>("/api/notes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Note, "id" | "createdAt" | "updatedAt">>
  ): Promise<Note> =>
    fetchNotesFacadeJson<Note>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchNotesFacadeJson<void>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<NoteProjectSummary[]> => fetchNotesFacadeJson<NoteProjectSummary[]>("/api/notes/projects")
};

function analyserApiUrl(path: string, query: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const encoded = params.toString();
  return coreApiPath(`/api/analyser${path}${encoded ? `?${encoded}` : ""}`);
}

export const analyserApi = {
  status: (): Promise<AnalyserStatusResult> =>
    fetchJson(analyserApiUrl("/status")),
  machines: (): Promise<{ items: AnalyserMachineRecord[] }> =>
    fetchJson(analyserApiUrl("/machines")),
  settings: (): Promise<AnalyserSettingsResult> =>
    fetchJson(analyserApiUrl("/settings")),
  updateCollectionPolicy: (body: {
    machineId?: string | null;
    settings: AnalyserCollectionSettingsOverride;
    expectedVersion?: number;
  }): Promise<AnalyserCollectionPolicyRecord> =>
    fetchJson(analyserApiUrl("/settings/collection"), {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  updateAutomationPolicy: (body: {
    policy: AnalyserAutomationPolicy;
    expectedVersion?: number;
  }): Promise<AnalyserAutomationPolicyRecord> =>
    fetchJson(analyserApiUrl("/settings/automation"), {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  observations: (query: {
    source?: AnalyserObservationSource;
    machineId?: string;
    projectId?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserObservationRecord[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/observations", query)),
  activityAggregate: (query: {
    from: string;
    to: string;
    machineId?: string;
    timezone?: string;
  }): Promise<AnalyserActivityAggregate> =>
    fetchJson(analyserApiUrl("/observations/aggregate", query)),
  routines: (): Promise<{ items: AnalyserRoutineRecord[] }> =>
    fetchJson(analyserApiUrl("/routines")),
  skillCatalog: (): Promise<{ skills: string[]; unavailable?: boolean }> =>
    fetchJson(analyserApiUrl("/skills/catalog")),
  runSkillIntegrity: (): Promise<{
    checkedRoutines: number;
    missing: string[];
    drifted: string[];
    proposalsCreated: number;
  }> => fetchJson(analyserApiUrl("/skills/integrity/run"), {
    method: "POST",
    body: JSON.stringify({})
  }),
  routineStatus: (): Promise<{ items: AnalyserRoutineStatusSummary[] }> =>
    fetchJson(analyserApiUrl("/routines/status")),
  seedRoutines: (): Promise<void> =>
    fetchJson(analyserApiUrl("/routines/seed"), {
      method: "POST",
      body: JSON.stringify({})
    }),
  createRoutine: (body: {
    key: string;
    name: string;
    skillKey: string;
    skillVersion?: string;
    scheduleKind: "interval" | "cron";
    scheduleExpr: string;
    timezone: string;
    enabled?: boolean;
    maxRetries?: number;
    backoffMinutes?: number;
  }): Promise<AnalyserRoutineRecord> =>
    fetchJson(analyserApiUrl("/routines"), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  deleteRoutine: (key: string): Promise<void> =>
    fetchJson(analyserApiUrl(`/routines/${encodeURIComponent(key)}`), {
      method: "DELETE"
    }),
  updateRoutine: (key: string, body: {
    name?: string;
    enabled?: boolean;
    scheduleKind?: "interval" | "cron";
    scheduleExpr?: string;
    timezone?: string;
    maxRetries?: number;
    backoffMinutes?: number;
    skillVersion?: string;
    expectedVersion?: number;
  }): Promise<AnalyserRoutineRecord> =>
    fetchJson(analyserApiUrl(`/routines/${encodeURIComponent(key)}`), {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  summaries: (query: {
    kind?: string;
    from?: string;
    to?: string;
    routineKey?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserSummaryListItem[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/summaries", query)),
  summary: (id: string): Promise<AnalyserSummaryRecord> =>
    fetchJson(analyserApiUrl(`/summaries/${encodeURIComponent(id)}`)),
  derivedCaptures: (query: {
    kind?: string;
    machineId?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserDerivedCapture[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/captures/derived", query)),
  derivedCapture: (id: string): Promise<AnalyserDerivedCapture> =>
    fetchJson(analyserApiUrl(`/captures/derived/${encodeURIComponent(id)}`)),
  proposals: (query: {
    status?: AnalyserProposalStatus;
    kind?: string;
    routineKey?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserProposalListItem[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/proposals", query)),
  proposal: (id: string): Promise<AnalyserProposalRecord> =>
    fetchJson(analyserApiUrl(`/proposals/${encodeURIComponent(id)}`)),
  export: (body: AnalyserExportInput): Promise<AnalyserExportResult> =>
    fetchJson(analyserApiUrl("/export"), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  resolveProposal: (id: string, body: {
    status: "approved" | "rejected";
    provenance: string;
    expectedVersion: number;
  }): Promise<AnalyserProposalRecord> =>
    fetchJson(analyserApiUrl(`/proposals/${encodeURIComponent(id)}/resolve`), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  supersedeProposal: (id: string, body: { expectedVersion: number }): Promise<AnalyserProposalRecord> =>
    fetchJson(analyserApiUrl(`/proposals/${encodeURIComponent(id)}/supersede`), {
      method: "POST",
      body: JSON.stringify(body)
    }),
  publications: (query: {
    sourceKind?: "summary" | "proposal";
    sourceId?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserPublicationRecord[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/publications", query)),
  operations: (query: {
    operationKind?: AnalyserOperationKind;
    result?: AnalyserOperationRecord["result"];
    proposalId?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: AnalyserOperationRecord[]; nextCursor?: string }> =>
    fetchJson(analyserApiUrl("/operations", query)),
  projectorFlush: (): Promise<AnalyserProjectorFlushResult> =>
    fetchJson(analyserApiUrl("/projector/flush"), {
      method: "POST",
      body: JSON.stringify({})
    })
};

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

function requireTaskDate(value: string, fieldName: string): string {
  const normalized = normalizeDateKey(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a valid YYYY-MM-DD date.`);
  }
  return normalized;
}

export const tasksApi = {
  list: (context?: string, status?: TaskStatus, limit?: number): Promise<Task[]> => {
    const params = new URLSearchParams();
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return fetchTasksFacadeJson<Task[]>(`/api/tasks${query ? `?${query}` : ""}`);
  },
  get: (id: string): Promise<Task> => fetchTasksFacadeJson<Task>(`/api/tasks/${encodeURIComponent(id)}`),
  create: (payload: Omit<Task, "id" | "createdAt" | "updatedAt">): Promise<Task> =>
    fetchTasksFacadeJson<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (
    id: string,
    payload: Partial<Omit<Task, "id" | "createdAt" | "updatedAt">>
  ): Promise<Task> =>
    fetchTasksFacadeJson<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchTasksFacadeJson<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  projects: (): Promise<TaskProjectSummary[]> => fetchTasksFacadeJson<TaskProjectSummary[]>("/api/tasks/projects"),
  pins: (): Promise<{ taskIds: string[] }> => fetchTasksFacadeJson<{ taskIds: string[] }>("/api/tasks/pins"),
  setPin: (id: string, pinned: boolean): Promise<{ taskId: string; pinned: boolean }> =>
    fetchTasksFacadeJson<{ taskId: string; pinned: boolean }>(`/api/tasks/${encodeURIComponent(id)}/pin`, {
      method: "PUT",
      body: JSON.stringify({ pinned })
    }),
  todayList: (date: string): Promise<TodayTask[]> =>
    fetchTasksFacadeJson<TodayTask[]>(`/api/tasks/today?date=${encodeURIComponent(date)}`),
  addToToday: (
    taskId: string,
    scheduledDate: string,
    occurrenceDate: string,
    opts?: { startTime?: string; endTime?: string; timezone?: string }
  ): Promise<ScheduleItem> =>
    fetchTasksFacadeJson<ScheduleItem>(
      "/api/tasks/today",
      { method: "POST", body: JSON.stringify({ taskId, scheduledDate, occurrenceDate, ...opts }) }
    ),
  removeFromToday: (
    taskId: string,
    scheduledDate: string,
    occurrenceDate?: string
  ): Promise<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }> => {
    const params = new URLSearchParams({ scheduledDate });
    if (occurrenceDate) params.set("occurrenceDate", occurrenceDate);
    return fetchTasksFacadeJson<{ taskId: string; scheduledDate: string; occurrenceDate?: string; removed: number }>(
      `/api/tasks/today/${encodeURIComponent(taskId)}?${params.toString()}`,
      { method: "DELETE" }
    );
  },
  scheduleCalendar: (startDate: string, endDate: string): Promise<ScheduleCalendarDay[]> => {
    const params = new URLSearchParams({ startDate, endDate });
    return fetchTasksFacadeJson<ScheduleCalendarDay[]>(`/api/tasks/schedule-calendar?${params.toString()}`);
  },
  updateScheduleItem: (
    scheduleId: number,
    patch: { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null }
  ): Promise<ScheduleItem> =>
    fetchTasksFacadeJson<ScheduleItem>(
      `/api/tasks/schedule-items/${scheduleId}`,
      { method: "PUT", body: JSON.stringify(patch) }
    ),
  removeScheduleItem: (scheduleId: number): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/schedule-items/${scheduleId}`,
      { method: "DELETE" }
    ),
  scheduleItemsForTask: (taskId: string): Promise<ScheduleItem[]> =>
    fetchTasksFacadeJson<ScheduleItem[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/schedule-items`
    ),
  completeOccurrence: (id: string, targetDate: string, status: TaskStatus): Promise<{ taskId: string; targetDate: string; status: TaskStatus }> => {
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; targetDate: string; status: TaskStatus }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/complete`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate: normalizedTargetDate, status })
      }
    );
  },
  moveOccurrence: (id: string, sourceDate: string, targetDate: string): Promise<{ taskId: string; sourceDate: string; targetDate: string }> => {
    const normalizedSourceDate = requireTaskDate(sourceDate, "Occurrence source date");
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; sourceDate: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/move`,
      {
        method: "POST",
        body: JSON.stringify({ sourceDate: normalizedSourceDate, targetDate: normalizedTargetDate })
      }
    );
  },
  skipOccurrenceException: (id: string, targetDate: string): Promise<{ taskId: string; targetDate: string }> => {
    const normalizedTargetDate = requireTaskDate(targetDate, "Occurrence target date");
    return fetchTasksFacadeJson<{ taskId: string; targetDate: string }>(
      `/api/tasks/${encodeURIComponent(id)}/occurrences/skip-exception`,
      {
        method: "POST",
        body: JSON.stringify({ targetDate: normalizedTargetDate })
      }
    );
  },
  schedule: (startDate: string, endDate: string, context?: string, status?: TaskStatus): Promise<TaskScheduleDay[]> => {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    if (context) params.set("context", context);
    if (status) params.set("status", status);
    return fetchTasksFacadeJson<TaskScheduleDay[]>(`/api/tasks/schedule?${params.toString()}`);
  },
  history: (id: string): Promise<TaskHistoryEntry[]> =>
    fetchTasksFacadeJson<TaskHistoryEntry[]>(`/api/tasks/${encodeURIComponent(id)}/history`),
  exportCsv: async (): Promise<Blob> => {
    const response = await requestTasksFacade("/api/tasks/export", {
      headers: { Accept: "text/csv" }
    });

    if (!response.ok) {
      throw new Error(`Export failed: ${response.status}`);
    }
    return response.blob();
  },
  importCsv: (file: File): Promise<{ imported: number }> => {
    return file.text().then((text) =>
      fetchTasksFacadeJson<{ imported: number }>("/api/tasks/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text
      })
    );
  }
};

export const taskAttachmentsApi = {
  list: (taskId: string): Promise<TaskAttachment[]> =>
    fetchTasksFacadeJson<TaskAttachment[]>(`/api/tasks/${encodeURIComponent(taskId)}/attachments`),

  upload: async (taskId: string, file: File): Promise<TaskAttachment> => {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments`;
    const clientOpId = crypto.randomUUID();
    const uploadOptions: RequestInit = {
      method: "POST",
      headers: { [CLIENT_OP_ID_HEADER]: clientOpId }
    };
    const uploadToLocal = async (): Promise<TaskAttachment> => {
      const result = await requestLocalDaemonJson<TaskAttachment>(path, {
        method: "POST",
        headers: { [CLIENT_OP_ID_HEADER]: clientOpId },
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          contentBase64: await fileToBase64(file)
        })
      });
      markSuccessfulLocalRequest(uploadOptions);
      return result;
    };

    if (tasksFacadeEnabled(path, uploadOptions)) {
      return uploadToLocal();
    }

    const formData = new FormData();
    formData.append("file", file);

    let response: Response;
    try {
      response = await fetchWithSessionAuth(`${coreBaseUrl()}${path}`, {
        method: "POST",
        headers: { [CLIENT_OP_ID_HEADER]: clientOpId },
        body: formData
      }, { suppressConnectionError: getWorkbenchLocalRoutingMode() === "auto" });
    } catch (error) {
      if (autoRoutingCanFallbackToLocal(error, path, uploadOptions)) {
        return uploadToLocal();
      }
      throw error;
    }
    markSuccessfulCoreRequest();

    if (!response.ok) {
      const text = await response.text();
      let message = `Upload failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch { /* ignore */ }
      pushErrorNotification(message, "Upload Error");
      throw new Error(message);
    }

    return response.json() as Promise<TaskAttachment>;
  },

  download: async (taskId: string, attachmentId: string, inline = false): Promise<void> => {
    const suffix = inline ? "" : "?download=1";
    const path = `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download${suffix}`;
    const response = await requestTasksFacade(path);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), attachmentId);

    if (inline) {
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  },

  fetchBlob: async (taskId: string, attachmentId: string): Promise<{ blob: Blob; filename: string; mimeType: string }> => {
    const response = await requestTasksFacade(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download`
    );
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const blob = await response.blob();
    const filename = filenameFromDisposition(response.headers.get("content-disposition"), attachmentId);
    const mimeType = (response.headers.get("content-type") ?? blob.type ?? "").split(";")[0].trim();
    return { blob, filename, mimeType };
  },

  remove: (taskId: string, attachmentId: string): Promise<void> =>
    fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" }
    )
};

export const taskSubtasksApi = {
  list: (taskId: string, occurrenceDate: string): Promise<TaskSubtask[]> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask[]>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks`
    );
  },

  create: (taskId: string, occurrenceDate: string, title: string): Promise<TaskSubtask> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks`,
      { method: "POST", body: JSON.stringify({ title }) }
    );
  },

  update: (
    taskId: string,
    occurrenceDate: string,
    subtaskId: string,
    updates: { title?: string; isDone?: boolean; sortOrder?: number }
  ): Promise<TaskSubtask> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<TaskSubtask>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "PATCH", body: JSON.stringify(updates) }
    );
  },

  remove: (taskId: string, occurrenceDate: string, subtaskId: string): Promise<void> => {
    const date = requireTaskDate(occurrenceDate, "Subtask occurrence date");
    return fetchTasksFacadeJson<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/occurrences/${encodeURIComponent(date)}/subtasks/${encodeURIComponent(subtaskId)}`,
      { method: "DELETE" }
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
    const queryString = params.toString();
    return fetchProjectsFacadeJson<ProjectListResult>(`/api/projects${queryString ? `?${queryString}` : ""}`);
  },
  get: (id: string): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`),
  create: (payload: { name: string; description?: string; status?: "draft" | "active" | "archived" }): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  update: (id: string, payload: Partial<Pick<ProjectRecord, "name" | "description" | "status">>): Promise<ProjectRecord> =>
    fetchProjectsFacadeJson<ProjectRecord>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  remove: (id: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  getDefault: (): Promise<ProjectDefaultSelection> =>
    fetchProjectsFacadeJson<ProjectDefaultSelection>("/api/projects/default"),
  setDefault: (projectId: string): Promise<ProjectDefaultSelection> =>
    fetchProjectsFacadeJson<ProjectDefaultSelection>("/api/projects/default", {
      method: "PUT",
      body: JSON.stringify({ projectId })
    }),
  getContext: (
    id: string,
    options?: {
      q?: string;
      include?: Array<"brief" | "summary" | "memory" | "index" | "relations" | "links">;
      memoryLimit?: number;
      indexLimit?: number;
      relationLimit?: number;
      maxChars?: number;
    }
  ): Promise<ProjectContextPack> => {
    const params = new URLSearchParams();
    if (options?.q) params.set("q", options.q);
    if (options?.include?.length) params.set("include", options.include.join(","));
    if (options?.memoryLimit) params.set("memoryLimit", String(options.memoryLimit));
    if (options?.indexLimit) params.set("indexLimit", String(options.indexLimit));
    if (options?.relationLimit) params.set("relationLimit", String(options.relationLimit));
    if (options?.maxChars) params.set("maxChars", String(options.maxChars));
    const query = params.toString();
    return fetchProjectsFacadeJson<ProjectContextPack>(
      `/api/projects/${encodeURIComponent(id)}/context${query ? `?${query}` : ""}`
    );
  },
  getBrief: (id: string): Promise<ProjectBriefRecord> =>
    fetchProjectsFacadeJson<ProjectBriefRecord>(`/api/projects/${encodeURIComponent(id)}/brief`),
  updateBrief: (
    id: string,
    payload: { contentMarkdown: string; expectedVersion: number }
  ): Promise<ProjectBriefRecord> =>
    fetchProjectsFacadeJson<ProjectBriefRecord>(`/api/projects/${encodeURIComponent(id)}/brief`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  listMemories: (
    id: string,
    options?: {
      q?: string;
      kind?: ProjectMemoryKind;
      authority?: ProjectMemoryAuthority;
      status?: ProjectMemoryStatus;
      limit?: number;
      cursor?: string;
    }
  ): Promise<ProjectMemoryListResult> => {
    const query = buildProjectMemoryQuery(options);
    return fetchProjectsFacadeJson<ProjectMemoryListResult>(
      `/api/projects/${encodeURIComponent(id)}/memories${query ? `?${query}` : ""}`
    );
  },
  appendMemory: (
    id: string,
    payload: {
      kind: ProjectMemoryKind;
      bodyMarkdown: string;
      authority?: ProjectMemoryAuthority;
      sourceService?: string;
      sourceResourceType?: string;
      sourceResourceId?: string;
      confidence?: number;
      supersedesId?: string;
    }
  ): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/projects/${encodeURIComponent(id)}/memories`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateMemory: (
    memoryId: string,
    payload: Partial<Pick<ProjectMemoryEntry, "bodyMarkdown" | "status">>
  ): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/project-memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  archiveMemory: (memoryId: string): Promise<ProjectMemoryEntry> =>
    fetchProjectsFacadeJson<ProjectMemoryEntry>(`/api/project-memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" })
    }),
  searchIndex: (
    id: string,
    options?: { q?: string; sourceService?: string; resourceType?: string; limit?: number; cursor?: string }
  ): Promise<ProjectIndexListResult> => {
    const query = buildProjectIndexQuery(options);
    return fetchProjectsFacadeJson<ProjectIndexListResult>(
      `/api/projects/${encodeURIComponent(id)}/index${query ? `?${query}` : ""}`
    );
  },
  rebuildIndex: (id: string): Promise<{
    projectId: string;
    indexed: number;
    primary: number;
    secondary: number;
    tombstoned: number;
    staleLinksRemoved: number;
  }> =>
    fetchProjectsFacadeJson<{
      projectId: string;
      indexed: number;
      primary: number;
      secondary: number;
      tombstoned: number;
      staleLinksRemoved: number;
    }>(
      `/api/projects/${encodeURIComponent(id)}/index/rebuild`,
      { method: "POST" }
    ),
  listRelations: (id: string): Promise<ProjectRelationListResult> =>
    fetchProjectsFacadeJson<ProjectRelationListResult>(`/api/projects/${encodeURIComponent(id)}/relations`),
  addRelation: (
    id: string,
    payload: {
      targetProjectId: string;
      relationType: ProjectRelationType;
      directionality: ProjectRelationDirectionality;
      note?: string;
      strength?: number;
    }
  ): Promise<ProjectRelation> =>
    fetchProjectsFacadeJson<ProjectRelation>(`/api/projects/${encodeURIComponent(id)}/relations`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateRelation: (
    relationId: string,
    payload: Partial<Pick<ProjectRelation, "relationType" | "directionality" | "note" | "strength">> & {
      expectedVersion: number;
    }
  ): Promise<ProjectRelation> =>
    fetchProjectsFacadeJson<ProjectRelation>(`/api/project-relations/${encodeURIComponent(relationId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  removeRelation: (relationId: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/project-relations/${encodeURIComponent(relationId)}`, {
      method: "DELETE"
    }),
  listLinks: (
    id: string,
    options?: {
      targetService?: string;
      targetResourceType?: string;
      relationType?: string;
      limit?: number;
      cursor?: string;
    }
  ): Promise<ProjectLinkListResult> => {
    const params = new URLSearchParams();
    if (options?.targetService) params.set("targetService", options.targetService);
    if (options?.targetResourceType) params.set("targetResourceType", options.targetResourceType);
    if (options?.relationType) params.set("relationType", options.relationType);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return fetchProjectsFacadeJson<ProjectLinkListResult>(
      `/api/projects/${encodeURIComponent(id)}/links${query ? `?${query}` : ""}`
    );
  },
  addLink: (
    id: string,
    payload: {
      targetService: string;
      targetResourceType: string;
      targetResourceId: string;
      relationType?: string;
      titleSnapshot?: string;
      summarySnapshot?: string;
      metadataJson?: Record<string, unknown>;
    }
  ): Promise<ProjectLinkRecord> =>
    fetchProjectsFacadeJson<ProjectLinkRecord>(`/api/projects/${encodeURIComponent(id)}/links`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  removeLink: (linkId: string): Promise<void> =>
    fetchProjectsFacadeJson<void>(`/api/project-links/${encodeURIComponent(linkId)}`, { method: "DELETE" }),
  getContextSummary: (id: string): Promise<ProjectContextSummary> =>
    fetchProjectsFacadeJson<ProjectContextSummary>(`/api/projects/${encodeURIComponent(id)}/context-summary`),
  refreshContextSummary: (id: string): Promise<ProjectContextSummary> =>
    fetchProjectsFacadeJson<ProjectContextSummary>(
      `/api/projects/${encodeURIComponent(id)}/context-summary/refresh`,
      { method: "POST" }
    ),
  getDeletionImpact: (id: string): Promise<ProjectDeletionImpact> =>
    fetchProjectsFacadeJson<ProjectDeletionImpact>(`/api/projects/${encodeURIComponent(id)}/deletion-impact`)
};

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
