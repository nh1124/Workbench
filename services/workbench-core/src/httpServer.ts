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
import { issueTokenBundle, verifyAccessToken, verifyRefreshToken } from "./auth.js";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "./refreshCookie.js";
import { logger } from "./logger.js";
import { ensureCoreSchema } from "./db.js";
import { getIntegrationManifests } from "./integrations/index.js";
import { registerArtifactsTools } from "./mcp/registerArtifactsTools.js";
import { registerDeepResearchTools } from "./mcp/registerDeepResearchTools.js";
import { registerImageTools } from "./mcp/registerImageTools.js";
import { registerAnalyserTools } from "./mcp/registerAnalyserTools.js";
import { registerMindmapTools } from "./mcp/registerMindmapTools.js";
import { registerNotesTools } from "./mcp/registerNotesTools.js";
import { registerProjectsTools } from "./mcp/registerProjectsTools.js";
import { registerProjectContextTools } from "./mcp/registerProjectContextTools.js";
import { registerTasksTools } from "./mcp/registerTasksTools.js";
import { registerWbsTools } from "./mcp/registerWbsTools.js";
import { ensureIntegrationLinked } from "./integrationLinking.js";
import { artifactsClient, InternalServiceError, notesClient, projectsClient, serviceBaseUrls, tasksClient } from "./internalClients.js";
import { startAnalyserProjector } from "./analyserProjector.js";
import { analyserHttpAccessMiddleware, instrumentMcpServer } from "./analyserAccessInstrumentation.js";
import { saveOAuthDynamicClient } from "./oauthDynamicClientsStore.js";
import {
  accountSchema,
  integrationConfigSchema,
  refreshSchema,
  syncBlobPutSchema,
  syncPushSchema,
  taskImportBodySchema
} from "./schemas/requests.js";
import {
  commitSyncChangesCursor,
  initializeSyncChangesConsumer,
  pullSyncChanges
} from "./syncChanges.js";
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
} from "./projectContext.js";
import { artifactDeletionSnapshotRoot, artifactEventMetadata } from "./syncEventMetadata.js";
import {
  LocalClientStoreError
} from "./localClientsStore.js";
import {
  getAppliedClientOp,
  getLatestSyncCursor,
  getSyncResourceVersion,
  listSyncEvents,
  recordSyncEvent,
  type SyncAction,
  type SyncDomain
} from "./syncStore.js";
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
} from "./projectContextSync.js";
import { buildProjectContextExportResponse } from "./projectContextExport.js";
import {
  configuredServiceIds,
  provisionAccountToServices
} from "./serviceProvisioning.js";
import {
  findUserById,
  listIntegrationConfigs,
  listProvisionings,
  loginUser,
  registerUser,
  saveIntegrationConfig
} from "./store.js";
import {
  readAuthorizeParams,
  renderAuthorizeLoginForm,
  type AuthorizeRequestParams
} from "./oauth/authorizeRequest.js";
import {
  parseDynamicClientRegistrationPayload,
  resolveOAuthClient,
  type DynamicClientRegistrationPayload
} from "./oauth/clients.js";
import {
  buildCanonicalMcpResource,
  buildOAuthIssuer,
  canonicalBaseConfig,
  DYNAMIC_CLIENT_REGISTRATION_PATH,
  joinIssuerPath,
  oauthJwtExpirySeconds,
  supportedMcpScopes
} from "./oauth/config.js";
import {
  readBearerToken,
  requireAuthenticatedContext,
  requireSyncAccessContext,
  type SyncAccessContext
} from "./middleware/auth.js";
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
} from "./oauth/tokens.js";
import { registerAnalyserRoutes } from "./routes/analyser.js";
import { registerDeepResearchRoutes } from "./routes/deep-research.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerMindmapRoutes } from "./routes/mindmaps.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerLocalClientRoutes } from "./routes/local-clients.js";
import { registerLocalJobRoutes } from "./routes/local-jobs.js";
import {
  asJsonRecord,
  asNonEmptyString,
  CLIENT_OP_ID_HEADER,
  invalidateArtifactIndexFromApi,
  invalidateProjectContextFromApi,
  objectId,
  recordSyncEventBestEffort,
  respondInternalError,
  sha256Checksum,
  syncEventBroadcaster,
  syncRequestContext
} from "./routes/shared.js";
import { registerWbsRoutes } from "./routes/wbs.js";

export {
  forwardAnalyserRequest,
  pickAnalyserQuery,
  requireAnalyserConfigured
} from "./routes/analyser.js";
export {
  respondInternalError,
  syncEventBroadcaster,
  type LiveSyncEvent
} from "./routes/shared.js";

export { redirectUriMatches } from "./oauth/clients.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, _res, next) => {
  const clientOpId = asNonEmptyString(req.header(CLIENT_OP_ID_HEADER));
  syncRequestContext.run({ clientOpId }, next);
});
app.use(requestLogger(logger));
app.use(analyserHttpAccessMiddleware());

function jsonRecordFromBuffer(buffer: Buffer): Record<string, unknown> {
  try {
    return asJsonRecord(JSON.parse(buffer.toString("utf8")));
  } catch {
    return {};
  }
}

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



app.get("/health", (_req, res) => {
  res.json({
    service: "workbench-core",
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

function logAuthorizeRequest(params: AuthorizeRequestParams): void {
  logger.debug("[oauth] authorize request", {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    resource: params.resource,
    scope: params.scope
  });
}

function logTokenFailure(
  reason:
    | "invalid_client"
    | "invalid_redirect_uri"
    | "invalid_resource"
    | "invalid_code"
    | "invalid_code_verifier"
    | "invalid_refresh_token"
    | "unsupported_grant_type",
  details: Record<string, string | number | boolean | undefined> = {}
): void {
  logger.warn("[oauth] token exchange failure", { reason, ...details });
}

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const issuer = buildOAuthIssuer(req);
  return res.json({
    resource: buildCanonicalMcpResource(req),
    authorization_servers: [issuer],
    scopes_supported: [...supportedMcpScopes],
    bearer_methods_supported: ["header"]
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const issuer = buildOAuthIssuer(req);
  logger.debug("[oauth] authorization server metadata requested", {
    user_agent: req.header("user-agent") || "(missing)",
    issuer
  });
  return res.json({
    issuer,
    authorization_endpoint: joinIssuerPath(issuer, "/authorize"),
    token_endpoint: joinIssuerPath(issuer, "/oauth/token"),
    registration_endpoint: joinIssuerPath(issuer, DYNAMIC_CLIENT_REGISTRATION_PATH),
    // response_types_supported is REQUIRED by RFC 8414 §2 and the MCP TS SDK's
    // OAuthMetadata schema validates it as an array. Omitting it made strict
    // clients (Claude Code) reject the metadata while lenient ones (Codex,
    // cowork) still connected. The authorization-code flow supports "code".
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...supportedMcpScopes],
    client_id_metadata_document_supported: true
  });
});

app.post(DYNAMIC_CLIENT_REGISTRATION_PATH, async (req, res) => {
  const payload = req.body as DynamicClientRegistrationPayload | undefined;
  const redirectUrisCount = Array.isArray(payload?.redirect_uris)
    ? payload.redirect_uris.filter((value): value is string => typeof value === "string").length
    : 0;
  logger.debug("[oauth] dynamic client registration request received", {
    user_agent: req.header("user-agent") || "(missing)",
    content_type: req.header("content-type") || "(missing)",
    has_client_name: typeof payload?.client_name === "string" && payload.client_name.trim().length > 0,
    redirect_uris_count: redirectUrisCount,
    token_endpoint_auth_method:
      typeof payload?.token_endpoint_auth_method === "string" ? payload.token_endpoint_auth_method : "(default:none)",
    has_grant_types: Array.isArray(payload?.grant_types),
    has_response_types: Array.isArray(payload?.response_types)
  });

  const parsed = parseDynamicClientRegistrationPayload(req.body);
  if (!parsed.ok) {
    logger.warn("[oauth] dynamic client registration rejected", {
      reason: parsed.reason,
      error: parsed.error,
      ...parsed.details
    });
    return res.status(400).json({
      error: parsed.error
    });
  }

  try {
    const clientId = `workbench_dcr_${randomBytes(16).toString("hex")}`;
    const registeredClient = await saveOAuthDynamicClient({
      clientId,
      clientName: parsed.clientName,
      redirectUris: parsed.redirectUris,
      tokenEndpointAuthMethod: parsed.tokenEndpointAuthMethod,
      grantTypes: parsed.grantTypes,
      responseTypes: parsed.responseTypes
    });
    logger.debug("[oauth] dynamic client registration succeeded", {
      client_id: registeredClient.clientId,
      client_name: registeredClient.clientName,
      redirect_uris_count: registeredClient.redirectUris.length
    });

    return res.status(201).json({
      client_id: registeredClient.clientId,
      client_id_issued_at: Math.floor(registeredClient.createdAtMs / 1000),
      client_name: registeredClient.clientName,
      redirect_uris: registeredClient.redirectUris,
      token_endpoint_auth_method: registeredClient.tokenEndpointAuthMethod,
      grant_types: registeredClient.grantTypes,
      response_types: registeredClient.responseTypes
    });
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/authorize", async (req, res) => {
  const parsed = readAuthorizeParams(req.query as Record<string, unknown>);
  if ("error" in parsed) {
    return res.status(400).json({ error: parsed.error });
  }
  logAuthorizeRequest(parsed);

  const canonicalResource = buildCanonicalMcpResource(req);
  if (parsed.resource !== canonicalResource) {
    return res.status(400).json({ error: "invalid_target" });
  }

  const resolvedClient = await resolveOAuthClient(parsed.clientId, parsed.redirectUri);
  if (!resolvedClient.ok) {
    return res.status(400).json({ error: resolvedClient.error });
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(renderAuthorizeLoginForm(parsed));
});

app.post("/authorize", express.urlencoded({ extended: false }), async (req, res) => {
  const parsed = readAuthorizeParams(req.body as Record<string, unknown>);
  if ("error" in parsed) {
    return res.status(400).json({ error: parsed.error });
  }
  logAuthorizeRequest(parsed);

  const canonicalResource = buildCanonicalMcpResource(req);
  if (parsed.resource !== canonicalResource) {
    return res.status(400).json({ error: "invalid_target" });
  }

  const resolvedClient = await resolveOAuthClient(parsed.clientId, parsed.redirectUri);
  if (!resolvedClient.ok) {
    return res.status(400).json({ error: resolvedClient.error });
  }

  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(renderAuthorizeLoginForm(parsed, "Username and password are required."));
  }

  const user = await loginUser(username, password);
  if (!user) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(401).send(renderAuthorizeLoginForm(parsed, "Invalid username or password."));
  }

  cleanupExpiredAuthorizationCodes();
  const code = randomBytes(32).toString("hex");
  authorizationCodeStore.set(code, {
    clientId: parsed.clientId,
    redirectUri: parsed.redirectUri,
    scope: parsed.scope,
    allowRefreshTokenGrant: resolvedClient.client.grantTypes.includes("refresh_token"),
    codeChallenge: parsed.codeChallenge,
    codeChallengeMethod: parsed.codeChallengeMethod,
    resource: parsed.resource,
    userId: user.id,
    username: user.username,
    expiresAtMs: Date.now() + AUTHORIZATION_CODE_TTL_MS
  });

  const redirectUrl = new URL(parsed.redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (parsed.state) {
    redirectUrl.searchParams.set("state", parsed.state);
  }

  return res.redirect(302, redirectUrl.toString());
});

app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
  const grantType = typeof req.body?.grant_type === "string" ? req.body.grant_type.trim() : "";
  logger.debug("[oauth] token request received", {
    grant_type: grantType || "(missing)",
    client_id: typeof req.body?.client_id === "string" ? req.body.client_id : "(missing)",
    redirect_uri: typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri : "(missing)",
    resource: typeof req.body?.resource === "string" ? req.body.resource : "(missing)",
    scope: typeof req.body?.scope === "string" ? req.body.scope : "(missing)",
    has_code: typeof req.body?.code === "string" && req.body.code.length > 0,
    has_code_verifier: typeof req.body?.code_verifier === "string" && req.body.code_verifier.length > 0,
    has_refresh_token: typeof req.body?.refresh_token === "string" && req.body.refresh_token.length > 0
  });

  if (grantType === "authorization_code") {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.trim() : "";
    if (!clientId) {
      logTokenFailure("invalid_client", { grant_type: "authorization_code" });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const codeVerifier = typeof req.body?.code_verifier === "string" ? req.body.code_verifier : "";
    const redirectUri = typeof req.body?.redirect_uri === "string" ? req.body.redirect_uri.trim() : "";
    const tokenRequestResource = typeof req.body?.resource === "string" ? req.body.resource.trim() : "";
    const tokenRequestResourcePresent = tokenRequestResource.length > 0;
    if (!code || !codeVerifier || !redirectUri) {
      return res.status(400).json({
        error: "invalid_request"
      });
    }

    cleanupExpiredAuthorizationCodes();
    const record = authorizationCodeStore.get(code);
    if (!record) {
      logTokenFailure("invalid_code", { grant_type: "authorization_code", client_id: clientId });
      logger.warn("[oauth] auth code not found or expired", { client_id: clientId, store_size: authorizationCodeStore.size });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    logger.debug("[oauth] auth code record found", {
      record_client_id: record.clientId,
      request_client_id: clientId,
      record_redirect_uri: record.redirectUri,
      request_redirect_uri: redirectUri,
      record_resource: record.resource,
      request_resource: tokenRequestResourcePresent ? tokenRequestResource : "(missing)",
      token_request_resource_present: tokenRequestResourcePresent,
      record_scope: record.scope
    });

    if (record.clientId !== clientId) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_client", { grant_type: "authorization_code", client_id: clientId, record_client_id: record.clientId });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    if (redirectUri !== record.redirectUri) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_redirect_uri", {
        grant_type: "authorization_code",
        client_id: clientId,
        request_redirect_uri: redirectUri,
        record_redirect_uri: record.redirectUri
      });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (tokenRequestResourcePresent && tokenRequestResource !== record.resource) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_resource", {
        grant_type: "authorization_code",
        client_id: clientId,
        request_resource: tokenRequestResource,
        record_resource: record.resource
      });
      return res.status(400).json({
        error: "invalid_target"
      });
    }

    const usedStoredResourceFallback = !tokenRequestResourcePresent;
    const effectiveResource = usedStoredResourceFallback ? record.resource : tokenRequestResource;
    logger.debug("[oauth] authorization_code resource resolution", {
      client_id: clientId,
      token_request_resource_present: tokenRequestResourcePresent,
      used_stored_resource_fallback: usedStoredResourceFallback
    });

    // Validate that the effective resource matches this server's canonical MCP resource.
    const canonicalResource = buildCanonicalMcpResource(req);
    logger.debug("[oauth] resource check", {
      effective_resource: effectiveResource,
      canonical_resource: canonicalResource,
      match: effectiveResource === canonicalResource
    });
    if (effectiveResource !== canonicalResource) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_resource", {
        grant_type: "authorization_code",
        client_id: clientId,
        effective_resource: effectiveResource,
        canonical_resource: canonicalResource
      });
      return res.status(400).json({
        error: "invalid_target"
      });
    }

    const computedChallenge = base64UrlSha256(codeVerifier);
    logger.debug("[oauth] PKCE check", {
      match: computedChallenge === record.codeChallenge
    });
    if (record.codeChallengeMethod !== "S256" || computedChallenge !== record.codeChallenge) {
      authorizationCodeStore.delete(code);
      logTokenFailure("invalid_code_verifier", { grant_type: "authorization_code", client_id: clientId });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    authorizationCodeStore.delete(code);
    const issuedResource = record.resource;
    logger.debug("[oauth] token issuance result", {
      client_id: clientId,
      token_request_resource_present: tokenRequestResourcePresent,
      used_stored_resource_fallback: usedStoredResourceFallback,
      token_issued: true
    });
    const accessToken = issueUserOAuthAccessToken(record.userId, record.username, record.scope, issuedResource);
    const maybeRefreshToken =
      record.allowRefreshTokenGrant
        ? issueOAuthRefreshToken({
            clientId,
            userId: record.userId,
            username: record.username,
            scope: record.scope,
            resource: issuedResource
          }).refreshToken
        : undefined;

    if (record.allowRefreshTokenGrant) {
      logger.debug("[oauth] refresh token issued", {
        client_id: clientId,
        grant_type: "authorization_code",
        scope: record.scope
      });
    }

    return res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: oauthJwtExpirySeconds,
      scope: record.scope,
      ...(maybeRefreshToken ? { refresh_token: maybeRefreshToken } : {})
    });
  }

  if (grantType === "refresh_token") {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.trim() : "";
    if (!clientId) {
      logTokenFailure("invalid_client", { grant_type: "refresh_token" });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token.trim() : "";
    if (!refreshToken) {
      return res.status(400).json({
        error: "invalid_request"
      });
    }

    cleanupExpiredRefreshTokens();
    const refreshTokenHash = hashOpaqueToken(refreshToken);
    const refreshRecord = oauthRefreshTokenStore.get(refreshTokenHash);
    if (!refreshRecord) {
      logTokenFailure("invalid_refresh_token", { grant_type: "refresh_token", client_id: clientId, reason: "not_found" });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (refreshRecord.revokedAtMs) {
      logTokenFailure("invalid_refresh_token", { grant_type: "refresh_token", client_id: clientId, reason: "revoked" });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (refreshRecord.expiresAtMs <= Date.now()) {
      oauthRefreshTokenStore.delete(refreshTokenHash);
      logTokenFailure("invalid_refresh_token", { grant_type: "refresh_token", client_id: clientId, reason: "expired" });
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (refreshRecord.clientId !== clientId) {
      logTokenFailure("invalid_client", {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token_client_id: refreshRecord.clientId
      });
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    const canonicalResource = buildCanonicalMcpResource(req);
    if (refreshRecord.resource !== canonicalResource) {
      logTokenFailure("invalid_resource", {
        grant_type: "refresh_token",
        client_id: clientId,
        token_resource: refreshRecord.resource,
        canonical_resource: canonicalResource
      });
      return res.status(400).json({
        error: "invalid_target"
      });
    }

    const requestedScopeRaw = typeof req.body?.scope === "string" ? req.body.scope : undefined;
    const normalizedRequestedScope = requestedScopeRaw ? normalizeScope(requestedScopeRaw) : undefined;
    if (requestedScopeRaw && !normalizedRequestedScope) {
      return res.status(400).json({
        error: "invalid_scope"
      });
    }

    const effectiveScope = normalizedRequestedScope ?? refreshRecord.scope;
    if (!isScopeSubset(effectiveScope, refreshRecord.scope)) {
      return res.status(400).json({
        error: "invalid_scope"
      });
    }

    const accessToken = issueUserOAuthAccessToken(
      refreshRecord.userId,
      refreshRecord.username,
      effectiveScope,
      refreshRecord.resource
    );

    const rotated = issueOAuthRefreshToken({
      clientId: refreshRecord.clientId,
      userId: refreshRecord.userId,
      username: refreshRecord.username,
      scope: effectiveScope,
      resource: refreshRecord.resource
    });
    refreshRecord.revokedAtMs = Date.now();
    refreshRecord.replacedByTokenHash = rotated.record.tokenHash;
    oauthRefreshTokenStore.set(refreshTokenHash, refreshRecord);

    logger.debug("[oauth] refresh token grant succeeded", {
      client_id: clientId,
      scope: effectiveScope
    });

    return res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: oauthJwtExpirySeconds,
      scope: effectiveScope,
      refresh_token: rotated.refreshToken
    });
  }

  logTokenFailure("unsupported_grant_type", { grant_type: grantType || "(missing)" });
  return res.status(400).json({
    error: "unsupported_grant_type"
  });
});

app.post("/accounts/register", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const user = await registerUser(parsed.data.username, parsed.data.password);
    const provisioning = await provisionAccountToServices(user.id, user.username);
    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    setRefreshCookie(req, res, tokenBundle.refreshToken);
    return res.status(201).json({ user, provisioning, ...tokenBundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Registration failed";
    if (message.includes("duplicate key")) {
      return res.status(409).json({ message: "Username already exists" });
    }
    return res.status(500).json({ message });
  }
});

app.post("/accounts/login", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  const user = await loginUser(parsed.data.username, parsed.data.password);
  if (!user) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  await provisionAccountToServices(user.id, user.username);
  const provisioning = await listProvisionings(user.id);
  const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
  setRefreshCookie(req, res, tokenBundle.refreshToken);
  return res.json({ user, provisioning, ...tokenBundle });
});

app.post("/auth/refresh", async (req, res) => {
  // Browser sessions present the token as an HttpOnly cookie and send no body;
  // native clients keep sending it in the body from OS secure storage.
  const cookieToken = readRefreshCookie(req);
  let refreshToken = cookieToken;
  if (!refreshToken) {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    refreshToken = parsed.data.refreshToken;
  }

  try {
    const claims = verifyRefreshToken(refreshToken);
    const user = await findUserById(claims.sub);
    if (!user || user.username !== claims.username) {
      return res.status(401).json({ message: "Invalid refresh token user" });
    }

    const tokenBundle = issueTokenBundle({ userId: user.id, username: user.username });
    setRefreshCookie(req, res, tokenBundle.refreshToken);
    return res.json({ user, ...tokenBundle });
  } catch (error) {
    // A rejected cookie is a dead session: drop it so the browser stops
    // replaying it on every reload.
    if (cookieToken) clearRefreshCookie(req, res);
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }
    const message = error instanceof Error ? error.message : "Refresh failed";
    return res.status(401).json({ message });
  }
});

app.post("/auth/logout", (req, res) => {
  clearRefreshCookie(req, res);
  return res.json({ status: "ok" });
});

app.get("/auth/me", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const user = await findUserById(authContext.userId);
  if (!user) {
    return res.status(401).json({ message: "User not found" });
  }

  const provisioning = await listProvisionings(user.id);
  return res.json({ user, provisioning });
});

app.get("/integrations/manifests", async (_req, res) => {
  const enabledIntegrationIds = new Set<string>(configuredServiceIds());
  enabledIntegrationIds.add("image_generation");
  enabledIntegrationIds.add("deep_research");
  return res.json(getIntegrationManifests(enabledIntegrationIds));
});

app.get("/integrations/configs", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const configs = await listIntegrationConfigs(authContext.userId);
  return res.json(configs);
});

app.put("/integrations/configs/:integrationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) {
    return;
  }

  const parsed = integrationConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.flatten() });
  }

  try {
    const existingConfig = (await listIntegrationConfigs(authContext.userId)).find(
      (row) => row.integrationId === req.params.integrationId
    );
    const mergedValues = {
      ...(existingConfig?.values ?? {}),
      ...parsed.data.values
    };

    const values = parsed.data.enabled
      ? await ensureIntegrationLinked(req.params.integrationId, mergedValues)
      : mergedValues;
    await saveIntegrationConfig(authContext.userId, req.params.integrationId, parsed.data.enabled, values);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration activation failed";
    return res.status(502).json({ message });
  }

  return res.json({ status: "ok" });
});

registerDeepResearchRoutes(app);

registerMindmapRoutes(app);

registerAnalyserRoutes(app);

registerWbsRoutes(app);

registerImageRoutes(app);

// Local clients and daemon-pulled jobs
registerLocalClientRoutes(app);
registerLocalJobRoutes(app);
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

// External facade for projects
app.get("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const query = typeof req.query.q === "string" ? req.query.q : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  try {
    const result = await projectsClient.list(
      authContext.accessToken,
      query,
      status,
      Number.isFinite(limit) ? limit : undefined,
      cursor
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.create(authContext.accessToken, req.body);
    const projectId = objectId(result);
    await recordSyncEventBestEffort(authContext.userId, "projects", projectId, "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    if (projectId) {
      await invalidateProjectContextFromApi(authContext.userId, [projectId], "project", "project", projectId);
    }
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.getDefault(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/projects/default", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.setDefault(authContext.accessToken, req.body);
    const body = asJsonRecord(req.body);
    const projectId = asNonEmptyString(body.projectId) ?? objectId(result);
    await recordSyncEventBestEffort(authContext.userId, "projects", projectId, "update", {
      source: "core-api",
      relation: "default",
      projectId,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/context", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const numberQuery = (name: string): number | undefined => {
    const value = typeof req.query[name] === "string" ? Number(req.query[name]) : undefined;
    return Number.isFinite(value) ? value : undefined;
  };
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const projectId = String(req.params.projectId);
    const result = await getProjectContextWithResolvedLinks(authContext.accessToken, String(req.params.projectId), {
      q: query,
      include: typeof req.query.include === "string" ? req.query.include : undefined,
      memoryLimit: numberQuery("memoryLimit"),
      indexLimit: numberQuery("indexLimit"),
      relationLimit: numberQuery("relationLimit"),
      maxChars: numberQuery("maxChars")
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/brief", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(await projectsClient.getBrief(authContext.accessToken, String(req.params.projectId)));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/projects/:projectId/brief", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const body = asJsonRecord(req.body);
  try {
    const result = await projectsClient.updateBrief(authContext.accessToken, String(req.params.projectId), {
      contentMarkdown: body.contentMarkdown,
      expectedVersion: body.expectedVersion,
      updatedByKind: "user"
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "brief",
      "brief",
      String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/memories", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const result = await projectsClient.listMemories(authContext.accessToken, String(req.params.projectId), {
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      authority: typeof req.query.authority === "string" ? req.query.authority : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/memories", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.appendMemory(authContext.accessToken, String(req.params.projectId), {
      ...asJsonRecord(req.body),
      authority: asNonEmptyString(asJsonRecord(req.body).authority) ?? "user_confirmed",
      createdByKind: "user"
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "memory",
      "memory",
      objectId(result) ?? String(req.params.projectId)
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/project-memories/:memoryId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.updateMemory(authContext.accessToken, String(req.params.memoryId), req.body);
    await invalidateProjectContextFromApi(
      authContext.userId,
      [projectIdFromMutationResult(result)],
      "memory",
      "memory",
      String(req.params.memoryId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/index", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const projectId = String(req.params.projectId);
    const result = await projectsClient.listIndexEntries(authContext.accessToken, projectId, {
      q: query,
      sourceService: typeof req.query.sourceService === "string" ? req.query.sourceService : undefined,
      resourceType: typeof req.query.resourceType === "string" ? req.query.resourceType : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/index/rebuild", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await rebuildProjectIndex(authContext.accessToken, String(req.params.projectId));
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "index",
      "index",
      String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/deletion-impact", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(await getProjectDeletionImpact(authContext.accessToken, String(req.params.projectId)));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/relations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    return res.json(
      await projectsClient.listRelations(authContext.accessToken, String(req.params.projectId), {
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
      })
    );
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/relations", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.createRelation(authContext.accessToken, String(req.params.projectId), {
      ...asJsonRecord(req.body),
      createdByKind: "user"
    });
    const endpoints = requireProjectContextEndpoints(result);
    await invalidateProjectContextFromApi(
      authContext.userId,
      [endpoints.sourceProjectId, endpoints.targetProjectId],
      "relation",
      "relation",
      endpoints.id
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/project-relations/:relationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.updateRelation(authContext.accessToken, String(req.params.relationId), req.body);
    const endpoints = requireProjectContextEndpoints(result);
    await invalidateProjectContextFromApi(
      authContext.userId,
      [endpoints.sourceProjectId, endpoints.targetProjectId],
      "relation",
      "relation",
      endpoints.id
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/project-relations/:relationId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const relation = await projectsClient.getRelation(authContext.accessToken, String(req.params.relationId));
    const endpoints = requireProjectContextEndpoints(relation);
    await projectsClient.removeRelation(authContext.accessToken, String(req.params.relationId));
    await invalidateProjectContextFromApi(
      authContext.userId,
      [endpoints.sourceProjectId, endpoints.targetProjectId],
      "relation",
      "relation",
      endpoints.id
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/links", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  try {
    return res.json(
      await listProjectLinksResolved(authContext.accessToken, String(req.params.projectId), {
        targetService: typeof req.query.targetService === "string" ? req.query.targetService : undefined,
        targetResourceType:
          typeof req.query.targetResourceType === "string" ? req.query.targetResourceType : undefined,
        targetResourceId: typeof req.query.targetResourceId === "string" ? req.query.targetResourceId : undefined,
        relationType: typeof req.query.relationType === "string" ? req.query.relationType : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined
      })
    );
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/links", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await createProjectLinkWithValidation(
      authContext.accessToken,
      String(req.params.projectId),
      req.body
    );
    const linkRelationType = asNonEmptyString(asJsonRecord(result).relationType)
      ?? asNonEmptyString(asJsonRecord(req.body).relationType);
    const changed = linkRelationType === "secondary_membership" ? "membership" : "link";
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      changed === "membership" ? ["membership", "index"] : changed,
      changed,
      objectId(result) ?? String(req.params.projectId)
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/project-links/:linkId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const link = await removeProjectLinkWithValidation(authContext.accessToken, String(req.params.linkId));
    const changed = link.relationType === "secondary_membership" ? "membership" : "link";
    await invalidateProjectContextFromApi(
      authContext.userId,
      [link.projectId],
      changed === "membership" ? ["membership", "index"] : changed,
      changed,
      link.id
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId/context-summary", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(await projectsClient.getContextSummary(authContext.accessToken, String(req.params.projectId)));
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/projects/:projectId/context-summary/refresh", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await projectsClient.refreshContextSummary(
      authContext.accessToken,
      String(req.params.projectId),
      req.body
    );
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "summary",
      "summary",
      objectId(result) ?? String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.get(authContext.accessToken, String(req.params.projectId));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await projectsClient.update(authContext.accessToken, String(req.params.projectId), req.body);
    await recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "project",
      "project",
      String(req.params.projectId)
    );
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await deleteProjectWithGuard(authContext.accessToken, String(req.params.projectId));
    await recordSyncEventBestEffort(authContext.userId, "projects", String(req.params.projectId), "delete", {
      source: "core-api",
      deleted: true
    });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      "project",
      "project",
      String(req.params.projectId),
      "delete"
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for notes
registerNoteRoutes(app);

// External facade for artifacts
app.get("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.list(authContext.accessToken, projectId, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  try {
    const result = await artifactsClient.tree(authContext.accessToken, projectId);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/tree/list", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const pathPrefix = typeof req.query.pathPrefix === "string" ? req.query.pathPrefix : undefined;
  const kinds = typeof req.query.kinds === "string" ? req.query.kinds.split(",").map((kind) => kind.trim()) : undefined;
  const includeContent = typeof req.query.includeContent === "string" ? ["1", "true", "yes"].includes(req.query.includeContent.toLowerCase()) : undefined;
  const updatedSince = typeof req.query.updatedSince === "string" ? req.query.updatedSince : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await artifactsClient.treeList(authContext.accessToken, {
      projectId,
      pathPrefix,
      kinds,
      includeContent,
      updatedSince,
      limit: Number.isFinite(limit) ? limit : undefined
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.getItem(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:artifactItemId/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    return res.json(
      await getArtifactProjectMemberships(authContext.accessToken, String(req.params.artifactItemId))
    );
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/items/:artifactItemId/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const body = asJsonRecord(req.body);
  const projectId = asNonEmptyString(body.projectId);
  if (!projectId) return res.status(400).json({ message: "projectId is required" });
  try {
    const result = await linkArtifactToProject(authContext.accessToken, String(req.params.artifactItemId), {
      projectId,
      note: asNonEmptyString(body.note),
      expectedArtifactVersion:
        typeof body.expectedArtifactVersion === "number" ? body.expectedArtifactVersion : undefined
    });
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.artifactItemId), "update", {
      source: "core-api",
      relation: "project-membership",
      action: "link",
      projectId
    }, { projectId });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [projectId],
      ["membership", "index"],
      "membership",
      String(req.params.artifactItemId)
    );
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/items/:artifactItemId/projects/:projectId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await unlinkArtifactFromProject(
      authContext.accessToken,
      String(req.params.artifactItemId),
      String(req.params.projectId)
    );
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.artifactItemId), "update", {
      source: "core-api",
      relation: "project-membership",
      action: "unlink",
      projectId: String(req.params.projectId)
    }, { projectId: String(req.params.projectId) });
    await invalidateProjectContextFromApi(
      authContext.userId,
      [String(req.params.projectId)],
      ["membership", "index"],
      "membership",
      String(req.params.artifactItemId)
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/folders", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.createFolder(authContext.accessToken, req.body);
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(undefined, result));
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, objectId(result) ?? "unknown");
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/notes", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await createArtifactNoteWithIndex(authContext.accessToken, req.body);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(undefined, result));
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, objectId(result) ?? "unknown");
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts/upload", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const target = `${serviceBaseUrls.artifacts}/artifacts/upload`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) {
      res.setHeader("Content-Type", responseContentType);
    }

    if (upstream.ok && responseContentType?.includes("application/json")) {
      const result = jsonRecordFromBuffer(buffer);
      await maintainArtifactIndexBestEffort(authContext.accessToken, result);
      const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
      await invalidateArtifactIndexFromApi(authContext.userId, projectIds, objectId(result) ?? "unknown");
    }

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.patch("/api/artifacts/items/:id/content-patch", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.patchNoteContent(authContext.accessToken, String(req.params.id), req.body);
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/items/:id/section", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.updateNoteSection(authContext.accessToken, String(req.params.id), req.body);
    await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    const projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, result);
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    let before: unknown;
    let projectIds: string[] = [];
    try {
      before = await artifactsClient.getItem(authContext.accessToken, String(req.params.id));
      projectIds = await listArtifactProjectIdsBestEffort(authContext.accessToken, before);
    } catch {
      before = undefined;
    }
    const result = await artifactsClient.updateItem(authContext.accessToken, String(req.params.id), req.body);
    if (before) {
      await reconcileArtifactMutationBestEffort(authContext.accessToken, before, result);
    } else {
      await maintainArtifactIndexBestEffort(authContext.accessToken, result);
    }
    projectIds.push(...await listArtifactProjectIdsBestEffort(authContext.accessToken, result));
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(before, result));
    await invalidateArtifactIndexFromApi(authContext.userId, projectIds, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const snapshot = await removeArtifactItemWithProjectCleanup(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    }, artifactEventMetadata(artifactDeletionSnapshotRoot(snapshot)));
    await invalidateArtifactIndexFromApi(
      authContext.userId,
      projectIdsFromArtifactDeletionSnapshot(snapshot),
      String(req.params.id)
    );
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/artifacts/items/:id/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") {
    query.set("download", req.query.download);
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/download${suffix}`;

  try {
    const upstream = await fetch(target, {
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

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/items/:id/preview-pdf", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const id = encodeURIComponent(String(req.params.id));
  const target = `${serviceBaseUrls.artifacts}/artifacts/items/${id}/preview-pdf`;

  try {
    const upstream = await fetch(target, {
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

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Preview proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/artifacts", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await artifactsClient.create(authContext.accessToken, req.body);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(undefined, result, "artifact"));
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    let before: unknown;
    try {
      before = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    } catch {
      before = undefined;
    }
    const result = await artifactsClient.update(authContext.accessToken, String(req.params.id), req.body);
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    }, artifactEventMetadata(before, result, "artifact"));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/artifacts/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    let before: unknown;
    try {
      before = await artifactsClient.get(authContext.accessToken, String(req.params.id));
    } catch {
      before = undefined;
    }
    await artifactsClient.remove(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "artifacts", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    }, artifactEventMetadata(before, undefined, "artifact"));
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// External facade for tasks
app.get("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

  try {
    const result = await tasksClient.list(authContext.accessToken, context, status, Number.isFinite(limit) ? limit : undefined);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/pins", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.pins(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.put("/api/tasks/:id/pin", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined;
  if (pinned === undefined) {
    return res.status(400).json({ message: "pinned(boolean) is required" });
  }

  try {
    const result = await tasksClient.setPin(authContext.accessToken, String(req.params.id), pinned);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "pin",
      pinned,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/schedule", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  const context = typeof req.query.context === "string" ? req.query.context : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;

  if (!startDate || !endDate) {
    return res.status(400).json({ message: "startDate and endDate are required" });
  }

  try {
    const result = await tasksClient.schedule(authContext.accessToken, startDate, endDate, context, status);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/complete", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  const status = typeof req.body?.status === "string" ? req.body.status : undefined;
  if (!targetDate || !status) {
    return res.status(400).json({ message: "targetDate and status are required" });
  }

  try {
    const result = await tasksClient.completeOccurrence(authContext.accessToken, String(req.params.id), targetDate, status);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      targetDate,
      status,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/move", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const sourceDate = typeof req.body?.sourceDate === "string" ? req.body.sourceDate : undefined;
  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  if (!sourceDate || !targetDate) {
    return res.status(400).json({ message: "sourceDate and targetDate are required" });
  }

  try {
    const result = await tasksClient.moveOccurrence(authContext.accessToken, String(req.params.id), sourceDate, targetDate);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      operation: "move",
      sourceDate,
      targetDate,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/skip-exception", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const targetDate = typeof req.body?.targetDate === "string" ? req.body.targetDate : undefined;
  if (!targetDate) {
    return res.status(400).json({ message: "targetDate is required" });
  }

  try {
    const result = await tasksClient.skipOccurrenceException(authContext.accessToken, String(req.params.id), targetDate);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "occurrence",
      operation: "skipException",
      targetDate,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/projects", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.projects(authContext.accessToken);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── These literal-path GET routes MUST come before GET /api/tasks/:id ──────

app.get("/api/tasks/export", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const csv = await tasksClient.exportCsv(authContext.accessToken);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="tasks.csv"');
    return res.send(csv);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// GET /api/tasks/today?date=YYYY-MM-DD → TodayTask[] (task + occurrenceDate)
app.get("/api/tasks/today", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  logger.debug(`[workbench-core] GET /api/tasks/today  date=${date ?? "?"}`);
  if (!date) return res.status(400).json({ message: "date query parameter is required (YYYY-MM-DD)" });
  try {
    const result = await tasksClient.today(authContext.accessToken, date);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// GET /api/tasks/schedule-calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns ScheduleCalendarDay[] grouped by scheduled_date.
// NOTE: Must be registered before GET /api/tasks/:id to prevent Express from
//       matching "schedule-calendar" as a task ID.
app.get("/api/tasks/schedule-calendar", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
  logger.debug(`[workbench-core] GET /api/tasks/schedule-calendar  ${startDate}→${endDate}`);
  if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate query parameters are required" });
  try {
    const result = await tasksClient.scheduleCalendar(authContext.accessToken, startDate, endDate);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/history", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.history(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id/schedule-items", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.listScheduleItemsForTask(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.get("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.get(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.create(authContext.accessToken, req.body);
    await recordSyncEventBestEffort(authContext.userId, "tasks", objectId(result), "create", {
      source: "core-api",
      resource: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    const result = await tasksClient.update(authContext.accessToken, String(req.params.id), req.body);
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      patch: req.body as Record<string, unknown>,
      resource: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  try {
    await tasksClient.remove(authContext.accessToken, String(req.params.id));
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "delete", {
      source: "core-api",
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/import", express.text({ type: "text/csv", limit: "10mb" }), async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const parsed = taskImportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  const csvContent = typeof parsed.data === "string" ? parsed.data : parsed.data.csv;
  if (!csvContent.trim()) {
    return res.status(400).json({ message: "CSV content is required" });
  }

  try {
    const result = await tasksClient.importCsv(authContext.accessToken, csvContent);
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Attachments ────────────────────────────────────────────────────────

app.get("/api/tasks/:id/attachments", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.listAttachments(authContext.accessToken, String(req.params.id));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/attachments", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) res.setHeader("Content-Type", responseContentType);
    if (upstream.ok) {
      const attachment = responseContentType?.includes("application/json")
        ? jsonRecordFromBuffer(buffer)
        : {};
      await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
        source: "core-api",
        relation: "attachment",
        action: "create",
        attachment
      });
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload proxy failed";
    return res.status(502).json({ message });
  }
});

app.put("/api/tasks/:id/attachments/:attachmentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const attachmentId = encodeURIComponent(String(req.params.attachmentId));
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments/${attachmentId}`;
  const contentType = req.header("content-type");

  try {
    const upstream = await fetch(target, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        ...(contentType ? { "Content-Type": contentType } : {})
      },
      body: req as any,
      duplex: "half"
    } as RequestInit & { duplex: "half" });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseContentType = upstream.headers.get("content-type");
    if (responseContentType) res.setHeader("Content-Type", responseContentType);
    if (upstream.ok) {
      const attachment = responseContentType?.includes("application/json")
        ? jsonRecordFromBuffer(buffer)
        : {};
      await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
        source: "core-api",
        relation: "attachment",
        action: "update",
        attachmentId: String(req.params.attachmentId),
        attachment
      });
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Attachment replacement proxy failed";
    return res.status(502).json({ message });
  }
});

app.get("/api/tasks/:id/attachments/:attachmentId/download", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;

  const taskId = encodeURIComponent(String(req.params.id));
  const attachmentId = encodeURIComponent(String(req.params.attachmentId));
  const query = new URLSearchParams();
  if (typeof req.query.download === "string") query.set("download", req.query.download);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const target = `${serviceBaseUrls.tasks}/tasks/${taskId}/attachments/${attachmentId}/download${suffix}`;

  try {
    const upstream = await fetch(target, {
      headers: { Authorization: `Bearer ${authContext.accessToken}` }
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    const disposition = upstream.headers.get("content-disposition");
    const length = upstream.headers.get("content-length");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (disposition) res.setHeader("Content-Disposition", disposition);
    if (length) res.setHeader("Content-Length", length);

    return res.status(upstream.status).send(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Download proxy failed";
    return res.status(502).json({ message });
  }
});

app.delete("/api/tasks/:id/attachments/:attachmentId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await tasksClient.deleteAttachment(authContext.accessToken, String(req.params.id), String(req.params.attachmentId));
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "attachment",
      action: "delete",
      attachmentId: String(req.params.attachmentId),
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Subtasks ────────────────────────────────────────────────────────────

app.get("/api/tasks/:id/occurrences/:date/subtasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.listSubtasks(authContext.accessToken, String(req.params.id), String(req.params.date));
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.post("/api/tasks/:id/occurrences/:date/subtasks", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.createSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      req.body?.title
    );
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "create",
      occurrenceDate: String(req.params.date),
      subtaskId: objectId(result),
      subtask: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.patch("/api/tasks/:id/occurrences/:date/subtasks/:subtaskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    const result = await tasksClient.updateSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      String(req.params.subtaskId),
      req.body
    );
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "update",
      occurrenceDate: String(req.params.date),
      subtaskId: String(req.params.subtaskId),
      patch: req.body as Record<string, unknown>,
      subtask: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/:id/occurrences/:date/subtasks/:subtaskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  try {
    await tasksClient.deleteSubtask(
      authContext.accessToken,
      String(req.params.id),
      String(req.params.date),
      String(req.params.subtaskId)
    );
    await recordSyncEventBestEffort(authContext.userId, "tasks", String(req.params.id), "update", {
      source: "core-api",
      relation: "subtask",
      action: "delete",
      occurrenceDate: String(req.params.date),
      subtaskId: String(req.params.subtaskId),
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ── Task Today ("My Day") and Schedule ──────────────────────────────────────
// NOTE: GET /api/tasks/today is registered before GET /api/tasks/:id (above).
// Only POST, DELETE, schedule-calendar, and schedule-items remain here.

// POST /api/tasks/today — add a schedule item (= "add to My Day")
// Body: { taskId: string, scheduledDate: string, occurrenceDate: string, startTime?, endTime?, timezone? }
// scheduledDate  = calendar date to work on the task (today when called from My Day button)
// occurrenceDate = LBS execution date (may differ for Overdue/Planned tasks)
app.post("/api/tasks/today", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  logger.debug(`[workbench-core] POST /api/tasks/today  body=${JSON.stringify(req.body)}`);
  try {
    const { taskId, scheduledDate, occurrenceDate, startTime, endTime, timezone } = req.body as {
      taskId?: unknown; scheduledDate?: unknown; occurrenceDate?: unknown;
      startTime?: unknown; endTime?: unknown; timezone?: unknown;
    };
    // occurrenceDate may be omitted or "" for tasks with no LBS due date
    // (ONCE + no due_date); the tasks-service resolves it to scheduledDate.
    if (typeof taskId !== "string" || !taskId || typeof scheduledDate !== "string" || !scheduledDate) {
      return res.status(400).json({ message: "taskId and scheduledDate are required strings" });
    }
    if (occurrenceDate !== undefined && typeof occurrenceDate !== "string") {
      return res.status(400).json({ message: "occurrenceDate must be a string when provided" });
    }
    const requestedOccurrenceDate = occurrenceDate ?? "";
    const opts = {
      startTime: typeof startTime === "string" ? startTime : undefined,
      endTime: typeof endTime === "string" ? endTime : undefined,
      timezone: typeof timezone === "string" ? timezone : undefined
    };
    const result = await tasksClient.addToday(authContext.accessToken, taskId, scheduledDate, requestedOccurrenceDate, opts);
    const resultRecord = result as Record<string, unknown>;
    const effectiveOccurrenceDate = typeof resultRecord.occurrenceDate === "string"
      ? resultRecord.occurrenceDate
      : requestedOccurrenceDate || scheduledDate;
    await recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "today",
      action: "create",
      scheduledDate,
      occurrenceDate: effectiveOccurrenceDate,
      startTime: opts.startTime,
      endTime: opts.endTime,
      timezone: opts.timezone,
      scheduleItem: result as Record<string, unknown>
    });
    return res.status(201).json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// DELETE /api/tasks/today/:taskId?scheduledDate=YYYY-MM-DD — remove from Today
app.delete("/api/tasks/today/:taskId", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const taskId = String(req.params.taskId);
  const scheduledDate = typeof req.query.scheduledDate === "string" ? req.query.scheduledDate : undefined;
  const occurrenceDate = typeof req.query.occurrenceDate === "string" ? req.query.occurrenceDate : undefined;
  logger.debug(`[workbench-core] DELETE /api/tasks/today/${taskId}  scheduledDate=${scheduledDate ?? "?"} occurrenceDate=${occurrenceDate ?? "?"}`);
  if (!scheduledDate) return res.status(400).json({ message: "scheduledDate query parameter is required (YYYY-MM-DD)" });
  try {
    const result = await tasksClient.removeFromToday(authContext.accessToken, taskId, scheduledDate, occurrenceDate);
    await recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "today",
      action: "delete",
      scheduledDate,
      occurrenceDate,
      deleted: true,
      result: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// PUT /api/tasks/schedule-items/:id — update a schedule item's time/date fields
app.put("/api/tasks/schedule-items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const scheduleId = parseInt(req.params.id, 10);
  logger.debug(`[workbench-core] PUT /api/tasks/schedule-items/${scheduleId}  body=${JSON.stringify(req.body)}`);
  if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
  try {
    const patch = req.body as { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null };
    const result = await tasksClient.updateScheduleItem(authContext.accessToken, scheduleId, patch);
    if (!result) return res.status(404).json({ message: "Schedule item not found" });
    await recordSyncEventBestEffort(authContext.userId, "tasks", result.taskId, "update", {
      source: "core-api",
      relation: "scheduleItem",
      action: "update",
      scheduleId,
      patch: patch as Record<string, unknown>,
      scheduleItem: result as Record<string, unknown>
    });
    return res.json(result);
  } catch (error) {
    return respondInternalError(res, error);
  }
});

app.delete("/api/tasks/schedule-items/:id", async (req, res) => {
  const authContext = await requireAuthenticatedContext(req, res);
  if (!authContext) return;
  const scheduleId = parseInt(req.params.id, 10);
  if (isNaN(scheduleId)) return res.status(400).json({ message: "id must be a number" });
  try {
    const body = asJsonRecord(req.body);
    const taskId = asNonEmptyString(body.taskId) ?? (typeof req.query.taskId === "string" ? req.query.taskId.trim() : undefined);
    const scheduledDate = asNonEmptyString(body.scheduledDate) ?? (typeof req.query.scheduledDate === "string" ? req.query.scheduledDate.trim() : undefined);
    const occurrenceDate = asNonEmptyString(body.occurrenceDate) ?? (typeof req.query.occurrenceDate === "string" ? req.query.occurrenceDate.trim() : undefined);
    await tasksClient.deleteScheduleItem(authContext.accessToken, scheduleId);
    await recordSyncEventBestEffort(authContext.userId, "tasks", taskId, "update", {
      source: "core-api",
      relation: "scheduleItem",
      action: "delete",
      scheduleId,
      scheduledDate,
      occurrenceDate,
      deleted: true
    });
    return res.status(204).send();
  } catch (error) {
    return respondInternalError(res, error);
  }
});

// ---------------------------------------------------------------------------
// MCP HTTP endpoint (Streamable HTTP transport, stateless)
// Requires Bearer token authentication. Tools are accessible at POST /mcp.
// ---------------------------------------------------------------------------

type McpInjectedContext = {
  accessToken: string;
  coreUserId: string;
};

function createMcpServerInstance(injectedContext: McpInjectedContext): McpServer {
  const server = new McpServer({ name: "workbench-core-mcp", version: "0.2.0" });
  instrumentMcpServer(server, injectedContext);
  registerNotesTools(server, injectedContext);
  registerArtifactsTools(server, injectedContext);
  registerTasksTools(server, injectedContext);
  registerProjectsTools(server, injectedContext);
  registerProjectContextTools(server, injectedContext);
  registerDeepResearchTools(server, injectedContext);
  registerImageTools(server, injectedContext);
  registerAnalyserTools(server, injectedContext);
  registerMindmapTools(server, injectedContext);
  registerWbsTools(server, injectedContext);
  return server;
}

// Handle POST /mcp - used for tool calls (and initialize)
function setMcpBearerChallengeHeader(req: express.Request, res: express.Response): void {
  const issuer = buildOAuthIssuer(req);
  const resourceMetadataUrl = joinIssuerPath(issuer, "/.well-known/oauth-protected-resource");
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:tools"`);
}

function isExpectedMcpAudience(decoded: { aud?: unknown }, expectedAudience: string): boolean {
  const aud = decoded.aud;
  if (!aud) {
    return false;
  }
  if (typeof aud === "string") {
    return aud === expectedAudience;
  }
  if (Array.isArray(aud)) {
    return aud.includes(expectedAudience);
  }
  return false;
}

function tokenHasRequiredScope(decoded: { scope?: unknown }, requiredScope: string): boolean {
  const scopeClaim = decoded.scope;
  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0)
      .includes(requiredScope);
  }
  if (Array.isArray(scopeClaim)) {
    return scopeClaim.includes(requiredScope);
  }
  return false;
}

app.post("/mcp", async (req, res) => {
  const token = readBearerToken(req);
  if (!token) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Bearer token required for MCP access" });
  }

  let injectedContext: McpInjectedContext | undefined;
  try {
    verifyAccessToken(token);
  } catch {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
  }

  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== "object") {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token payload" });
  }

  const expectedAudience = buildCanonicalMcpResource(req);
  if (!isExpectedMcpAudience(decoded as { aud?: unknown }, expectedAudience)) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token audience" });
  }
  if (!tokenHasRequiredScope(decoded as { scope?: unknown }, "mcp:tools")) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Insufficient token scope" });
  }

  const decodedIdentity = decoded as { sub?: unknown; username?: unknown };
  if (typeof decodedIdentity.sub !== "string" || decodedIdentity.sub.trim().length === 0) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token subject" });
  }

  const user = await findUserById(decodedIdentity.sub);
  if (!user) {
    setMcpBearerChallengeHeader(req, res);
    return res.status(401).json({ error: "Unauthorized", message: "Invalid token user" });
  }

  const bundle = issueTokenBundle({ userId: user.id, username: user.username });
  injectedContext = { accessToken: bundle.accessToken, coreUserId: user.id };
  logger.info("[mcp] user context injected", { username: user.username });

  const server = createMcpServerInstance(injectedContext);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP request failed";
    if (!res.headersSent) {
      res.status(500).json({ error: "InternalError", message });
    }
  }
});

// Handle GET /mcp - SSE stream for server-initiated messages (stateless: returns 405)
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    error: "MethodNotAllowed",
    message: "This MCP server runs in stateless mode. Use POST /mcp for all requests."
  });
});

const uiDistPath = path.resolve(__dirname, "../../../ui/dist");
const uiIndexHtmlPath = path.join(uiDistPath, "index.html");

function isReservedHttpPath(pathname: string): boolean {
  const reservedPrefixes = [
    "/.well-known",
    "/accounts",
    "/api",
    "/auth",
    "/authorize",
    "/integrations",
    "/mcp",
    "/oauth",
    "/health"
  ];
  return reservedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function shouldServeWorkbenchUi(req: express.Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let pathname = req.path;
  try {
    pathname = new URL(req.originalUrl, "http://workbench.local").pathname;
  } catch {
    // Keep Express' parsed path.
  }

  if (isReservedHttpPath(pathname)) return false;
  const accept = req.header("accept") ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}

if (existsSync(uiIndexHtmlPath)) {
  app.use(
    express.static(uiDistPath, {
      index: false,
      maxAge: "1h"
    })
  );

  app.get("*", (req, res, next) => {
    if (!shouldServeWorkbenchUi(req)) {
      next();
      return;
    }
    res.sendFile(uiIndexHtmlPath);
  });
}

// ---------------------------------------------------------------------------

export async function startHttpServer(): Promise<void> {
  const port = Number(requireEnv("CORE_SERVICE_PORT"));
  const host = requireEnv("CORE_SERVICE_HOST");
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid CORE_SERVICE_PORT value: ${process.env.CORE_SERVICE_PORT}`);
  }

  await ensureCoreSchema();
  if (serviceBaseUrls.analyser) startAnalyserProjector();
  app.listen(port, host, () => {
    logger.info(`Workbench Core HTTP listening on ${host}:${port}`);
    logger.info(`MCP HTTP endpoint available at POST http://${host}:${port}/mcp`);
    if (canonicalBaseConfig) {
      logger.info(`Canonical external OAuth base configured as ${canonicalBaseConfig.issuer}`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  installProcessHandlers(logger);
  void startHttpServer();
}
