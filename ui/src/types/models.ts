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
export type ArtifactPreviewStatus = "pending" | "ready" | "error";

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
  previewPdfStatus?: ArtifactPreviewStatus;
  previewPdfUpdatedAt?: string;
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

/**
 * A Task enriched with schedule information.
 * occurrenceDate = LBS execution date used when completing the task.
 * scheduledDate  = the calendar date this item appears on (Today / Schedule calendar).
 * scheduleId is present when the item comes from an explicit schedule entry;
 * undefined when it is an LBS-auto-shown task (occurrence_date = today, no DB entry).
 */
export interface TodayTask extends Task {
  occurrenceDate: string;
  scheduledDate: string;
  scheduleId?: number;
  startTime?: string;
  endTime?: string;
  timezone?: string;
}

export interface ScheduleItem {
  id: number;
  taskId: string;
  occurrenceDate: string;
  scheduledDate: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCalendarItem {
  scheduleId?: number;
  taskId: string;
  title: string;
  context: string;
  status: TaskStatus;
  occurrenceDate: string;
  scheduledDate: string;
  load?: number;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  isLocked?: boolean;
}

export interface ScheduleCalendarDay {
  date: string;
  items: ScheduleCalendarItem[];
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: string;
}

export interface TaskSubtask {
  id: string;
  taskId: string;
  occurrenceDate: string;
  title: string;
  isDone: boolean;
  sortOrder: number;
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

export type ImageProvider = "auto" | "mock" | "openai" | "nanobanana";
export type ImageIntent = "create" | "refine" | "edit" | "context_update";
export type ImageJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ImageQuality = "draft" | "standard" | "high";
export type ImageSize = "512x512" | "768x768" | "1024x1024" | "1024x1536" | "1536x1024" | "auto";

export interface ImageReferenceRecord {
  id: string;
  purpose: "reference" | "source" | "mask";
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  sha256: string;
  projectId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ImageAssetRecord {
  id: string;
  jobId: string;
  sourceAssetId?: string;
  sourceReferenceId?: string;
  indexInJob: number;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  artifactItemId?: string;
  artifactItemPath?: string;
  artifactTitle?: string;
  projectId?: string;
  projectName?: string;
  createdAt: string;
  downloadUrl?: string;
}

export interface ImageContextRef {
  kind: "project" | "artifact" | "note" | "task" | "research" | "freeform";
  id?: string;
  title?: string;
  path?: string;
  content?: string;
}

export interface ImageJobRecord {
  jobId: string;
  status: ImageJobStatus;
  intent: ImageIntent;
  provider: Exclude<ImageProvider, "auto">;
  model: string;
  prompt: string;
  instruction?: string;
  progress: {
    stage: string;
    percent: number;
    message: string;
  };
  errorCode?: string;
  errorMessage?: string;
  saveToArtifacts: boolean;
  projectId?: string;
  projectName?: string;
  artifactTitle?: string;
  artifactPath?: string;
  assets: ImageAssetRecord[];
  artifactRefs?: unknown[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ImageDefaultsResponse {
  enabled: boolean;
  defaults: {
    provider: ImageProvider;
    model?: string;
    size: ImageSize;
    quality: ImageQuality;
    count: number;
    saveToArtifacts: boolean;
  };
  availableProviders: Record<Exclude<ImageProvider, "auto">, boolean>;
  capabilities: Record<Exclude<ImageProvider, "auto">, string[]>;
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

export interface DeepResearchRunResponse {
  status: "running" | "completed";
  jobId: string;
  query: string;
  provider: Exclude<DeepResearchProvider, "auto">;
  model: string;
  speed: DeepResearchSpeed;
  timedOut?: boolean;
  background?: boolean;
  willSaveToArtifacts?: boolean;
  expectedArtifact?: DeepResearchArtifactTarget;
  accessPlan?: DeepResearchAccessPlan;
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
