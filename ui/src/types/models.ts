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

export type MindmapMode = "mindmap" | "logical_tree";
export type MindmapLayoutDirection = "right" | "left" | "radial" | "down";
export type MindmapExportFormat = "json" | "markdown" | "svg";

export interface MindmapNode {
  id: string;
  title: string;
  note?: string;
  markers?: string[];
  collapsed?: boolean;
  children?: MindmapNode[];
}

export interface MindmapDocumentBody {
  root: MindmapNode;
  layout?: {
    direction?: MindmapLayoutDirection;
  };
  theme?: {
    accentColor?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface MindmapDocument {
  id: string;
  ownerCoreUserId: string;
  title: string;
  description?: string;
  mode: MindmapMode;
  projectId?: string;
  projectName?: string;
  body: MindmapDocumentBody;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MindmapListResult {
  items: MindmapDocument[];
  nextCursor?: string;
}

export interface MindmapCreateInput {
  title: string;
  description?: string;
  mode?: MindmapMode;
  projectId?: string;
  projectName?: string;
  body?: MindmapDocumentBody;
  tags?: string[];
  template?: "blank" | "mindmap" | "logical_tree";
}

export interface MindmapUpdateInput {
  title?: string;
  description?: string;
  mode?: MindmapMode;
  projectId?: string | null;
  projectName?: string | null;
  body?: MindmapDocumentBody;
  tags?: string[];
  expectedVersion?: number;
}

export interface MindmapExportContent {
  documentId: string;
  title: string;
  mode: MindmapMode;
  projectId?: string;
  projectName?: string;
  sourceVersion: number;
  format: MindmapExportFormat;
  filename: string;
  mimeType: string;
  contentText: string;
  contentBase64: string;
}

export interface MindmapArtifactSaveResponse {
  status: string;
  artifact: unknown;
  exportRecord: unknown;
}

export type WbsItemStatus = "todo" | "doing" | "blocked" | "done";
export type WbsDependencyType = "finish_to_start" | "start_to_start" | "finish_to_finish" | "start_to_finish";
export type WbsExportFormat = "markdown" | "csv" | "json";

export interface WbsRollup {
  effortHours?: number;
  progress?: number;
  startDate?: string;
  dueDate?: string;
}

export interface WbsPlan {
  id: string;
  ownerCoreUserId?: string;
  projectId?: string;
  projectName?: string;
  title: string;
  description?: string;
  settings?: Record<string, unknown>;
  version: number;
  rollup?: WbsRollup;
  createdAt: string;
  updatedAt: string;
}

export interface WbsItem {
  id: string;
  planId: string;
  parentId?: string;
  code: string;
  title: string;
  description?: string;
  sortOrder: number;
  ownerLabel?: string;
  startDate?: string;
  dueDate?: string;
  effortHours?: number;
  status: WbsItemStatus;
  progress?: number;
  linkedTaskId?: string;
  metadata?: Record<string, unknown>;
  rollup?: WbsRollup;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WbsDependency {
  id: string;
  planId: string;
  fromItemId: string;
  toItemId: string;
  dependencyType: WbsDependencyType;
  lagDays: number;
}

export interface WbsPlanListResult {
  items: WbsPlan[];
  nextCursor?: string;
}

export interface WbsCreatePlanInput {
  title: string;
  description?: string;
  projectId?: string;
  projectName?: string;
  settings?: Record<string, unknown>;
}

export interface WbsUpdatePlanInput {
  expectedVersion: number;
  title?: string;
  description?: string;
  projectId?: string | null;
  projectName?: string | null;
  settings?: Record<string, unknown>;
}

export interface WbsCreateItemInput {
  parentId?: string;
  title: string;
  description?: string;
  ownerLabel?: string;
  startDate?: string;
  dueDate?: string;
  effortHours?: number;
  status?: WbsItemStatus;
  progress?: number;
}

export interface WbsUpdateItemInput {
  expectedVersion: number;
  title?: string;
  description?: string;
  ownerLabel?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  effortHours?: number | null;
  status?: WbsItemStatus;
  progress?: number | null;
}

export interface WbsMoveItemInput {
  expectedVersion: number;
  parentId?: string | null;
  beforeItemId?: string;
  afterItemId?: string;
}

export interface WbsExportContent {
  planId: string;
  title: string;
  projectId?: string;
  projectName?: string;
  sourceVersion: number;
  format: WbsExportFormat;
  filename: string;
  mimeType: string;
  contentText: string;
  contentBase64: string;
}

export interface WbsArtifactSaveResponse {
  status: string;
  artifact: unknown;
  exportRecord: unknown;
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

export interface ProjectBriefRecord {
  projectId: string;
  contentMarkdown: string;
  version: number;
  updatedByKind: "user" | "agent";
  updatedAt: string;
}

export type ProjectMemoryKind = "decision" | "fact" | "preference" | "pitfall" | "observation";
export type ProjectMemoryAuthority = "user_confirmed" | "agent_observed" | "imported";
export type ProjectMemoryStatus = "active" | "superseded" | "archived";
export type ProjectMemoryLifecycleState = "raw" | "triaged" | "curated" | "verified";
export interface ProjectMemoryEntry {
  id: string;
  projectId: string;
  kind: ProjectMemoryKind;
  bodyMarkdown: string;
  authority: ProjectMemoryAuthority;
  sourceService?: string;
  sourceResourceType?: string;
  sourceResourceId?: string;
  confidence?: number;
  status: ProjectMemoryStatus;
  supersedesId?: string;
  lifecycleState?: ProjectMemoryLifecycleState;
  reviewAfter?: string | null;
  lastConfirmedAt?: string | null;
  reviewReason?: "conflict" | "manual" | null;
  createdByKind: "user" | "agent" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMemoryListResult {
  items: ProjectMemoryEntry[];
  nextCursor?: string;
}

export type ProjectIndexAssociationKind = "primary" | "secondary";

export interface ProjectIndexEntry {
  id: string;
  projectId: string;
  sourceService: string;
  resourceType: string;
  resourceId: string;
  associationKind: ProjectIndexAssociationKind;
  associationId?: string;
  path?: string;
  title: string;
  summaryText: string;
  summarySource: "deterministic" | "model" | "snapshot";
  sourceVersion?: string;
  contentHash?: string;
  sourceUpdatedAt: string;
  indexedAt: string;
  metadataJson: Record<string, unknown>;
  isDeleted?: boolean;
}

export interface ProjectIndexListResult {
  items: ProjectIndexEntry[];
  nextCursor?: string;
}

export type ProjectRelationType = "related" | "depends_on" | "supports" | "informs" | "overlaps";
export type ProjectRelationDirectionality = "directed" | "bidirectional";
export type ProjectRelationOrigin = "manual" | "inferred";

export interface ProjectRelation {
  id: string;
  version: number;
  sourceProjectId: string;
  sourceProjectName?: string;
  targetProjectId: string;
  targetProjectName?: string;
  relationType: ProjectRelationType;
  directionality: ProjectRelationDirectionality;
  note?: string;
  origin: ProjectRelationOrigin;
  strength?: number;
  createdByKind: "user" | "agent" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRelationListResult {
  items: ProjectRelation[];
  nextCursor?: string;
}

export interface ProjectLinkRecord {
  id: string;
  projectId: string;
  targetService: string;
  targetResourceType: string;
  targetResourceId: string;
  relationType: string;
  titleSnapshot?: string;
  summarySnapshot?: string;
  linkedAt: string;
  metadataJson: Record<string, unknown>;
}

export interface ProjectLinkListResult {
  items: ProjectLinkRecord[];
  nextCursor?: string;
}

export interface ProjectContextSummary {
  id?: string;
  projectId: string;
  summaryText: string;
  source: string;
  updatedAt: string;
}

export interface ProjectContextPack {
  project: ProjectRecord;
  brief?: ProjectBriefRecord | null;
  generatedSummary?: ProjectContextSummary | null;
  memories?: ProjectMemoryEntry[];
  indexEntries?: ProjectIndexEntry[];
  relations?: ProjectRelation[];
  links?: ProjectLinkRecord[];
  truncation: {
    maxChars: number;
    truncatedSections: string[];
  };
}

export interface ArtifactProjectMembership {
  projectId: string;
  projectName?: string;
  role: "primary" | "secondary";
  linkId?: string;
  note?: string;
}

export interface ArtifactProjectMembershipsResult {
  artifactItemId: string;
  memberships: ArtifactProjectMembership[];
}

export interface ProjectDeletionImpactPrimaryArtifact {
  id: string;
  kind: ArtifactItemKind;
  title: string;
  path: string;
}

export interface ProjectDeletionImpactSecondaryMembership {
  linkId: string;
  artifactItemId: string;
}

export interface ProjectDeletionImpact {
  projectId: string;
  primaryArtifactCount: number;
  secondaryArtifactCount: number;
  canDelete: boolean;
  primaryArtifacts?: ProjectDeletionImpactPrimaryArtifact[];
  secondaryMemberships?: ProjectDeletionImpactSecondaryMembership[];
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

export interface LocalClientRecord {
  id: string;
  userId: string;
  deviceId: string;
  clientName: string;
  platform: string;
  capabilities: Record<string, unknown>;
  syncRootId: string;
  syncRootLabel: string;
  enabled: boolean;
  default: boolean;
  createdAt: string;
  updatedAt: string;
  heartbeat?: {
    daemonVersion?: string;
    syncRootState: Record<string, unknown>;
    lastSeenAt: string;
    online: boolean;
  };
}

export interface LocalClientAuditEventRecord {
  id: string;
  userId: string;
  localClientId?: string;
  eventType: string;
  actorType: "user" | "local_client" | "system";
  actorId?: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface LocalJobResultRecord extends Record<string, unknown> {
  localPath?: string;
  localPathAvailable?: boolean;
  localPathRedacted?: boolean;
  checksum?: string;
  sizeBytes?: number;
}

export interface LocalJobRecord {
  id: string;
  userId: string;
  localClientId: string;
  idempotencyKey?: string;
  kind: "download_artifact" | "download_task_attachment" | "materialize_resource";
  target: "downloads" | "sync-folder";
  payload: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  nextAttemptAt?: string;
  expiresAt?: string;
  result: LocalJobResultRecord;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalDaemonPreferences {
  autoStart: boolean;
  residentMode?: boolean;
  syncRoot?: string | null;
  downloadsDir?: string | null;
  syncRootBase?: string | null;
  downloadsDirBase?: string | null;
  coreUrl?: string | null;
  effectiveSyncRoot?: string;
  effectiveDownloadsDir?: string;
  effectiveCoreUrl?: string | null;
  accountFolderSegment?: string;
  accountLabel?: string;
}

export interface LocalJobEventRecord {
  id: string;
  jobId: string;
  userId: string;
  localClientId: string;
  eventType: "created" | "claimed" | "completed" | "failed" | "retry_scheduled" | "expired";
  detail: Record<string, unknown>;
  createdAt: string;
}

export type LocalJobConfirmationPolicy = "off" | "downloads" | "all";

export interface LocalDaemonPendingJobConfirmation {
  jobId: string;
  kind: LocalJobRecord["kind"];
  target: LocalJobRecord["target"];
  status: "pending_confirmation";
  requestedAt: string;
  reason: string;
  destinationRoot: string;
  requestedFilename?: string;
  payload: {
    artifactItemId?: string;
    taskId?: string;
    attachmentId?: string;
    domain?: string;
    filename?: string;
  };
}

export interface CaptureDaemonConfig {
  enabled: boolean;
  uploadEnabled: boolean;
  screenshotsEnabled: boolean;
  screenshotIntervalSeconds: number;
  screenshotRetentionDays: number;
  intervalSeconds: number;
  retentionDays: number;
  excludePatterns: string[];
}

export type CaptureDaemonConfigPatch = Partial<
  Pick<CaptureDaemonConfig, "intervalSeconds" | "retentionDays" | "excludePatterns" | "uploadEnabled" | "screenshotsEnabled" | "screenshotIntervalSeconds" | "screenshotRetentionDays">
>;

export interface CaptureDaemonStatus {
  enabled: boolean;
  collectorAlive: boolean;
  lastSampleAt?: string;
  lastSummaryAt?: string;
  sampleCount24h: number;
}

export interface CaptureDaemonState {
  dbPath?: string;
  config: CaptureDaemonConfig;
  status: CaptureDaemonStatus;
}

export interface CaptureSummaryResult {
  summaryDate: string;
  noteResourceId?: string;
  generatedAt: string;
  sampleCount: number;
  action: "create" | "update" | "saved";
  title: string;
}

export interface CaptureSummaryRecord {
  summaryDate: string;
  noteResourceId?: string;
  generatedAt: string;
  sampleCount: number;
  published: boolean;
  summaryMarkdown?: string;
}

export interface CaptureSummaryListResult {
  items: CaptureSummaryRecord[];
  nextCursor?: string;
}

export interface CaptureScreenshot {
  id: number;
  capturedAt: string;
  processName?: string;
  windowTitle?: string;
}

export interface CaptureScreenshotListResult {
  items: CaptureScreenshot[];
  nextCursor?: string;
}

export type AnalyserObservationSource =
  | "workbench_change"
  | "mcp_access"
  | "ui_access"
  | "agent_session"
  | "pc_activity"
  | "local_file";

export type AnalyserActorKind = "user" | "agent" | "system";

export interface AnalyserResourceRef {
  service: string;
  resourceType: string;
  resourceId: string;
  pathSnapshot?: string;
}

export interface AnalyserCollectionSettings {
  workbenchChanges: "off" | "metadata";
  mcpAccess: "off" | "mutations" | "reads_and_mutations";
  uiAccess: "off" | "mutations" | "reads_and_mutations";
  agentSessionEvents: "off" | "explicit_only";
  foregroundAppCapture: boolean;
  foregroundAppUpload: boolean;
  windowTitleCapture: boolean;
  windowTitleUpload: boolean;
  localFileEvents: "off" | "metadata";
  localFileUpload: boolean;
  screenshots: "off" | "local_only";
  retentionDays: Record<AnalyserObservationSource, number>;
  localScreenshotRetentionDays: number;
  projectAllow: string[];
  projectDeny: string[];
  resourceTypeAllow: string[];
  resourceTypeDeny: string[];
  localRootAllow: string[];
  localRootDeny: string[];
  excludePatterns: string[];
}

export type AnalyserCollectionSettingsOverride = Partial<
  Omit<AnalyserCollectionSettings, "retentionDays">
> & { retentionDays?: Partial<Record<AnalyserObservationSource, number>> };

export const ANALYSER_OPERATION_KINDS = [
  "artifact_move",
  "artifact_metadata_update",
  "artifact_secondary_membership_add",
  "progress_note_upsert"
] as const;

export type AnalyserOperationKind = (typeof ANALYSER_OPERATION_KINDS)[number];

export interface AnalyserAutomationPolicy {
  enabled: boolean;
  requireHighConfidence: boolean;
  destructiveAllowed: boolean;
  bulkAllowed: boolean;
  allowedOperationKinds: AnalyserOperationKind[];
}

export interface AnalyserMachineRecord {
  id: string;
  machineKey: string;
  displayName?: string;
  platform?: string;
  registeredAt: string;
  lastSeenAt: string;
}

export interface AnalyserObservationRecord {
  seq: string;
  id: string;
  source: AnalyserObservationSource;
  action: string;
  actorKind: AnalyserActorKind;
  machineId?: string;
  projectId?: string;
  occurredAt: string;
  resourceRefs?: AnalyserResourceRef[];
  metadata?: Record<string, string | number | boolean | null>;
  sourceEventId?: string;
  dedupeKey: string;
  receivedAt: string;
  expiresAt: string;
}

export interface AnalyserActivityAggregateDay {
  date: string;
  machineId: string | null;
  sampleCount: number;
  idleCount: number;
  activeCount: number;
  apps: Record<string, number>;
}

export interface AnalyserActivityAggregateTotals {
  sampleCount: number;
  idleCount: number;
  activeCount: number;
  apps: Record<string, number>;
}

export interface AnalyserActivityAggregate {
  days: AnalyserActivityAggregateDay[];
  totals: AnalyserActivityAggregateTotals;
}

export interface AnalyserRoutineRecord {
  id: string;
  key: string;
  name: string;
  skillKey: string;
  skillVersion?: string;
  scheduleKind: "interval" | "cron";
  scheduleExpr: string;
  timezone: string;
  enabled: boolean;
  nextRunAt?: string;
  committedCursor: string;
  maxRetries: number;
  backoffMinutes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyserRoutineStatusSummary {
  key: string;
  enabled: boolean;
  nextRunAt?: string;
  lastCompletedAt?: string;
  lastFailedAt?: string;
  lastErrorSummary?: string;
  activeRun: { id: string; holder: string; leaseExpiresAt: string } | null;
}

export interface AnalyserSummaryRecord {
  id: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  title: string;
  bodyMarkdown: string;
  metrics?: Record<string, unknown>;
  evidenceRefs: AnalyserResourceRef[];
  routineKey?: string;
  runId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AnalyserSummaryListItem = Omit<AnalyserSummaryRecord, "bodyMarkdown"> & { bodyChars: number };

export interface AnalyserProposedAction {
  kind: AnalyserOperationKind | "other";
  params?: Record<string, string | number | boolean | null | string[]>;
}

export interface AnalyserConfidenceEvidence {
  deterministicTarget?: boolean;
  currentEvidence?: boolean;
  policyAllowed?: boolean;
  concurrencyProtected?: boolean;
  reversibleOrNonDestructive?: boolean;
  notes?: string;
}

export type AnalyserProposalStatus = "open" | "approved" | "rejected" | "executed" | "superseded";

export interface AnalyserProposalRecord {
  id: string;
  kind: string;
  title: string;
  bodyMarkdown: string;
  evidenceRefs: AnalyserResourceRef[];
  proposedAction?: AnalyserProposedAction;
  confidenceEvidence?: AnalyserConfidenceEvidence;
  status: AnalyserProposalStatus;
  approvedBy?: string;
  approvedAt?: string;
  approvalProvenance?: string;
  routineKey?: string;
  runId?: string;
  dedupeKey?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AnalyserProposalListItem = Omit<AnalyserProposalRecord, "bodyMarkdown"> & { bodyChars: number };

export interface AnalyserOperationRecord {
  id: string;
  operationKind: AnalyserOperationKind;
  approvalBasis: "policy" | "proposal";
  proposalId?: string;
  beforeRefs: AnalyserResourceRef[];
  afterRefs: AnalyserResourceRef[];
  result: "succeeded" | "failed" | "skipped";
  detail?: Record<string, string | number | boolean | null>;
  runId?: string;
  agentLabel?: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface AnalyserPublicationRecord {
  id: string;
  sourceKind: "summary" | "proposal";
  sourceId: string;
  targetKind: "note" | "artifact";
  targetId: string;
  targetRef?: AnalyserResourceRef;
  contentHash: string;
  provenance: "ui" | "agent";
  createdAt: string;
}

export interface AnalyserExportInput {
  sourceKind: "summary" | "proposal";
  sourceId: string;
  targetKind: "note" | "artifact";
  projectId?: string;
  title?: string;
  path?: string;
}

export interface AnalyserExportResult {
  publication: AnalyserPublicationRecord;
  created: boolean;
  target: {
    kind: "note" | "artifact";
    id: string;
    ref?: AnalyserResourceRef;
  };
}

export interface AnalyserCollectionPolicyRecord {
  machineId: string | null;
  settings: AnalyserCollectionSettingsOverride;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AnalyserAutomationPolicyRecord {
  policy: AnalyserAutomationPolicy;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AnalyserSettingsResult {
  effective: {
    settings: AnalyserCollectionSettings;
    ownerVersion?: number;
    machineVersion?: number;
  };
  rows: AnalyserCollectionPolicyRecord[];
  automation: {
    policy: AnalyserAutomationPolicy;
    version?: number;
    updatedAt?: string;
  };
}

export interface AnalyserStatusResult {
  routines: AnalyserRoutineStatusSummary[];
  hasOpenProposals: boolean;
  machines: AnalyserMachineRecord[];
}

export interface AnalyserProjectorFlushResult {
  projected: number;
  skipped?: true;
  duplicates?: number;
  rejected?: number;
  batches?: number;
}

export interface LocalDaemonStatus {
  status: string;
  coreUrl: string;
  syncRoot: string;
  manifestDbPath?: string;
  downloadsDir: string;
  watchEnabled?: boolean;
  watcherActive?: boolean;
  watchDebounceMs?: number;
  syncActive?: boolean;
  tickRunning?: boolean;
  tickQueued?: boolean;
  localJobConfirmationPolicy?: LocalJobConfirmationPolicy;
  localJobConfirmationsPending?: number;
  localClientId?: string;
  lastHeartbeatAt?: string;
  lastClaimAt?: string;
  lastScanAt?: string;
  lastPushAt?: string;
  lastRemotePullAt?: string;
  remoteSyncCursor?: string;
  remoteArtifactCursor?: string;
  remoteArtifactSnapshotComplete?: boolean;
  lastError?: string;
  lastErrorCode?: string;
  lastErrorCategory?: LocalDaemonSyncErrorCategory;
  lastErrorRetryable?: boolean;
  processedJobs?: number;
  outboxPending?: number;
  outboxFailed?: number;
  conflictsOpen?: number;
  capture?: CaptureDaemonStatus;
}

export type LocalDaemonSyncErrorCategory =
  | "network"
  | "auth"
  | "capability"
  | "version_conflict"
  | "path_rejection"
  | "validation"
  | "checksum"
  | "unsupported"
  | "local_conflict"
  | "server"
  | "unknown";

export interface LocalDaemonConflictRecord {
  id: string;
  outboxId?: string;
  clientOpId?: string;
  relativePath: string;
  domain: "projects" | "notes" | "artifacts" | "tasks";
  action: "create" | "update" | "delete";
  resourceId?: string;
  payload: Record<string, unknown>;
  errorMessage: string;
  errorCode?: string;
  errorCategory?: LocalDaemonSyncErrorCategory;
  retryable?: boolean;
  conflictPath?: string;
  status: "open" | "resolved" | "ignored";
  createdAt: string;
  resolvedAt?: string;
  resolution?: "retry" | "ignore" | "close";
  resolutionNote?: string;
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

export interface ImageContextSnapshot {
  refs: ImageContextRef[];
  summary?: string;
}

export interface ImageJobRecord {
  jobId: string;
  status: ImageJobStatus;
  intent: ImageIntent;
  parentJobId?: string;
  provider: Exclude<ImageProvider, "auto">;
  model: string;
  prompt: string;
  instruction?: string;
  negativePrompt?: string;
  request: Record<string, unknown>;
  contextSnapshot?: ImageContextSnapshot;
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
  cancelledAt?: string;
  deletedAt?: string;
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
  availableModels: Record<Exclude<ImageProvider, "auto">, Array<{ id: string; label: string; description?: string }>>;
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
