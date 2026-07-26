import { z } from "zod";
import { deepResearchProviderSchema, deepResearchSpeedSchema } from "./deepResearch.js";

export const accountSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

export const integrationConfigSchema = z.object({
  enabled: z.boolean(),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
});

export const taskImportBodySchema = z.union([z.string(), z.object({ csv: z.string() })]);

export const deepResearchRequestSchema = z.object({
  query: z.string().min(1),
  provider: deepResearchProviderSchema.optional(),
  speed: deepResearchSpeedSchema.optional(),
  timeoutSec: z.number().int().positive().optional(),
  asyncOnTimeout: z.boolean().optional(),
  saveToArtifacts: z.boolean().optional(),
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional()
});

export const deepResearchManualSaveSchema = z.object({
  artifactTitle: z.string().optional(),
  artifactPath: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  createNew: z.boolean().optional()
});




export const jsonRecordSchema = z.record(z.unknown());

export const localClientRegisterSchema = z.object({
  deviceId: z.string().min(1),
  clientName: z.string().min(1),
  platform: z.string().min(1),
  capabilities: jsonRecordSchema.optional(),
  syncRootId: z.string().min(1).optional(),
  syncRootLabel: z.string().min(1).optional(),
  default: z.boolean().optional()
});

export const localClientPatchSchema = z.object({
  clientName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  capabilities: jsonRecordSchema.optional(),
  syncRootLabel: z.string().min(1).optional(),
  default: z.boolean().optional()
});

export const localClientHeartbeatSchema = z.object({
  daemonVersion: z.string().optional(),
  syncRootState: jsonRecordSchema.optional()
});

export const localJobKindSchema = z.enum(["download_artifact", "download_task_attachment", "materialize_resource"]);
export const localJobTargetSchema = z.enum(["downloads", "sync-folder"]);
export const localJobStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

export const localJobCreateSchema = z.object({
  localClientId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  kind: localJobKindSchema,
  target: localJobTargetSchema,
  payload: jsonRecordSchema.optional(),
  ttlSeconds: z.number().int().positive().optional()
});

export const localJobClaimSchema = z.object({
  limit: z.number().int().positive().max(25).optional()
});

export const localJobCompleteSchema = z.object({
  result: jsonRecordSchema.default({})
});

export const localJobFailSchema = z.object({
  error: z.string().min(1),
  retryable: z.boolean().optional(),
  retryAfterSeconds: z.number().int().nonnegative().max(86400).optional()
});

export const syncPushSchema = z.object({
  ops: z.array(jsonRecordSchema).default([])
});

export const syncBlobPutSchema = z.object({
  contentBase64: z.string(),
  filename: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  checksum: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative().optional(),
  expectedVersion: z.number().int().positive().optional()
});
