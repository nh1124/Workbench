export type TaskStatus = "todo" | "done" | "skipped";
export type TaskPriority = "low" | "medium" | "high";
export type RecurrenceType = "ONCE" | "WEEKLY" | "EVERY_N_DAYS" | "MONTHLY_DAY" | "MONTHLY_NTH_WEEKDAY";

export interface Note {
  id: string;
  title: string;
  content: string;
  projectId: string;
  projectName?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  name: string;
  type: string;
  description: string;
  projectId: string;
  projectName?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export type ArtifactItemKind = "folder" | "note" | "file";
export type ArtifactScope = "private" | "org" | "project";

export interface ArtifactItem {
  id: string;
  projectId: string;
  projectName?: string;
  kind: ArtifactItemKind;
  title: string;
  path: string;
  parentPath: string;
  scope: ArtifactScope;
  tags: string[];
  mimeType?: string;
  sizeBytes?: number;
  version: number;
  contentMarkdown?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  context: string;
  contextName?: string;
  isPinned?: boolean;
  status: TaskStatus;
  isLocked: boolean;
  baseLoadScore: number;
  recurrence: RecurrenceType;
  dueDate?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  activeFrom?: string;
  activeUntil?: string;
  active: boolean;
  mon?: boolean;
  tue?: boolean;
  wed?: boolean;
  thu?: boolean;
  fri?: boolean;
  sat?: boolean;
  sun?: boolean;
  intervalDays?: number;
  anchorDate?: string;
  monthDay?: number;
  nthInMonth?: number;
  weekdayMon1?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskHistoryEntry {
  id: string | number;
  taskId: string;
  targetDate: string;
  status: string;
  createdAt: string;
}

export interface TaskScheduleItem {
  taskId: string;
  title: string;
  context: string;
  status: TaskStatus;
  load?: number;
  startTime?: string;
  endTime?: string;
  isLocked?: boolean;
}

export interface TaskScheduleDay {
  date: string;
  totalLoad?: number;
  baseLoad?: number;
  cap?: number;
  level?: string;
  tasks: TaskScheduleItem[];
}

export interface NoteProjectSummary {
  projectId: string;
  projectName?: string;
  noteCount: number;
  latestUpdatedAt: string;
}

export interface ArtifactProjectSummary {
  projectId: string;
  projectName?: string;
  artifactCount: number;
  latestUpdatedAt: string;
}

export interface TaskProjectSummary {
  projectId: string;
  projectName?: string;
  taskCount: number;
  latestUpdatedAt: string;
}

export interface DashboardProjectSummary {
  projectId: string;
  projectName: string;
  noteCount: number;
  artifactCount: number;
  taskCount: number;
  latestUpdatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  status: "draft" | "active" | "archived";
  ownerAccountId: string;
  isFallbackDefault?: boolean;
  isUserDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListResult {
  items: ProjectRecord[];
  nextCursor?: string;
}

export interface ProjectDefaultSelection {
  project: ProjectRecord;
  source: "user" | "fallback";
}

export interface ServiceHealth {
  service: string;
  status: "ok" | "error";
  timestamp: string;
}

export interface ShortcutItem {
  key: string;
  description: string;
  target: string;
}

export interface IntegrationManifestField {
  key: string;
  label: string;
  type: "text" | "number" | "password" | "select" | "textarea" | "boolean";
  placeholder?: string;
  description?: string;
  required?: boolean;
  helperText?: string;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<string | { label: string; value: string }>;
}

export interface IntegrationManifest {
  id: string;
  displayName: string;
  description: string;
  category: string;
  defaultEnabled: boolean;
  icon?: string;
  badge?: string;
  setupInstructions?: string;
  fields: IntegrationManifestField[];
}

export interface IntegrationConfigState {
  enabled: boolean;
  values: Record<string, string | number | boolean>;
}

export interface WorkbenchUserSession {
  id: string;
  username: string;
  createdAt: string;
}

export interface WorkbenchAuthResponse {
  user: WorkbenchUserSession;
  provisioning: ServiceProvisioningState[];
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
}

export interface WorkbenchRefreshResponse {
  user: WorkbenchUserSession;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
}

export interface ServiceProvisioningState {
  serviceId: string;
  status: "ok" | "error";
  message?: string;
  updatedAt: string;
}

export interface StoredIntegrationConfig {
  integrationId: string;
  enabled: boolean;
  values: Record<string, string | number | boolean>;
  updatedAt: string;
}

export type DeepResearchProvider = "auto" | "gemini" | "openai" | "anthropic";
export type DeepResearchSpeed = "deep" | "fast";
export type DeepResearchJobStatus = "running" | "completed" | "failed" | "cancelled";
export type DeepResearchProgressStage = "queued" | "running" | "saving_artifact" | "completed" | "failed" | "cancelled";

export interface DeepResearchEventLog {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  stage?: DeepResearchProgressStage;
}

export interface DeepResearchDefaultsResponse {
  enabled: boolean;
  defaults: {
    provider: DeepResearchProvider;
    speed: DeepResearchSpeed;
    timeoutSec: number;
    asyncOnTimeout: boolean;
    saveToArtifacts: boolean;
  };
  availableProviders: {
    gemini: boolean;
    openai: boolean;
    anthropic: boolean;
  };
}

export interface DeepResearchArtifactRef {
  id: string;
  title: string;
  path: string;
  projectId: string;
  projectName?: string;
}

export interface DeepResearchRunResponse {
  status: "running" | "completed";
  jobId: string;
  query: string;
  provider: Exclude<DeepResearchProvider, "auto">;
  model: string;
  speed: DeepResearchSpeed;
  message?: string;
  resultMarkdown?: string;
  artifact?: DeepResearchArtifactRef;
  artifactSaveError?: string;
  completedAt?: string;
}

export interface DeepResearchStatusResponse {
  jobId: string;
  status: DeepResearchJobStatus;
  query: string;
  provider: Exclude<DeepResearchProvider, "auto">;
  model: string;
  speed: DeepResearchSpeed;
  progress: {
    stage: DeepResearchProgressStage;
    percent: number;
    message: string;
  };
  resultMarkdown?: string;
  artifact?: DeepResearchArtifactRef;
  artifactSaveError?: string;
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
  provider: Exclude<DeepResearchProvider, "auto">;
  model: string;
  speed: DeepResearchSpeed;
  progress: {
    stage: DeepResearchProgressStage;
    percent: number;
    message: string;
  };
  artifact?: DeepResearchArtifactRef;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  eventLogs: DeepResearchEventLog[];
}
