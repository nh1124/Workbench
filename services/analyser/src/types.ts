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
  action: z.string().trim().min(1),
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
