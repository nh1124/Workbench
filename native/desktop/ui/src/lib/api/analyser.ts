import {
  coreApiPath,
  fetchJson
} from "./transport";
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
  AnalyserSummaryRecord
} from "../../types/models";

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

