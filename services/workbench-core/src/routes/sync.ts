import cors from "cors";
import { config as loadEnv } from "dotenv";
import express from "express";
import jwt from "jsonwebtoken";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { installProcessHandlers, requestLogger } from "@workbench/logging";
import { issueTokenBundle, verifyAccessToken, verifyRefreshToken } from "../auth.js";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "../refreshCookie.js";
import { logger } from "../logger.js";
import { ensureCoreSchema } from "../db.js";
import { getIntegrationManifests } from "../integrations/index.js";
import { registerArtifactsTools } from "../mcp/registerArtifactsTools.js";
import { registerDeepResearchTools } from "../mcp/registerDeepResearchTools.js";
import { registerImageTools } from "../mcp/registerImageTools.js";
import { registerAnalyserTools } from "../mcp/registerAnalyserTools.js";
import { registerMindmapTools } from "../mcp/registerMindmapTools.js";
import { registerNotesTools } from "../mcp/registerNotesTools.js";
import { registerProjectsTools } from "../mcp/registerProjectsTools.js";
import { registerProjectContextTools } from "../mcp/registerProjectContextTools.js";
import { registerTasksTools } from "../mcp/registerTasksTools.js";
import { registerWbsTools } from "../mcp/registerWbsTools.js";
import { ensureIntegrationLinked } from "../integrationLinking.js";
import { artifactsClient, InternalServiceError, notesClient, projectsClient, serviceBaseUrls, tasksClient } from "../internalClients.js";
import { startAnalyserProjector } from "../analyserProjector.js";
import { analyserHttpAccessMiddleware, instrumentMcpServer } from "../analyserAccessInstrumentation.js";
import { saveOAuthDynamicClient } from "../oauthDynamicClientsStore.js";
import {
  accountSchema,
  integrationConfigSchema,
  refreshSchema,
  syncBlobPutSchema,
  syncPushSchema,
  taskImportBodySchema
} from "../schemas/requests.js";
import {
  commitSyncChangesCursor,
  initializeSyncChangesConsumer,
  pullSyncChanges
} from "../syncChanges.js";
import {
  createArtifactNoteWithIndex,
  createProjectLinkWithValidation,
  deleteProjectWithGuard,
  getArtifactProjectMemberships,
  getProjectContextWithResolvedLinks,
  getProjectDeletionImpact,
  listArtifactProjectIdsBestEffort,
  listProjectLinksResolved,
  linkArtifactToProject,
  maintainArtifactIndexBestEffort,
  projectIdsFromArtifactDeletionSnapshot,
  rebuildProjectIndex,
  reconcileArtifactMutationBestEffort,
  removeArtifactItemWithProjectCleanup,
  removeProjectLinkWithValidation,
  unlinkArtifactFromProject,
  uploadArtifactFileWithIndex
} from "../projectContext.js";
import { artifactDeletionSnapshotRoot, artifactEventMetadata } from "../syncEventMetadata.js";
import {
  LocalClientStoreError
} from "../localClientsStore.js";
import {
  getAppliedClientOp,
  getLatestSyncCursor,
  getSyncResourceVersion,
  listSyncEvents,
  recordSyncEvent,
  type SyncAction,
  type SyncDomain
} from "../syncStore.js";
import {
  buildProjectContextSyncItem,
  parseProjectContextBaselineCursor,
  projectContextSnapshotPage,
  projectIdFromMutationResult,
  ProjectContextSyncError,
  recordProjectContextInvalidation,
  recordProjectContextInvalidationsBestEffort,
  requireProjectContextEndpoints,
  SYNC_SUPPORTED_DOMAINS,
  type ProjectContextChanged
} from "../projectContextSync.js";
import { buildProjectContextExportResponse } from "../projectContextExport.js";
import {
  configuredServiceIds,
  provisionAccountToServices
} from "../serviceProvisioning.js";
import {
  findUserById,
  listIntegrationConfigs,
  listProvisionings,
  loginUser,
  registerUser,
  saveIntegrationConfig
} from "../store.js";
import {
  readAuthorizeParams,
  renderAuthorizeLoginForm,
  type AuthorizeRequestParams
} from "../oauth/authorizeRequest.js";
import {
  parseDynamicClientRegistrationPayload,
  resolveOAuthClient,
  type DynamicClientRegistrationPayload
} from "../oauth/clients.js";
import {
  buildCanonicalMcpResource,
  buildOAuthIssuer,
  canonicalBaseConfig,
  DYNAMIC_CLIENT_REGISTRATION_PATH,
  joinIssuerPath,
  oauthJwtExpirySeconds,
  supportedMcpScopes
} from "../oauth/config.js";
import {
  readBearerToken,
  requireAuthenticatedContext,
  requireSyncAccessContext,
  type SyncAccessContext
} from "../middleware/auth.js";
import {
  AUTHORIZATION_CODE_TTL_MS,
  authorizationCodeStore,
  base64UrlSha256,
  cleanupExpiredAuthorizationCodes,
  cleanupExpiredRefreshTokens,
  hashOpaqueToken,
  isScopeSubset,
  issueOAuthRefreshToken,
  issueUserOAuthAccessToken,
  normalizeScope,
  oauthRefreshTokenStore
} from "../oauth/tokens.js";
import { registerAnalyserRoutes } from "../routes/analyser.js";
import { registerArtifactRoutes } from "../routes/artifacts.js";
import { registerDeepResearchRoutes } from "../routes/deep-research.js";
import { registerImageRoutes } from "../routes/images.js";
import { registerMindmapRoutes } from "../routes/mindmaps.js";
import { registerNoteRoutes } from "../routes/notes.js";
import { registerProjectRoutes } from "../routes/projects.js";
import { registerLocalClientRoutes } from "../routes/local-clients.js";
import { registerLocalJobRoutes } from "../routes/local-jobs.js";
import {
  asJsonRecord,
  asNonEmptyString,
  CLIENT_OP_ID_HEADER,
  invalidateArtifactIndexFromApi,
  invalidateProjectContextFromApi,
  jsonRecordFromBuffer,
  objectId,
  recordSyncEventBestEffort,
  respondInternalError,
  sha256Checksum,
  syncEventBroadcaster,
  syncRequestContext
} from "../routes/shared.js";
import { registerWbsRoutes } from "../routes/wbs.js";
import { registerTaskRoutes } from "../routes/tasks.js";


function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LocalClientStoreError(400, "SYNC_BASE_VERSION_INVALID", `${fieldName} must be a non-negative integer.`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LocalClientStoreError(400, "SYNC_EXPECTED_VERSION_INVALID", `${fieldName} must be a positive integer.`);
  }
  return value;
}

function decodeContentBase64(contentBase64: string): { compactBase64: string; buffer: Buffer } {
  const compactBase64 = contentBase64.replace(/\s+/g, "");
  if (compactBase64.length === 0) {
    return { compactBase64, buffer: Buffer.alloc(0) };
  }
  if (compactBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compactBase64)) {
    throw new LocalClientStoreError(400, "SYNC_BLOB_BASE64_INVALID", "contentBase64 must be valid base64.");
  }
  return {
    compactBase64,
    buffer: Buffer.from(compactBase64, "base64")
  };
}

function withoutKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const next = { ...record };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}

function syncEventPayloadMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  return withoutKeys(payload, ["contentBase64"]);
}

function requireSyncString(record: Record<string, unknown>, fieldName: string, code: string, message: string): string {
  const value = asNonEmptyString(record[fieldName]);
  if (!value) {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalSyncString(record: Record<string, unknown>, fieldName: string, code: string, message: string): string | undefined {
  if (record[fieldName] === undefined) return undefined;
  const value = asNonEmptyString(record[fieldName]);
  if (!value) {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalRawString(record: Record<string, unknown>, fieldName: string, code: string, message: string): string | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function optionalNullableRawString(
  record: Record<string, unknown>,
  fieldName: string,
  code: string,
  message: string
): string | null | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function validateSyncNoteMutationPayload(payload: Record<string, unknown>): void {
  const code = "SYNC_NOTE_PAYLOAD_INVALID";
  const tags = payload.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
    throw new LocalClientStoreError(400, code, "Note tags must be an array of strings when provided.");
  }
}

function optionalNonNegativeSyncInteger(
  record: Record<string, unknown>,
  fieldName: string,
  code: string,
  message: string
): number | undefined {
  const value = record[fieldName];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LocalClientStoreError(400, code, message);
  }
  return value;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalScheduleItemId(payload: Record<string, unknown>): number | undefined {
  return asPositiveInteger(payload.scheduleId) ?? asPositiveInteger(payload.id);
}

function taskRelationTaskId(op: Record<string, unknown>, payload: Record<string, unknown>): string | undefined {
  return asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.taskId);
}

function requireTaskRelationTaskId(
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  code: string,
  message: string
): string {
  const taskId = taskRelationTaskId(op, payload);
  if (!taskId) {
    throw new LocalClientStoreError(400, code, message);
  }
  return taskId;
}

function scheduleCreatePayload(payload: Record<string, unknown>, taskId: string, code: string) {
  const scheduledDate = requireSyncString(payload, "scheduledDate", code, "Task schedule create requires scheduledDate.");
  const occurrenceDate = optionalRawString(payload, "occurrenceDate", code, "occurrenceDate must be a string when provided.") ?? scheduledDate;
  const startTime = optionalRawString(payload, "startTime", code, "startTime must be a string when provided.");
  const endTime = optionalRawString(payload, "endTime", code, "endTime must be a string when provided.");
  const timezone = optionalRawString(payload, "timezone", code, "timezone must be a string when provided.");
  return { taskId, scheduledDate, occurrenceDate, opts: { startTime, endTime, timezone } };
}

function scheduleItemPatchPayload(payload: Record<string, unknown>): {
  scheduledDate?: string;
  occurrenceDate?: string;
  startTime?: string | null;
  endTime?: string | null;
  timezone?: string | null;
} {
  const code = "SYNC_TASK_SCHEDULE_ITEM_PAYLOAD_INVALID";
  const patch: {
    scheduledDate?: string;
    occurrenceDate?: string;
    startTime?: string | null;
    endTime?: string | null;
    timezone?: string | null;
  } = {};
  const scheduledDate = optionalSyncString(payload, "scheduledDate", code, "scheduledDate must be a non-empty string when provided.");
  const occurrenceDate = optionalRawString(payload, "occurrenceDate", code, "occurrenceDate must be a string when provided.");
  const startTime = optionalNullableRawString(payload, "startTime", code, "startTime must be a string, null, or omitted.");
  const endTime = optionalNullableRawString(payload, "endTime", code, "endTime must be a string, null, or omitted.");
  const timezone = optionalNullableRawString(payload, "timezone", code, "timezone must be a string, null, or omitted.");

  if (scheduledDate !== undefined) patch.scheduledDate = scheduledDate;
  if (occurrenceDate !== undefined) patch.occurrenceDate = occurrenceDate;
  if (startTime !== undefined) patch.startTime = startTime;
  if (endTime !== undefined) patch.endTime = endTime;
  if (timezone !== undefined) patch.timezone = timezone;
  if (Object.keys(patch).length === 0) {
    throw new LocalClientStoreError(400, code, "Task schedule item update requires at least one patch field.");
  }
  return patch;
}

function subtaskUpdatePayload(payload: Record<string, unknown>): { title?: string; isDone?: boolean; sortOrder?: number } {
  const code = "SYNC_TASK_SUBTASK_PAYLOAD_INVALID";
  const updates: { title?: string; isDone?: boolean; sortOrder?: number } = {};
  const title = optionalSyncString(payload, "title", code, "Subtask title must be a non-empty string when provided.");
  const isDone = payload.isDone;
  const sortOrder = optionalNonNegativeSyncInteger(payload, "sortOrder", code, "Subtask sortOrder must be a non-negative integer when provided.");

  if (title !== undefined) updates.title = title;
  if (isDone !== undefined) {
    if (typeof isDone !== "boolean") {
      throw new LocalClientStoreError(400, code, "Subtask isDone must be a boolean when provided.");
    }
    updates.isDone = isDone;
  }
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (Object.keys(updates).length === 0) {
    throw new LocalClientStoreError(400, code, "Subtask update requires title, isDone, or sortOrder.");
  }
  return updates;
}

type SyncPushApplied = {
  index: number;
  clientOpId?: string;
  domain: SyncDomain;
  action: SyncAction;
  resourceId: string;
  version: number;
  cursor: string;
  deduplicated?: true;
  result?: unknown;
};

type SyncPushRejected = {
  index: number;
  clientOpId?: string;
  op: Record<string, unknown>;
  code: string;
  message: string;
};

async function recordSyncPushProjectContextInvalidations(
  authContext: SyncAccessContext,
  primaryProjectId: string,
  additionalProjectIds: Array<string | undefined>,
  changed: ProjectContextChanged,
  entityId: string,
  clientOpId: string | undefined
) {
  const projectIds = [
    primaryProjectId,
    ...additionalProjectIds.filter((projectId): projectId is string => Boolean(projectId?.trim()))
  ].filter((projectId, index, values) => values.indexOf(projectId) === index);
  const event = await recordProjectContextInvalidation(authContext.userId, {
    projectId: primaryProjectId,
    changed: [changed],
    entityType: changed,
    entityId,
    source: "sync-push",
    extraPayload: {
      ...(clientOpId ? { clientOpId } : {}),
      ...(authContext.localClient?.id ? { localClientId: authContext.localClient.id } : {})
    }
  });

  for (const projectId of projectIds.slice(1)) {
    await recordProjectContextInvalidation(authContext.userId, {
      projectId,
      changed: [changed],
      entityType: changed,
      entityId,
      source: "sync-push",
      extraPayload: authContext.localClient?.id ? { localClientId: authContext.localClient.id } : undefined
    });
  }

  return event;
}

function requireProjectContextPatch(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload.patch || typeof payload.patch !== "object" || Array.isArray(payload.patch)) {
    throw new LocalClientStoreError(
      400,
      "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
      "Project context update requires payload.patch to be an object."
    );
  }
  return payload.patch as Record<string, unknown>;
}

function syncPushRejectionDetails(error: unknown): { code: string; message: string } {
  if (error instanceof LocalClientStoreError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof InternalServiceError && error.status >= 400 && error.status < 500) {
    try {
      const body = asJsonRecord(JSON.parse(error.body));
      return {
        code: asNonEmptyString(body.code) ?? "SYNC_PUSH_OPERATION_FAILED",
        message: asNonEmptyString(body.message) ?? error.message
      };
    } catch {
      return { code: "SYNC_PUSH_OPERATION_FAILED", message: error.body || error.message };
    }
  }
  return {
    code: "SYNC_PUSH_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "Sync push operation failed"
  };
}

async function assertSyncBaseVersion(
  authContext: SyncAccessContext,
  domain: SyncDomain,
  resourceId: string | undefined,
  op: Record<string, unknown>
): Promise<void> {
  const baseVersion = optionalNonNegativeInteger(op.baseVersion, "baseVersion");
  if (baseVersion === undefined) return;

  if (!resourceId) {
    if (baseVersion === 0) return;
    throw new LocalClientStoreError(409, "SYNC_VERSION_CONFLICT", "baseVersion does not match an existing resource.");
  }

  const current = await getSyncResourceVersion(authContext.userId, domain, resourceId);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== baseVersion) {
    throw new LocalClientStoreError(
      409,
      "SYNC_VERSION_CONFLICT",
      `Sync resource version conflict: expected ${baseVersion}, current ${currentVersion}.`
    );
  }
}

async function applyTaskOccurrenceSyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  if (action !== "update" && action !== "upsert") {
    throw new LocalClientStoreError(400, "SYNC_TASK_OCCURRENCE_ACTION_NOT_SUPPORTED", "Task occurrence sync push requires update or upsert action.");
  }

  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task occurrence sync push requires task resourceId or payload.taskId.");
  const operation = asNonEmptyString(payload.operation) ?? asNonEmptyString(payload.kind);
  const normalizedOperation = operation === "skip-exception" ? "skipException" : operation;
  const inferredOperation = normalizedOperation
    ?? (asNonEmptyString(payload.sourceDate) ? "move" : asNonEmptyString(payload.status) ? "complete" : undefined);

  if (inferredOperation === "complete") {
    const targetDate = requireSyncString(payload, "targetDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence complete requires targetDate.");
    const status = requireSyncString(payload, "status", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence complete requires status.");
    return {
      result: await tasksClient.completeOccurrence(authContext.accessToken, taskId, targetDate, status),
      nextResourceId: taskId
    };
  }

  if (inferredOperation === "move") {
    const sourceDate = requireSyncString(payload, "sourceDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence move requires sourceDate.");
    const targetDate = requireSyncString(payload, "targetDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence move requires targetDate.");
    return {
      result: await tasksClient.moveOccurrence(authContext.accessToken, taskId, sourceDate, targetDate),
      nextResourceId: taskId
    };
  }

  if (inferredOperation === "skipException") {
    const targetDate = requireSyncString(payload, "targetDate", "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Occurrence skipException requires targetDate.");
    return {
      result: await tasksClient.skipOccurrenceException(authContext.accessToken, taskId, targetDate),
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_OCCURRENCE_PAYLOAD_INVALID", "Task occurrence sync push requires operation complete, move, or skipException.");
}

async function applyTaskSubtaskSyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task subtask sync push requires task resourceId or payload.taskId.");
  const occurrenceDate = requireSyncString(payload, "occurrenceDate", "SYNC_TASK_SUBTASK_PAYLOAD_INVALID", "Task subtask sync push requires occurrenceDate.");
  const subtaskId = asNonEmptyString(payload.subtaskId) ?? asNonEmptyString(payload.id);

  if (action === "create" || (action === "upsert" && !subtaskId)) {
    const title = requireSyncString(payload, "title", "SYNC_TASK_SUBTASK_PAYLOAD_INVALID", "Subtask create requires title.");
    return {
      result: await tasksClient.createSubtask(authContext.accessToken, taskId, occurrenceDate, title),
      nextResourceId: taskId
    };
  }

  if (action === "update" || action === "upsert") {
    if (!subtaskId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SUBTASK_ID_REQUIRED", "Subtask update requires subtaskId.");
    }
    return {
      result: await tasksClient.updateSubtask(authContext.accessToken, taskId, occurrenceDate, subtaskId, subtaskUpdatePayload(payload)),
      nextResourceId: taskId
    };
  }

  if (action === "delete") {
    if (!subtaskId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SUBTASK_ID_REQUIRED", "Subtask delete requires subtaskId.");
    }
    await tasksClient.deleteSubtask(authContext.accessToken, taskId, occurrenceDate, subtaskId);
    return {
      result: { id: subtaskId, taskId, occurrenceDate, deleted: true },
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_SUBTASK_ACTION_NOT_SUPPORTED", "Unsupported task subtask sync push action.");
}

async function applyTaskTodaySyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task today sync push requires task resourceId or payload.taskId.");

  if (action === "create" || action === "upsert") {
    const schedule = scheduleCreatePayload(payload, taskId, "SYNC_TASK_TODAY_PAYLOAD_INVALID");
    return {
      result: await tasksClient.addToday(authContext.accessToken, schedule.taskId, schedule.scheduledDate, schedule.occurrenceDate, schedule.opts),
      nextResourceId: taskId
    };
  }

  if (action === "delete") {
    const scheduledDate = requireSyncString(payload, "scheduledDate", "SYNC_TASK_TODAY_PAYLOAD_INVALID", "Task today delete requires scheduledDate.");
    const occurrenceDate = optionalRawString(payload, "occurrenceDate", "SYNC_TASK_TODAY_PAYLOAD_INVALID", "occurrenceDate must be a string when provided.");
    return {
      result: await tasksClient.removeFromToday(authContext.accessToken, taskId, scheduledDate, occurrenceDate),
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_TODAY_ACTION_NOT_SUPPORTED", "Task today sync push requires create, upsert, or delete action.");
}

async function applyTaskScheduleItemSyncPush(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  payload: Record<string, unknown>,
  action: SyncAction
): Promise<{ result: unknown; nextResourceId: string }> {
  const taskId = requireTaskRelationTaskId(op, payload, "SYNC_RESOURCE_ID_REQUIRED", "Task scheduleItem sync push requires task resourceId or payload.taskId.");
  const scheduleId = optionalScheduleItemId(payload);

  if (action === "create" || (action === "upsert" && !scheduleId)) {
    const schedule = scheduleCreatePayload(payload, taskId, "SYNC_TASK_SCHEDULE_ITEM_PAYLOAD_INVALID");
    return {
      result: await tasksClient.addToday(authContext.accessToken, schedule.taskId, schedule.scheduledDate, schedule.occurrenceDate, schedule.opts),
      nextResourceId: taskId
    };
  }

  if (action === "update" || action === "upsert") {
    if (!scheduleId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SCHEDULE_ITEM_ID_REQUIRED", "Task schedule item update requires scheduleId.");
    }
    return {
      result: await tasksClient.updateScheduleItem(authContext.accessToken, scheduleId, scheduleItemPatchPayload(payload)),
      nextResourceId: taskId
    };
  }

  if (action === "delete") {
    if (!scheduleId) {
      throw new LocalClientStoreError(400, "SYNC_TASK_SCHEDULE_ITEM_ID_REQUIRED", "Task schedule item delete requires scheduleId.");
    }
    await tasksClient.deleteScheduleItem(authContext.accessToken, scheduleId);
    return {
      result: { id: scheduleId, taskId, deleted: true },
      nextResourceId: taskId
    };
  }

  throw new LocalClientStoreError(400, "SYNC_TASK_SCHEDULE_ITEM_ACTION_NOT_SUPPORTED", "Unsupported task schedule item sync push action.");
}

async function applySyncPushOperation(
  authContext: SyncAccessContext,
  op: Record<string, unknown>,
  index: number
): Promise<SyncPushApplied> {
  const clientOpId = asNonEmptyString(op.clientOpId);
  const domain = asNonEmptyString(op.domain) as SyncDomain | undefined;
  const action = asNonEmptyString(op.action) as SyncAction | undefined;
  const payload = asJsonRecord(op.payload);
  const resourceId = asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.id);

  if (!domain || !["projects", "notes", "artifacts", "tasks", "project_context"].includes(domain)) {
    throw new LocalClientStoreError(400, "SYNC_DOMAIN_NOT_SUPPORTED", "Only projects, notes, artifacts, tasks, and project_context sync push operations are supported in this phase.");
  }
  if (!action || !["create", "update", "delete", "upsert"].includes(action)) {
    throw new LocalClientStoreError(400, "SYNC_ACTION_NOT_SUPPORTED", "Unsupported sync push action.");
  }

  if (clientOpId) {
    const existing = await getAppliedClientOp(authContext.userId, clientOpId);
    if (existing) {
      return {
        index,
        clientOpId,
        domain: existing.domain,
        action: existing.action,
        resourceId: existing.resourceId,
        version: existing.version,
        cursor: existing.cursor,
        deduplicated: true
      };
    }
  }

  const relation = asNonEmptyString(op.relation) ?? asNonEmptyString(payload.relation);
  const versionResourceId = domain === "tasks" && relation
    ? taskRelationTaskId(op, payload) ?? (relation === "pin" ? resourceId : undefined)
    : domain === "projects" && relation === "default"
      ? asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.projectId) ?? asNonEmptyString(payload.id)
      : resourceId;
  await assertSyncBaseVersion(authContext, domain, versionResourceId, op);

  if (domain === "notes") {
    if (action !== "delete") {
      validateSyncNoteMutationPayload(payload);
    }
    let result: unknown;
    let nextResourceId = resourceId;
    if (action === "create") {
      result = await notesClient.create(authContext.accessToken, payload);
      nextResourceId = objectId(result);
    } else if (action === "update" || action === "upsert") {
      if (!resourceId) {
        result = await notesClient.create(authContext.accessToken, payload);
        nextResourceId = objectId(result);
      } else {
        result = await notesClient.update(authContext.accessToken, resourceId, payload);
        nextResourceId = objectId(result) ?? resourceId;
      }
    } else {
      if (!resourceId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
      }
      await notesClient.remove(authContext.accessToken, resourceId);
      nextResourceId = resourceId;
      result = { id: resourceId, deleted: true };
    }

    if (!nextResourceId) {
      throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
    }
    const event = await recordSyncEvent(authContext.userId, "notes", nextResourceId, action === "upsert" ? "update" : action, {
      source: "sync-push",
      clientOpId,
      localClientId: authContext.localClient?.id,
      ...(action !== "delete" ? { resource: result } : {}),
      ...(action === "delete" ? { deleted: true } : {})
    });
    return {
      index,
      clientOpId,
      domain: "notes",
      action: event.action,
      resourceId: nextResourceId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  if (domain === "projects") {
    let result: unknown;
    let nextResourceId = resourceId;
    if (relation === "default") {
      if (action !== "update" && action !== "upsert") {
        throw new LocalClientStoreError(400, "SYNC_PROJECT_DEFAULT_ACTION_NOT_SUPPORTED", "Project default sync push requires update or upsert action.");
      }
      const projectId = asNonEmptyString(payload.projectId) ?? asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.id);
      if (!projectId) {
        throw new LocalClientStoreError(400, "SYNC_PROJECT_DEFAULT_PAYLOAD_INVALID", "Project default sync push requires projectId.");
      }
      result = await projectsClient.setDefault(authContext.accessToken, { projectId });
      nextResourceId = projectId;
    } else if (relation) {
      throw new LocalClientStoreError(400, "SYNC_PROJECT_RELATION_NOT_SUPPORTED", "Only project default relation sync push is supported.");
    } else if (action === "create") {
      result = await projectsClient.create(authContext.accessToken, payload);
      nextResourceId = objectId(result);
    } else if (action === "update" || action === "upsert") {
      if (!resourceId) {
        result = await projectsClient.create(authContext.accessToken, payload);
        nextResourceId = objectId(result);
      } else {
        result = await projectsClient.update(authContext.accessToken, resourceId, payload);
        nextResourceId = objectId(result) ?? resourceId;
      }
    } else {
      if (!resourceId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
      }
      await deleteProjectWithGuard(authContext.accessToken, resourceId);
      nextResourceId = resourceId;
      result = { id: resourceId, deleted: true };
    }

    if (!nextResourceId) {
      throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
    }
    const event = await recordSyncEvent(authContext.userId, "projects", nextResourceId, action === "upsert" ? "update" : action, {
      source: "sync-push",
      clientOpId,
      localClientId: authContext.localClient?.id,
      relation,
      ...(action !== "delete" ? { resource: result } : {}),
      ...(action === "delete" ? { deleted: true } : {})
    });
    if (relation !== "default") {
      await recordProjectContextInvalidationsBestEffort(authContext.userId, [nextResourceId], {
        changed: ["project"],
        entityType: "project",
        entityId: nextResourceId,
        source: "sync-push",
        action: action === "delete" ? "delete" : "update"
      });
    }
    return {
      index,
      clientOpId,
      domain: "projects",
      action: event.action,
      resourceId: nextResourceId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  if (domain === "project_context") {
    if (!relation || !["brief", "memory", "relation"].includes(relation)) {
      throw new LocalClientStoreError(
        400,
        "SYNC_PROJECT_CONTEXT_RELATION_NOT_SUPPORTED",
        "Supported project context sync push relations are brief, memory, and relation."
      );
    }

    const projectId = asNonEmptyString(op.resourceId);
    if (!projectId) {
      throw new LocalClientStoreError(
        400,
        "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
        "Project context sync push requires resourceId to be the Project id."
      );
    }

    let result: unknown;
    let event;
    if (relation === "brief") {
      if (action !== "update" && action !== "upsert") {
        throw new LocalClientStoreError(
          400,
          "SYNC_PROJECT_CONTEXT_ACTION_NOT_SUPPORTED",
          "Project brief sync push requires update or upsert action."
        );
      }
      if (
        typeof payload.contentMarkdown !== "string"
        || typeof payload.expectedVersion !== "number"
        || !Number.isInteger(payload.expectedVersion)
        || payload.expectedVersion < 0
      ) {
        throw new LocalClientStoreError(
          400,
          "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
          "Project brief sync push requires contentMarkdown and a non-negative expectedVersion."
        );
      }
      result = await projectsClient.updateBrief(authContext.accessToken, projectId, {
        contentMarkdown: payload.contentMarkdown,
        expectedVersion: payload.expectedVersion,
        updatedByKind: "user"
      });
      event = await recordSyncPushProjectContextInvalidations(
        authContext,
        projectId,
        [],
        "brief",
        projectId,
        clientOpId
      );
    } else if (relation === "memory") {
      if (action === "delete") {
        throw new LocalClientStoreError(
          400,
          "SYNC_PROJECT_CONTEXT_ACTION_NOT_SUPPORTED",
          "Project memory delete is not supported; archive it with a memory update."
        );
      }
      if (action === "create") {
        if (!asNonEmptyString(payload.kind) || !asNonEmptyString(payload.bodyMarkdown)) {
          throw new LocalClientStoreError(
            400,
            "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
            "Project memory create requires kind and bodyMarkdown."
          );
        }
        const memoryPayload = withoutKeys(payload, ["relation"]);
        result = await projectsClient.appendMemory(authContext.accessToken, projectId, {
          ...memoryPayload,
          authority: asNonEmptyString(memoryPayload.authority) ?? "user_confirmed",
          createdByKind: "user"
        });
        event = await recordSyncPushProjectContextInvalidations(
          authContext,
          projectId,
          [],
          "memory",
          objectId(result) ?? projectId,
          clientOpId
        );
      } else if (action === "update") {
        const memoryId = asNonEmptyString(payload.memoryId);
        if (!memoryId) {
          throw new LocalClientStoreError(
            400,
            "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
            "Project memory update requires memoryId."
          );
        }
        result = await projectsClient.updateMemory(authContext.accessToken, memoryId, requireProjectContextPatch(payload));
        event = await recordSyncPushProjectContextInvalidations(
          authContext,
          projectId,
          [],
          "memory",
          memoryId,
          clientOpId
        );
      } else {
        throw new LocalClientStoreError(
          400,
          "SYNC_PROJECT_CONTEXT_ACTION_NOT_SUPPORTED",
          "Project memory sync push requires create or update action."
        );
      }
    } else {
      if (action === "create") {
        if (!asNonEmptyString(payload.targetProjectId) || !asNonEmptyString(payload.relationType)) {
          throw new LocalClientStoreError(
            400,
            "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
            "Project relation create requires targetProjectId and relationType."
          );
        }
        result = await projectsClient.createRelation(authContext.accessToken, projectId, {
          ...withoutKeys(payload, ["relation"]),
          createdByKind: "user"
        });
        const endpoints = requireProjectContextEndpoints(result);
        event = await recordSyncPushProjectContextInvalidations(
          authContext,
          projectId,
          [endpoints.sourceProjectId, endpoints.targetProjectId],
          "relation",
          endpoints.id,
          clientOpId
        );
      } else if (action === "update") {
        const relationId = asNonEmptyString(payload.relationId);
        if (!relationId) {
          throw new LocalClientStoreError(
            400,
            "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
            "Project relation update requires relationId."
          );
        }
        result = await projectsClient.updateRelation(authContext.accessToken, relationId, requireProjectContextPatch(payload));
        const endpoints = requireProjectContextEndpoints(result);
        event = await recordSyncPushProjectContextInvalidations(
          authContext,
          projectId,
          [endpoints.sourceProjectId, endpoints.targetProjectId],
          "relation",
          endpoints.id,
          clientOpId
        );
      } else if (action === "delete") {
        const relationId = asNonEmptyString(payload.relationId);
        if (!relationId) {
          throw new LocalClientStoreError(
            400,
            "SYNC_PROJECT_CONTEXT_PAYLOAD_INVALID",
            "Project relation delete requires relationId."
          );
        }
        const relationResult = await projectsClient.getRelation(authContext.accessToken, relationId);
        const endpoints = requireProjectContextEndpoints(relationResult);
        await projectsClient.removeRelation(authContext.accessToken, relationId);
        result = { id: relationId, deleted: true };
        event = await recordSyncPushProjectContextInvalidations(
          authContext,
          projectId,
          [endpoints.sourceProjectId, endpoints.targetProjectId],
          "relation",
          endpoints.id,
          clientOpId
        );
      } else {
        throw new LocalClientStoreError(
          400,
          "SYNC_PROJECT_CONTEXT_ACTION_NOT_SUPPORTED",
          "Project relation sync push requires create, update, or delete action."
        );
      }
    }

    return {
      index,
      clientOpId,
      domain: "project_context",
      action: event.action,
      resourceId: projectId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  if (domain === "tasks") {
    let result: unknown;
    let nextResourceId = resourceId;
    const eventAction: SyncAction = relation ? "update" : action === "upsert" ? "update" : action;

    if (relation === "pin") {
      if (action !== "update" && action !== "upsert") {
        throw new LocalClientStoreError(400, "SYNC_TASK_RELATION_ACTION_NOT_SUPPORTED", "Task pin sync push requires update or upsert action.");
      }
      const taskId = resourceId ?? asNonEmptyString(payload.taskId);
      if (!taskId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Task pin update requires resourceId.");
      }
      const pinned = asBoolean(payload.pinned);
      if (pinned === undefined) {
        throw new LocalClientStoreError(400, "SYNC_TASK_PIN_PAYLOAD_INVALID", "Task pin update requires pinned(boolean).");
      }
      result = await tasksClient.setPin(authContext.accessToken, taskId, pinned);
      nextResourceId = taskId;
    } else if (relation === "attachment") {
      const taskId = asNonEmptyString(op.resourceId) ?? asNonEmptyString(payload.taskId);
      if (!taskId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Task attachment sync push requires task resourceId.");
      }
      const attachmentId = asNonEmptyString(payload.attachmentId) ?? asNonEmptyString(payload.id);
      nextResourceId = taskId;

      if (action === "create" || (action === "upsert" && !attachmentId)) {
        const filename = asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename);
        const contentBase64 = asNonEmptyString(payload.contentBase64);
        if (!filename || !contentBase64) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_PAYLOAD_INVALID", "Task attachment create requires filename and contentBase64.");
        }
        const { compactBase64, buffer } = decodeContentBase64(contentBase64);
        const checksum = sha256Checksum(buffer);
        const expectedChecksum = asNonEmptyString(payload.checksum);
        if (expectedChecksum && expectedChecksum !== checksum) {
          throw new LocalClientStoreError(400, "SYNC_BLOB_CHECKSUM_MISMATCH", "Task attachment checksum mismatch.");
        }
        result = await tasksClient.uploadAttachment(authContext.accessToken, taskId, {
          filename,
          mimeType: asNonEmptyString(payload.mimeType),
          contentBase64: compactBase64
        });
      } else if (action === "update" || action === "upsert") {
        if (!attachmentId) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_ID_REQUIRED", "Task attachment update requires attachmentId.");
        }
        const contentBase64 = asNonEmptyString(payload.contentBase64);
        if (!contentBase64) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_PAYLOAD_INVALID", "Task attachment update requires contentBase64.");
        }
        const { compactBase64, buffer } = decodeContentBase64(contentBase64);
        const checksum = sha256Checksum(buffer);
        const expectedChecksum = asNonEmptyString(payload.checksum);
        if (expectedChecksum && expectedChecksum !== checksum) {
          throw new LocalClientStoreError(400, "SYNC_BLOB_CHECKSUM_MISMATCH", "Task attachment checksum mismatch.");
        }
        result = await tasksClient.replaceAttachment(authContext.accessToken, taskId, attachmentId, {
          filename: asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename),
          mimeType: asNonEmptyString(payload.mimeType),
          contentBase64: compactBase64
        });
      } else {
        if (!attachmentId) {
          throw new LocalClientStoreError(400, "SYNC_TASK_ATTACHMENT_ID_REQUIRED", "Task attachment delete requires attachmentId.");
        }
        await tasksClient.deleteAttachment(authContext.accessToken, taskId, attachmentId);
        result = { id: attachmentId, taskId, deleted: true };
      }
    } else if (relation === "occurrence") {
      ({ result, nextResourceId } = await applyTaskOccurrenceSyncPush(authContext, op, payload, action));
    } else if (relation === "subtask") {
      ({ result, nextResourceId } = await applyTaskSubtaskSyncPush(authContext, op, payload, action));
    } else if (relation === "today") {
      ({ result, nextResourceId } = await applyTaskTodaySyncPush(authContext, op, payload, action));
    } else if (relation === "scheduleItem") {
      ({ result, nextResourceId } = await applyTaskScheduleItemSyncPush(authContext, op, payload, action));
    } else if (relation) {
      throw new LocalClientStoreError(400, "SYNC_TASK_RELATION_NOT_SUPPORTED", "Supported task sync push relations are pin, attachment, occurrence, subtask, today, and scheduleItem.");
    } else if (action === "create") {
      result = await tasksClient.create(authContext.accessToken, payload);
      nextResourceId = objectId(result);
    } else if (action === "update" || action === "upsert") {
      if (!resourceId) {
        result = await tasksClient.create(authContext.accessToken, payload);
        nextResourceId = objectId(result);
      } else {
        result = await tasksClient.update(authContext.accessToken, resourceId, withoutKeys(payload, ["relation"]));
        nextResourceId = objectId(result) ?? resourceId;
      }
    } else {
      if (!resourceId) {
        throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
      }
      await tasksClient.remove(authContext.accessToken, resourceId);
      nextResourceId = resourceId;
      result = { id: resourceId, deleted: true };
    }

    if (!nextResourceId) {
      throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
    }
    const event = await recordSyncEvent(authContext.userId, "tasks", nextResourceId, eventAction, {
      ...syncEventPayloadMetadata(payload),
      source: "sync-push",
      clientOpId,
      localClientId: authContext.localClient?.id,
      relation,
      ...(action !== "delete" && !relation ? { resource: result } : {}),
      ...(action === "delete" ? { deleted: true } : {})
    });
    return {
      index,
      clientOpId,
      domain: "tasks",
      action: event.action,
      resourceId: nextResourceId,
      version: event.version,
      cursor: event.cursor,
      result
    };
  }

  let artifactBefore: unknown;
  let artifactDeletionSnapshot: Awaited<ReturnType<typeof removeArtifactItemWithProjectCleanup>> | undefined;
  let artifactProjectIds: string[] = [];
  if (resourceId) {
    try {
      artifactBefore = await artifactsClient.getItem(authContext.accessToken, resourceId);
      artifactProjectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, artifactBefore);
    } catch {
      artifactBefore = undefined;
    }
  }
  let result: unknown;
  let nextResourceId = resourceId;
  if (action === "create") {
    const kind = asNonEmptyString(payload.kind) ?? "note";
    if (kind === "folder") {
      result = await artifactsClient.createFolder(authContext.accessToken, withoutKeys(payload, ["kind"]));
    } else if (kind === "file") {
      const filename = asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename);
      const contentBase64 = asNonEmptyString(payload.contentBase64);
      if (!filename || !contentBase64) {
        throw new LocalClientStoreError(400, "SYNC_FILE_PAYLOAD_INVALID", "Artifact file create requires filename and contentBase64.");
      }
      result = await artifactsClient.uploadFile(authContext.accessToken, {
        projectId: asNonEmptyString(payload.projectId),
        projectName: asNonEmptyString(payload.projectName),
        directoryPath: asNonEmptyString(payload.directoryPath),
        scope: asNonEmptyString(payload.scope) as "private" | "org" | "project" | undefined,
        tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
        filename,
        mimeType: asNonEmptyString(payload.mimeType),
        contentBase64
      });
    } else {
      result = await artifactsClient.createNote(authContext.accessToken, withoutKeys(payload, ["kind"]));
    }
    nextResourceId = objectId(result);
  } else if (action === "update" || action === "upsert") {
    if (!resourceId) {
      result = await artifactsClient.createNote(authContext.accessToken, withoutKeys({ ...payload, kind: "note" }, ["kind"]));
      nextResourceId = objectId(result);
    } else if (typeof payload.contentBase64 === "string") {
      const { compactBase64, buffer } = decodeContentBase64(payload.contentBase64);
      const checksum = sha256Checksum(buffer);
      const expectedChecksum = asNonEmptyString(payload.checksum);
      if (expectedChecksum && expectedChecksum !== checksum) {
        throw new LocalClientStoreError(400, "SYNC_BLOB_CHECKSUM_MISMATCH", "Artifact file checksum mismatch.");
      }
      result = await artifactsClient.replaceFileContent(authContext.accessToken, resourceId, {
        filename: asNonEmptyString(payload.filename) ?? asNonEmptyString(payload.originalFilename),
        mimeType: asNonEmptyString(payload.mimeType),
        contentBase64: compactBase64,
        expectedVersion: optionalPositiveInteger(payload.expectedVersion, "expectedVersion")
      });
      nextResourceId = objectId(result) ?? resourceId;
    } else {
      result = await artifactsClient.updateItem(authContext.accessToken, resourceId, withoutKeys(payload, ["kind"]));
      nextResourceId = objectId(result) ?? resourceId;
    }
  } else {
    if (!resourceId) {
      throw new LocalClientStoreError(400, "SYNC_RESOURCE_ID_REQUIRED", "Delete requires resourceId.");
    }
    artifactDeletionSnapshot = await removeArtifactItemWithProjectCleanup(authContext.accessToken, resourceId);
    artifactProjectIds.push(...projectIdsFromArtifactDeletionSnapshot(artifactDeletionSnapshot));
    nextResourceId = resourceId;
    result = { id: resourceId, deleted: true };
  }

  if (action !== "delete" && artifactBefore) {
    await reconcileArtifactMutationBestEffort(authContext.accessToken, artifactBefore, result);
  } else if (action !== "delete") {
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
  }

  if (action !== "delete") {
    artifactProjectIds.push(...await listArtifactProjectIdsBestEffort(authContext.accessToken, result));
  }

  if (!nextResourceId) {
    throw new LocalClientStoreError(502, "SYNC_RESOURCE_ID_MISSING", "Applied operation did not return a resource id.");
  }
  const event = await recordSyncEvent(authContext.userId, "artifacts", nextResourceId, action === "upsert" ? "update" : action, {
    source: "sync-push",
    clientOpId,
    localClientId: authContext.localClient?.id,
    ...(action !== "delete" ? { resource: result } : {}),
    ...(action === "delete" ? { deleted: true } : {})
  }, artifactEventMetadata(
    action === "delete" ? artifactDeletionSnapshotRoot(artifactDeletionSnapshot) : artifactBefore,
    action === "delete" ? undefined : result
  ));
  await recordProjectContextInvalidationsBestEffort(authContext.userId, artifactProjectIds, {
    changed: ["index"],
    entityType: "index",
    entityId: nextResourceId,
    source: "sync-push"
  });
  return {
    index,
    clientOpId,
    domain: "artifacts",
    action: event.action,
    resourceId: nextResourceId,
    version: event.version,
    cursor: event.cursor,
    result
  };
}



export function registerSyncRoutes(app: express.Express): void {
async function projectContextBaselineCursor(req: express.Request, userId: string): Promise<string> {
  const supplied = parseProjectContextBaselineCursor(req.query.baselineCursor);
  return supplied ?? getLatestSyncCursor(userId);
}

app.get("/api/sync/project-context/:projectId", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.pull");
  if (!authContext) return;

  try {
    const baselineCursor = await projectContextBaselineCursor(req, authContext.userId);
    const fetchedAt = new Date().toISOString();
    const snapshot = await projectsClient.getSyncContext(
      authContext.accessToken,
      String(req.params.projectId)
    );
    return res.json(buildProjectContextSyncItem(snapshot, baselineCursor, fetchedAt));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/projects/:projectId/context-export", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.pull");
  if (!authContext) return;

  try {
    const projectId = String(req.params.projectId);
    const snapshot = await projectsClient.getContextExport(authContext.accessToken, projectId);
    return res.json(buildProjectContextExportResponse(snapshot, projectId));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/snapshot", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.pull");
  if (!authContext) return;

  const requestedDomains = typeof req.query.domains === "string"
    ? req.query.domains.split(",").map((value) => value.trim()).filter(Boolean)
    : ["projects", "notes", "artifacts", "tasks"];
  const domainSet = new Set(requestedDomains);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const snapshotLimit = Number.isFinite(limit) ? limit : undefined;

  try {
    const baselineCursor = await projectContextBaselineCursor(req, authContext.userId);
    const generatedAt = new Date().toISOString();
    const snapshot: Record<string, unknown> = {};
    if (domainSet.has("projects")) {
      snapshot.projects = await projectsClient.list(authContext.accessToken, undefined, undefined, snapshotLimit ?? 100, cursor);
    }
    if (domainSet.has("notes")) {
      snapshot.notes = await notesClient.listPage(authContext.accessToken, undefined, snapshotLimit ?? 100, cursor);
    }
    if (domainSet.has("artifacts")) {
      snapshot.artifacts = await artifactsClient.treeListPage(authContext.accessToken, {
        limit: snapshotLimit ?? 500,
        cursor
      });
    }
    if (domainSet.has("tasks")) {
      snapshot.tasks = await tasksClient.listPage(authContext.accessToken, undefined, undefined, snapshotLimit ?? 100, cursor);
    }
    if (domainSet.has("project_context")) {
      const contextPageLimit = Math.max(1, Math.min(100, Math.floor(snapshotLimit ?? 20)));
      const projectPage = await projectsClient.list(
        authContext.accessToken,
        undefined,
        undefined,
        contextPageLimit,
        cursor
      );
      const { items: projects, nextCursor } = projectContextSnapshotPage(projectPage);
      const items = await Promise.all(projects.map(async (project) => {
        const projectId = objectId(project);
        if (!projectId) {
          throw new ProjectContextSyncError(
            502,
            "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE",
            "Projects service returned a Project page item without an id."
          );
        }
        const context = await projectsClient.getSyncContext(authContext.accessToken, projectId);
        return buildProjectContextSyncItem(context, baselineCursor, generatedAt);
      }));
      snapshot.project_context = { items, nextCursor };
    }
    return res.json({
      generatedAt,
      baselineCursor,
      supportedDomains: SYNC_SUPPORTED_DOMAINS,
      domains: snapshot
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/events", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  let unsubscribe: () => void = () => undefined;
  const pingTimer = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 25_000);
  const cleanup = () => {
    clearInterval(pingTimer);
    unsubscribe();
  };

  unsubscribe = syncEventBroadcaster.subscribe(
    authContext.userId,
    (event) => {
      if (!res.writableEnded) {
        res.write(`event: sync\ndata: ${JSON.stringify(event)}\n\n`);
      }
    },
    () => {
      if (!res.writableEnded) res.end();
    }
  );
  res.once("close", cleanup);
});

app.get("/api/sync/changes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const domains = typeof req.query.domains === "string"
    ? req.query.domains
    : Array.isArray(req.query.domains)
      ? req.query.domains.filter((value): value is string => typeof value === "string")
      : undefined;

  const queryList = (value: unknown): string[] | undefined => {
    if (typeof value === "string") {
      const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      return entries.length > 0 ? entries : undefined;
    }
    if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string");
      return entries.length > 0 ? entries : undefined;
    }
    return undefined;
  };
  const queryBoolean = (value: unknown): boolean | undefined =>
    value === "true" ? true : value === "false" ? false : undefined;

  try {
    const result = await pullSyncChanges(authContext.userId, {
      consumer: typeof req.query.consumer === "string" ? req.query.consumer : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      domains,
      limit: typeof req.query.limit === "string" ? req.query.limit : undefined,
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      pathPrefix: typeof req.query.pathPrefix === "string" ? req.query.pathPrefix : undefined,
      resourceTypes: queryList(req.query.resourceTypes),
      actions: queryList(req.query.actions),
      includeContent: queryBoolean(req.query.includeContent),
      includePatch: queryBoolean(req.query.includePatch)
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/sync/changes/consumers/initialize", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const body = asJsonRecord(req.body);
  try {
    const result = await initializeSyncChangesConsumer(authContext.userId, {
      consumer: body.consumer,
      startAt: body.startAt,
      scope: body.scope
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/sync/changes/commit", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const body = asJsonRecord(req.body);
  try {
    const committed = await commitSyncChangesCursor(authContext.userId, {
      consumer: body.consumer,
      cursor: body.cursor
    });
    return res.json({
      consumer: committed.consumerId,
      cursor: committed.cursor,
      updatedAt: committed.updatedAt
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/pull", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.pull");
  if (!authContext) return;

  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;

  try {
    const result = await listSyncEvents(authContext.userId, cursor, Number.isFinite(limit) ? limit : 100);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/sync/blobs/:blobId", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.blobs.read");
  if (!authContext) return;

  const blobId = String(req.params.blobId);
  let targetUrl: string | undefined;
  if (blobId.startsWith("artifact:")) {
    const id = blobId.slice("artifact:".length);
    targetUrl = `${serviceBaseUrls.artifacts}/artifacts/items/${encodeURIComponent(id)}/download?download=1`;
  } else if (blobId.startsWith("task-attachment:")) {
    const [, taskId, attachmentId] = blobId.split(":");
    if (taskId && attachmentId) {
      targetUrl = `${serviceBaseUrls.tasks}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download?download=1`;
    }
  }

  if (!targetUrl) {
    return res.status(404).json({ message: "Unsupported sync blob id" });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`
      }
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);
    if (upstream.ok) res.setHeader("X-Workbench-Content-Checksum", sha256Checksum(buffer));
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/sync/blobs/:blobId", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.blobs.write");
  if (!authContext) return;

  const parsed = syncBlobPutSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const blobId = String(req.params.blobId);
  try {
    if (blobId.startsWith("task-attachment:")) {
      const [, taskId, attachmentId] = blobId.split(":");
      if (!taskId || !attachmentId) {
        return res.status(400).json({ message: "Task attachment blob id must be task-attachment:<taskId>:<attachmentId>" });
      }
      await assertSyncBaseVersion(authContext, "tasks", taskId, { baseVersion: parsed.data.baseVersion });
      const { compactBase64, buffer } = decodeContentBase64(parsed.data.contentBase64);
      const checksum = sha256Checksum(buffer);
      if (parsed.data.checksum && parsed.data.checksum !== checksum) {
        return res.status(400).json({
          message: "Blob checksum mismatch",
          code: "SYNC_BLOB_CHECKSUM_MISMATCH",
          expected: parsed.data.checksum,
          actual: checksum
        });
      }

      const result = await tasksClient.replaceAttachment(authContext.accessToken, taskId, attachmentId, {
        filename: parsed.data.filename,
        mimeType: parsed.data.mimeType,
        contentBase64: compactBase64
      });
      const event = await recordSyncEvent(authContext.userId, "tasks", taskId, "update", {
        source: "sync-blob-put",
        blobId,
        localClientId: authContext.localClient?.id,
        relation: "attachment",
        attachmentId,
        checksum,
        sizeBytes: buffer.length
      });

      return res.json({
        blobId,
        domain: "tasks",
        resourceId: taskId,
        attachmentId,
        sizeBytes: buffer.length,
        checksum,
        version: event.version,
        cursor: event.cursor,
        result
      });
    }

    if (!blobId.startsWith("artifact:")) {
      return res.status(404).json({ message: "Unsupported sync blob id" });
    }

    const resourceId = blobId.slice("artifact:".length).trim();
    if (!resourceId) {
      return res.status(400).json({ message: "Artifact blob id is missing a resource id" });
    }

    await assertSyncBaseVersion(authContext, "artifacts", resourceId, { baseVersion: parsed.data.baseVersion });
    const { compactBase64, buffer } = decodeContentBase64(parsed.data.contentBase64);
    const checksum = sha256Checksum(buffer);
    if (parsed.data.checksum && parsed.data.checksum !== checksum) {
      return res.status(400).json({
        message: "Blob checksum mismatch",
        code: "SYNC_BLOB_CHECKSUM_MISMATCH",
        expected: parsed.data.checksum,
        actual: checksum
      });
    }

    const result = await artifactsClient.replaceFileContent(authContext.accessToken, resourceId, {
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      contentBase64: compactBase64,
      expectedVersion: parsed.data.expectedVersion
    });
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    const event = await recordSyncEvent(authContext.userId, "artifacts", resourceId, "update", {
      source: "sync-blob-put",
      blobId,
      localClientId: authContext.localClient?.id,
      checksum,
      sizeBytes: buffer.length
    }, artifactEventMetadata(undefined, result));
    await recordProjectContextInvalidationsBestEffort(authContext.userId, projectIds, {
      changed: ["index"],
      entityType: "index",
      entityId: resourceId,
      source: "sync-push"
    });

    return res.json({
      blobId,
      domain: "artifacts",
      resourceId,
      sizeBytes: buffer.length,
      checksum,
      version: event.version,
      cursor: event.cursor,
      result
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/sync/push", async (req, res) => {
  const authContext = await requireSyncAccessContext(req, res, "sync.push");
  if (!authContext) return;

  const parsed = syncPushSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const applied: SyncPushApplied[] = [];
  const rejected: SyncPushRejected[] = [];
  for (const [index, op] of parsed.data.ops.entries()) {
    const clientOpId = asNonEmptyString(op.clientOpId);
    try {
      applied.push(await applySyncPushOperation(authContext, op, index));
    } catch (error) {
      const { code, message } = syncPushRejectionDetails(error);
      rejected.push({
        index,
        clientOpId,
        op,
        code,
        message
      });
    }
  }

  return res.status(rejected.length > 0 && applied.length === 0 ? 409 : 202).json({
    applied,
    rejected,
    serverCursor: applied.length > 0 ? await getLatestSyncCursor(authContext.userId) : undefined
  });
});

}
