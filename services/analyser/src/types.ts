import { z } from "zod";

export const OBSERVATION_SOURCES = [
  "workbench_change",
  "mcp_access",
  "ui_access",
  "agent_session",
  "pc_activity",
  "local_file"
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const ACTOR_KINDS = ["user", "agent", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ResourceRef {
  service: string;
  resourceType: string;
  resourceId: string;
  pathSnapshot?: string;
}

export const dateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date");

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const resourceRefSchema = z.object({
  service: z.string().trim().min(1),
  resourceType: z.string().trim().min(1),
  resourceId: z.string().trim().min(1),
  pathSnapshot: z.string().optional()
}).strict();

export interface CollectionSettings {
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
  screenshotDerivedUpload: boolean;
  retentionDays: Record<ObservationSource, number>;
  localScreenshotRetentionDays: number;
  projectAllow: string[];
  projectDeny: string[];
  resourceTypeAllow: string[];
  resourceTypeDeny: string[];
  localRootAllow: string[];
  localRootDeny: string[];
  excludePatterns: string[];
}

export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  workbenchChanges: "metadata",
  mcpAccess: "mutations",
  uiAccess: "mutations",
  agentSessionEvents: "explicit_only",
  foregroundAppCapture: false,
  foregroundAppUpload: false,
  windowTitleCapture: false,
  windowTitleUpload: false,
  localFileEvents: "off",
  localFileUpload: false,
  screenshots: "off",
  screenshotDerivedUpload: false,
  retentionDays: {
    workbench_change: 30,
    mcp_access: 30,
    ui_access: 30,
    agent_session: 30,
    pc_activity: 30,
    local_file: 30
  },
  localScreenshotRetentionDays: 7,
  projectAllow: [],
  projectDeny: [],
  resourceTypeAllow: [],
  resourceTypeDeny: [],
  localRootAllow: [],
  localRootDeny: [],
  excludePatterns: []
};

const retentionDaysValueSchema = z.number().int().min(1).max(90);
const retentionDaysSchema = z.object({
  workbench_change: retentionDaysValueSchema.optional(),
  mcp_access: retentionDaysValueSchema.optional(),
  ui_access: retentionDaysValueSchema.optional(),
  agent_session: retentionDaysValueSchema.optional(),
  pc_activity: retentionDaysValueSchema.optional(),
  local_file: retentionDaysValueSchema.optional()
}).strict();
const stringArraySchema = z.array(z.string());

export const collectionSettingsSchema = z.object({
  workbenchChanges: z.enum(["off", "metadata"]).optional(),
  mcpAccess: z.enum(["off", "mutations", "reads_and_mutations"]).optional(),
  uiAccess: z.enum(["off", "mutations", "reads_and_mutations"]).optional(),
  agentSessionEvents: z.enum(["off", "explicit_only"]).optional(),
  foregroundAppCapture: z.boolean().optional(),
  foregroundAppUpload: z.boolean().optional(),
  windowTitleCapture: z.boolean().optional(),
  windowTitleUpload: z.boolean().optional(),
  localFileEvents: z.enum(["off", "metadata"]).optional(),
  localFileUpload: z.boolean().optional(),
  screenshots: z.enum(["off", "local_only"]).optional(),
  screenshotDerivedUpload: z.boolean().optional(),
  retentionDays: retentionDaysSchema.optional(),
  localScreenshotRetentionDays: z.number().int().min(1).max(30).optional(),
  projectAllow: stringArraySchema.optional(),
  projectDeny: stringArraySchema.optional(),
  resourceTypeAllow: stringArraySchema.optional(),
  resourceTypeDeny: stringArraySchema.optional(),
  localRootAllow: stringArraySchema.optional(),
  localRootDeny: stringArraySchema.optional(),
  excludePatterns: stringArraySchema.optional()
}).strict();

export const ANALYSER_OPERATION_KINDS = [
  "artifact_move",
  "artifact_metadata_update",
  "artifact_secondary_membership_add",
  "progress_note_upsert"
] as const;
export type AnalyserOperationKind = (typeof ANALYSER_OPERATION_KINDS)[number];

export interface AutomationPolicy {
  enabled: boolean;
  requireHighConfidence: boolean;
  destructiveAllowed: boolean;
  bulkAllowed: boolean;
  allowedOperationKinds: AnalyserOperationKind[];
}

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  enabled: true,
  requireHighConfidence: true,
  destructiveAllowed: false,
  bulkAllowed: false,
  allowedOperationKinds: [...ANALYSER_OPERATION_KINDS]
};

export const automationPolicySchema = z.object({
  enabled: z.boolean(),
  requireHighConfidence: z.boolean(),
  destructiveAllowed: z.boolean(),
  bulkAllowed: z.boolean(),
  allowedOperationKinds: z.array(z.enum(ANALYSER_OPERATION_KINDS))
}).strict();

export type CollectionSettingsOverride = z.infer<typeof collectionSettingsSchema>;

export interface MachineRecord {
  id: string;
  machineKey: string;
  displayName?: string;
  platform?: string;
  registeredAt: string;
  lastSeenAt: string;
}

export const observationInputSchema = z.object({
  source: z.enum(OBSERVATION_SOURCES),
  action: z.string().trim().min(1).max(200),
  actorKind: z.enum(ACTOR_KINDS),
  machineId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  occurredAt: isoDateTimeSchema,
  resourceRefs: z.array(resourceRefSchema).optional(),
  metadata: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).optional(),
  sourceEventId: z.string().optional(),
  dedupeKey: z.string().trim().min(1)
}).strict();

export interface ObservationInput {
  source: ObservationSource;
  action: string;
  actorKind: ActorKind;
  machineId?: string;
  projectId?: string;
  occurredAt: string;
  resourceRefs?: ResourceRef[];
  metadata?: Record<string, string | number | boolean | null>;
  sourceEventId?: string;
  dedupeKey: string;
}

export interface ObservationRecord extends ObservationInput {
  seq: string;
  id: string;
  receivedAt: string;
  expiresAt: string;
}

export interface DerivedCaptureInput {
  machineId?: string;
  kind: string;
  title: string;
  summaryMarkdown: string;
  evidenceRefs?: ResourceRef[];
  occurredAt: string;
  dedupeKey: string;
}

export const derivedCaptureInputSchema = z.object({
  machineId: z.string().uuid().optional(),
  kind: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  summaryMarkdown: z.string().max(20_000),
  evidenceRefs: z.array(resourceRefSchema).max(50).optional(),
  occurredAt: isoDateTimeSchema,
  dedupeKey: z.string().trim().min(1).max(500)
}).strict();

export interface DerivedCaptureRecord {
  id: string;
  machineId?: string;
  kind: string;
  title: string;
  summaryMarkdown: string;
  evidenceRefs: ResourceRef[];
  occurredAt: string;
  receivedAt: string;
  createdAt: string;
}

export interface ActivityAggregateDay {
  date: string;
  machineId: string | null;
  sampleCount: number;
  idleCount: number;
  activeCount: number;
  apps: Record<string, number>;
}

export interface ActivityAggregateTotals {
  sampleCount: number;
  idleCount: number;
  activeCount: number;
  apps: Record<string, number>;
}

export interface ActivityAggregate {
  days: ActivityAggregateDay[];
  totals: ActivityAggregateTotals;
}

export interface RoutineRecord {
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

export interface RunRecord {
  id: string;
  routineId: string;
  routineKey?: string;
  status: "claimed" | "processing" | "completed" | "failed";
  holder: string;
  leaseExpiresAt: string;
  policySnapshot: {
    collectionSettings: CollectionSettings;
    automationPolicy: AutomationPolicy;
  };
  pendingReadCursor: string;
  attempt: number;
  errorSummary?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ClaimResult {
  run: RunRecord;
  routine: RoutineRecord;
  collectionSettings: CollectionSettings;
  automationPolicy: AutomationPolicy;
}

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalResourceRefsSchema = z.array(resourceRefSchema).max(50).optional();
const scalarSchema = z.union([z.string().trim().max(2_000), z.number().finite(), z.boolean(), z.null()]);
const flatObjectSchema = z.record(scalarSchema);
const proposedActionParamsSchema = z.record(z.union([
  scalarSchema,
  z.array(z.string().trim().max(2_000)).max(50)
]));

export const proposedActionSchema = z.object({
  kind: z.union([z.enum(ANALYSER_OPERATION_KINDS), z.literal("other")]),
  params: proposedActionParamsSchema.optional()
}).strict();

export const confidenceEvidenceSchema = z.object({
  deterministicTarget: z.boolean().optional(),
  currentEvidence: z.boolean().optional(),
  policyAllowed: z.boolean().optional(),
  concurrencyProtected: z.boolean().optional(),
  reversibleOrNonDestructive: z.boolean().optional(),
  notes: z.string().trim().max(2_000).optional()
}).strict();

export const summaryInputSchema = z.object({
  kind: boundedText(100),
  periodStart: dateSchema,
  periodEnd: dateSchema,
  title: boundedText(500),
  bodyMarkdown: z.string().trim().max(200_000),
  metrics: z.record(z.unknown()).optional(),
  evidenceRefs: optionalResourceRefsSchema,
  routineKey: boundedText(2_000).optional(),
  runId: boundedText(2_000).optional(),
  expectedVersion: z.number().int().positive().optional()
}).strict().superRefine((value, context) => {
  if (value.periodStart > value.periodEnd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "periodEnd must be on or after periodStart" });
  }
});

export const proposalInputSchema = z.object({
  kind: boundedText(100),
  title: boundedText(500),
  bodyMarkdown: z.string().trim().max(200_000),
  evidenceRefs: optionalResourceRefsSchema,
  proposedAction: proposedActionSchema.optional(),
  confidenceEvidence: confidenceEvidenceSchema.optional(),
  routineKey: boundedText(2_000).optional(),
  runId: boundedText(2_000).optional(),
  dedupeKey: boundedText(2_000).optional()
}).strict();

export const proposalContentUpdateSchema = z.object({
  title: boundedText(500).optional(),
  bodyMarkdown: z.string().trim().max(200_000).optional(),
  evidenceRefs: optionalResourceRefsSchema,
  proposedAction: proposedActionSchema.optional(),
  confidenceEvidence: confidenceEvidenceSchema.optional(),
  expectedVersion: z.number().int().positive()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"), {
  message: "At least one content field is required"
});

export const proposalResolutionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  resolvedBy: boundedText(2_000),
  provenance: boundedText(2_000),
  expectedVersion: z.number().int().positive()
}).strict();

export const proposalExecutionSchema = z.object({
  operationId: boundedText(2_000),
  expectedVersion: z.number().int().positive()
}).strict();

export const proposalSupersedeSchema = z.object({
  expectedVersion: z.number().int().positive()
}).strict();

export const operationInputSchema = z.object({
  operationKind: z.enum(ANALYSER_OPERATION_KINDS),
  approvalBasis: z.enum(["policy", "proposal"]),
  proposalId: boundedText(2_000).optional(),
  beforeRefs: optionalResourceRefsSchema,
  afterRefs: optionalResourceRefsSchema,
  result: z.enum(["succeeded", "failed", "skipped"]),
  detail: flatObjectSchema.optional(),
  runId: boundedText(2_000).optional(),
  agentLabel: boundedText(2_000).optional(),
  idempotencyKey: boundedText(2_000)
}).strict().superRefine((value, context) => {
  if (value.approvalBasis === "proposal" && !value.proposalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proposalId"], message: "proposalId is required for proposal approval" });
  }
  if (value.approvalBasis === "policy" && value.proposalId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proposalId"], message: "proposalId is only valid for proposal approval" });
  }
});

export const publicationInputSchema = z.object({
  sourceKind: z.enum(["summary", "proposal"]),
  sourceId: boundedText(2_000),
  targetKind: z.enum(["note", "artifact"]),
  targetId: boundedText(2_000),
  targetRef: resourceRefSchema.optional(),
  contentHash: z.string().trim().min(8).max(128).regex(/^[0-9a-fA-F]+$/, "Expected a hexadecimal content hash"),
  provenance: z.enum(["ui", "agent"])
}).strict();

export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type ConfidenceEvidence = z.infer<typeof confidenceEvidenceSchema>;
export type SummaryInput = z.infer<typeof summaryInputSchema>;
export type ProposalInput = z.infer<typeof proposalInputSchema>;
export type ProposalContentUpdate = z.infer<typeof proposalContentUpdateSchema>;
export type ProposalResolution = z.infer<typeof proposalResolutionSchema>;
export type ProposalExecution = z.infer<typeof proposalExecutionSchema>;
export type ProposalSupersede = z.infer<typeof proposalSupersedeSchema>;
export type OperationInput = z.infer<typeof operationInputSchema>;
export type PublicationInput = z.infer<typeof publicationInputSchema>;

export const publicationReserveInputSchema = publicationInputSchema.omit({ targetId: true, targetRef: true });
export type PublicationReserveInput = z.infer<typeof publicationReserveInputSchema>;

export const publicationFinalizeInputSchema = z.object({
  targetId: boundedText(2_000),
  targetRef: resourceRefSchema.optional()
}).strict();
export type PublicationFinalizeInput = z.infer<typeof publicationFinalizeInputSchema>;

export interface SummaryRecord {
  id: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  title: string;
  bodyMarkdown: string;
  metrics?: Record<string, unknown>;
  evidenceRefs: ResourceRef[];
  routineKey?: string;
  runId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type SummaryListItem = Omit<SummaryRecord, "bodyMarkdown"> & { bodyChars: number };

export type ProposalStatus = "open" | "approved" | "rejected" | "executed" | "superseded";
export interface ProposalRecord {
  id: string;
  kind: string;
  title: string;
  bodyMarkdown: string;
  evidenceRefs: ResourceRef[];
  proposedAction?: ProposedAction;
  confidenceEvidence?: ConfidenceEvidence;
  status: ProposalStatus;
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

export type ProposalListItem = Omit<ProposalRecord, "bodyMarkdown"> & { bodyChars: number };

export interface OperationRecord {
  id: string;
  operationKind: AnalyserOperationKind;
  approvalBasis: "policy" | "proposal";
  proposalId?: string;
  beforeRefs: ResourceRef[];
  afterRefs: ResourceRef[];
  result: "succeeded" | "failed" | "skipped";
  detail?: Record<string, string | number | boolean | null>;
  runId?: string;
  agentLabel?: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface PublicationRecord {
  id: string;
  sourceKind: "summary" | "proposal";
  sourceId: string;
  targetKind: "note" | "artifact";
  targetId: string;
  targetRef?: ResourceRef;
  contentHash: string;
  provenance: "ui" | "agent";
  createdAt: string;
}
