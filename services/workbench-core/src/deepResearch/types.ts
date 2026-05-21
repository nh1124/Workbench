export type DeepResearchProvider = "gemini" | "openai" | "anthropic";
export type DeepResearchProviderInput = DeepResearchProvider | "auto";
export type DeepResearchSpeed = "deep" | "fast";
export type DeepResearchJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface DeepResearchDefaults {
  provider: DeepResearchProviderInput;
  speed: DeepResearchSpeed;
  timeoutSec: number;
  asyncOnTimeout: boolean;
  saveToArtifacts: boolean;
}

export interface DeepResearchSettings extends DeepResearchDefaults {
  enabled: boolean;
  apiKeys: Partial<Record<DeepResearchProvider, string>>;
  availableProviders: DeepResearchProvider[];
}

export interface DeepResearchRunInput {
  query: string;
  provider?: DeepResearchProviderInput;
  speed?: DeepResearchSpeed;
  timeoutSec?: number;
  asyncOnTimeout?: boolean;
  saveToArtifacts?: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
}

export interface DeepResearchResolvedRequest {
  query: string;
  provider: DeepResearchProvider;
  speed: DeepResearchSpeed;
  timeoutSec: number;
  asyncOnTimeout: boolean;
  saveToArtifacts: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  projectId?: string;
  projectName?: string;
}

export interface DeepResearchProviderResult {
  content: string;
  provider: DeepResearchProvider;
  model: string;
}

export interface DeepResearchArtifactRef {
  id: string;
  title: string;
  path: string;
  projectId: string;
  projectName?: string;
}

export interface DeepResearchArtifactTarget {
  title: string;
  path: string;
  projectId?: string;
  projectName?: string;
}

export interface DeepResearchAccessPlan {
  status: {
    tool: "deep_research_status";
    arguments: {
      job_id: string;
    };
  };
  saveArtifact: {
    tool: "deep_research_save_artifact";
    arguments: {
      job_id: string;
      artifact_title?: string;
      artifact_path?: string;
      project_id?: string;
      project_name?: string;
    };
  };
  artifactItem?: {
    tool: "artifacts.item.get";
    arguments: {
      id: string;
    };
  };
  expectedArtifact?: DeepResearchArtifactTarget;
  notes: string[];
}

export interface DeepResearchProgress {
  stage: "queued" | "running" | "saving_artifact" | "completed" | "failed" | "cancelled";
  percent: number;
  message: string;
}

export interface DeepResearchEventLog {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  stage?: DeepResearchProgress["stage"];
}

export interface DeepResearchJobRecord {
  id: string;
  userId: string;
  status: DeepResearchJobStatus;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  timeoutSec: number;
  asyncOnTimeout: boolean;
  saveToArtifacts: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  artifactItemId?: string;
  artifactItemPath?: string;
  resultMarkdown?: string;
  errorMessage?: string;
  progress: DeepResearchProgress;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface DeepResearchRunResponseCompleted {
  status: "completed";
  jobId: string;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  resultMarkdown: string;
  artifact?: DeepResearchArtifactRef;
  artifactSaveError?: string;
  accessPlan: DeepResearchAccessPlan;
  completedAt: string;
}

export interface DeepResearchRunResponseRunning {
  status: "running";
  jobId: string;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  timedOut: boolean;
  background: boolean;
  willSaveToArtifacts: boolean;
  expectedArtifact?: DeepResearchArtifactTarget;
  accessPlan: DeepResearchAccessPlan;
  message: string;
}

export type DeepResearchRunResponse = DeepResearchRunResponseCompleted | DeepResearchRunResponseRunning;

export interface DeepResearchStatusResponse {
  jobId: string;
  status: DeepResearchJobStatus;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  progress: DeepResearchProgress;
  resultMarkdown?: string;
  artifact?: DeepResearchArtifactRef;
  artifactSaveError?: string;
  expectedArtifact?: DeepResearchArtifactTarget;
  accessPlan: DeepResearchAccessPlan;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  eventLogs: DeepResearchEventLog[];
}

export interface DeepResearchCancelResponse {
  jobId: string;
  status: DeepResearchJobStatus;
  cancelled: boolean;
  message: string;
}

export interface DeepResearchHistoryEntry {
  jobId: string;
  status: DeepResearchJobStatus;
  query: string;
  provider: DeepResearchProvider;
  model: string;
  speed: DeepResearchSpeed;
  progress: DeepResearchProgress;
  artifact?: DeepResearchArtifactRef;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  eventLogs: DeepResearchEventLog[];
}
