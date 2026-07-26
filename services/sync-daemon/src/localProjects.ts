import { randomUUID } from "node:crypto";
import {
  listOpenOutboxForResource,
  listRemoteResources,
  markRemoteResourceDeleted,
  markOutboxSuperseded,
  removeRemoteResource,
  upsertRemoteResource,
  writeManifestDebugSnapshot,
  type OutboxItem
} from "./manifestStore.js";
import {
  asNumber,
  asString,
  enqueueManifestOutbox,
  listLocalRemoteDomainItems,
  localRemoteDomainItem,
  refreshManifestStats,
  remoteResourceUpdatedAt,
  resultRecord,
  supersedeOpenOutboxForPath
} from "./localStore.js";
import {
  echoLocalProjectBrief,
  echoLocalProjectMemoryCreate,
  echoLocalProjectMemoryPatch,
  echoLocalProjectRelationCreate,
  echoLocalProjectRelationDelete,
  echoLocalProjectRelationPatch,
  findLocalProjectMemory,
  findLocalProjectRelation,
  LocalProjectContextError,
  PROJECT_CONTEXT_DOMAIN,
  requireWritableProjectContext
} from "./projectContextCache.js";
import type { DaemonState, SyncPushResponse } from "./types.js";

export const LOCAL_PROJECT_ID_PREFIX = "local-project-";
const LOCAL_PROJECT_STATUSES = new Set(["draft", "active", "archived"]);

export function isLocalProjectId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_PROJECT_ID_PREFIX);
}

export function projectOutboxPath(id: string): string {
  return `projects/${id}`;
}

export function projectDefaultOutboxPath(): string {
  return "projects/default";
}

export function normalizeProjectStatus(value: unknown, fallback?: unknown): "draft" | "active" | "archived" {
  if (typeof value === "string" && LOCAL_PROJECT_STATUSES.has(value)) {
    return value as "draft" | "active" | "archived";
  }
  if (typeof fallback === "string" && LOCAL_PROJECT_STATUSES.has(fallback)) {
    return fallback as "draft" | "active" | "archived";
  }
  return "active";
}

export function normalizeLocalProjectPayload(
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : typeof existing?.name === "string" && existing.name.trim()
      ? existing.name
      : "Untitled Project";
  const description = typeof input.description === "string"
    ? input.description
    : typeof existing?.description === "string"
      ? existing.description
      : "";
  return {
    ...(existing ?? {}),
    name,
    description,
    status: normalizeProjectStatus(input.status, existing?.status),
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
}

export function localProjectDefaultSelection(project: Record<string, unknown>): Record<string, unknown> {
  return {
    project,
    source: project.isFallbackDefault === true && project.isUserDefault !== true ? "fallback" : "user"
  };
}

export function projectDefaultRelationPayload(item: OutboxItem): { relation: "default"; projectId: string } | undefined {
  if (item.domain !== "projects" || asString(item.payload.relation) !== "default") return undefined;
  const projectId = asString(item.payload.projectId) ?? item.resourceId ?? asString(item.payload.id);
  return projectId ? { relation: "default", projectId } : undefined;
}

export function updateLocalProjectDefaultCache(state: DaemonState, projectId: string, updatedAt: string): Record<string, unknown> | undefined {
  let selected: Record<string, unknown> | undefined;
  for (const resource of listRemoteResources(state.manifestStore, { domain: "projects", includeDeleted: false, limit: 1000 })) {
    const id = asString(resource.payload.id) ?? resource.resourceId;
    const payload = {
      ...resource.payload,
      id,
      isUserDefault: id === projectId,
      updatedAt: asString(resource.payload.updatedAt) ?? resource.updatedAt ?? updatedAt
    };
    upsertRemoteResource(state.manifestStore, {
      domain: "projects",
      resourceId: resource.resourceId,
      version: resource.version,
      payload,
      updatedAt: asString(payload.updatedAt) ?? updatedAt,
      lastSyncedAt: resource.lastSyncedAt
    });
    if (id === projectId) {
      selected = payload;
    }
  }
  return selected;
}

export function supersedeOpenProjectDefaultForResource(state: DaemonState, resourceId: string, reason: string, updatedAt: string): void {
  for (const item of listOpenOutboxForResource(state.manifestStore, resourceId)) {
    if (item.domain !== "projects" || asString(item.payload.relation) !== "default") continue;
    markOutboxSuperseded(state.manifestStore, item.id, reason, updatedAt);
  }
}

export function shouldDeferProjectOutboxItem(state: DaemonState, item: OutboxItem): boolean {
  const defaultPayload = projectDefaultRelationPayload(item);
  if (!defaultPayload || !isLocalProjectId(defaultPayload.projectId)) return false;
  return listOpenOutboxForResource(state.manifestStore, defaultPayload.projectId).some(
    (candidate) => candidate.domain === "projects"
      && candidate.action === "create"
      && asString(candidate.payload.relation) !== "default"
  );
}

export function localDefaultProjectSelection(state: DaemonState): Record<string, unknown> | undefined {
  const projects = listLocalRemoteDomainItems(state, "projects");
  const project = projects.find((item) => item.isUserDefault === true)
    ?? projects.find((item) => item.isFallbackDefault === true);
  if (!project) return undefined;
  return {
    project,
    source: project.isUserDefault === true ? "user" : "fallback"
  };
}

export function retargetOpenProjectOutboxReferences(state: DaemonState, oldResourceId: string, newResourceId: string, updatedAt: string): void {
  for (const item of listOpenOutboxForResource(state.manifestStore, oldResourceId)) {
    if (item.domain !== "projects") continue;
    markOutboxSuperseded(
      state.manifestStore,
      item.id,
      "Local project received a cloud id; pending project operation was retargeted.",
      updatedAt
    );
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: item.relativePath,
      domain: item.domain,
      action: item.action,
      resourceId: newResourceId,
      payload: {
        ...item.payload,
        id: asString(item.payload.id) === oldResourceId ? newResourceId : item.payload.id,
        projectId: asString(item.payload.projectId) === oldResourceId ? newResourceId : item.payload.projectId
      }
    });
  }
}

export function applyProjectDefaultPushResult(
  state: DaemonState,
  item: OutboxItem,
  appliedItem: NonNullable<SyncPushResponse["applied"]>[number],
  now: string
): boolean {
  const defaultPayload = projectDefaultRelationPayload(item);
  if (!defaultPayload) return false;
  const result = resultRecord(appliedItem.result);
  const resultProject = resultRecord(result?.project);
  const projectId = appliedItem.resourceId ?? asString(resultProject?.id) ?? defaultPayload.projectId;
  if (resultProject) {
    upsertRemoteResource(state.manifestStore, {
      domain: "projects",
      resourceId: projectId,
      version: appliedItem.version,
      payload: {
        ...resultProject,
        id: projectId,
        isUserDefault: true
      },
      updatedAt: remoteResourceUpdatedAt(resultProject, now),
      lastSyncedAt: now
    });
  }
  updateLocalProjectDefaultCache(state, projectId, now);
  return true;
}

export async function createLocalProject(state: DaemonState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${LOCAL_PROJECT_ID_PREFIX}${randomUUID()}`;
  const payload: Record<string, unknown> = {
    ...normalizeLocalProjectPayload(input),
    id
  };
  const now = new Date().toISOString();
  const outboxPath = projectOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local project was recreated through daemon facade; stale project operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "projects",
    action: "create",
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "projects",
    resourceId: id,
    payload,
    updatedAt: asString(payload.updatedAt) ?? now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function updateLocalProject(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "projects", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...normalizeLocalProjectPayload(input, existing),
    id
  };
  const outboxPath = projectOutboxPath(id);
  const action = isLocalProjectId(id) ? "create" : "update";
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local project was updated through daemon facade; stale project operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "projects",
    action,
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "projects",
    resourceId: id,
    version: asNumber(existing.version),
    payload,
    updatedAt: asString(payload.updatedAt) ?? now,
    lastSyncedAt: asString(existing.lastSyncedAt)
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function deleteLocalProject(state: DaemonState, id: string): Promise<boolean> {
  const existing = localRemoteDomainItem(state, "projects", id);
  if (!existing) return false;
  const now = new Date().toISOString();
  const outboxPath = projectOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local project was deleted through daemon facade; stale project operation was superseded.",
    now
  );
  supersedeOpenProjectDefaultForResource(
    state,
    id,
    "Local project was deleted before its default selection synced; stale default operation was superseded.",
    now
  );

  if (isLocalProjectId(id)) {
    removeRemoteResource(state.manifestStore, "projects", id);
  } else {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: outboxPath,
      domain: "projects",
      action: "delete",
      resourceId: id,
      payload: existing
    });
    markRemoteResourceDeleted(state.manifestStore, {
      domain: "projects",
      resourceId: id,
      version: asNumber(existing.version),
      payload: existing,
      deletedAt: now,
      lastSyncedAt: asString(existing.lastSyncedAt)
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return true;
}

export async function setLocalDefaultProject(state: DaemonState, projectId: string): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "projects", projectId);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const selected = updateLocalProjectDefaultCache(state, projectId, now) ?? {
    ...existing,
    isUserDefault: true
  };
  supersedeOpenOutboxForPath(
    state,
    projectDefaultOutboxPath(),
    () => true,
    "Local project default was changed through daemon facade; stale default operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectDefaultOutboxPath(),
    domain: "projects",
    action: "update",
    resourceId: projectId,
    payload: {
      relation: "default",
      projectId
    }
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return localProjectDefaultSelection(selected);
}

const LOCAL_CONTEXT_ID_PREFIX = "local-";
const PROJECT_MEMORY_KINDS = new Set(["decision", "fact", "preference", "pitfall", "observation"]);
const PROJECT_MEMORY_STATUSES = new Set(["active", "archived", "superseded"]);
const PROJECT_RELATION_TYPES = new Set(["related", "depends_on", "supports", "informs", "overlaps"]);
const PROJECT_RELATION_DIRECTIONS = new Set(["directed", "bidirectional"]);

export function projectContextOutboxPath(projectId: string, relation: string, itemId?: string): string {
  return `project_context/${projectId}/${relation}${itemId ? `/${itemId}` : ""}`;
}

export function invalidLocalProjectContextWrite(message: string): LocalProjectContextError {
  return new LocalProjectContextError(400, "INVALID_ARGUMENT", message);
}

export function pendingLocalProjectContextResource(id: string): never {
  throw new LocalProjectContextError(
    409,
    "LOCAL_PENDING_RESOURCE",
    `${id} was created offline and cannot be mutated until it has synced.`
  );
}

export async function finishLocalProjectContextWrite(state: DaemonState): Promise<void> {
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}

export async function updateLocalProjectBrief(
  state: DaemonState,
  projectId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const snapshot = requireWritableProjectContext(state.manifestStore, projectId);
  if (
    typeof input.contentMarkdown !== "string"
    || typeof input.expectedVersion !== "number"
    || !Number.isInteger(input.expectedVersion)
    || input.expectedVersion < 0
  ) {
    throw invalidLocalProjectContextWrite("contentMarkdown and a non-negative expectedVersion are required.");
  }
  const now = new Date().toISOString();
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectContextOutboxPath(projectId, "brief"),
    domain: PROJECT_CONTEXT_DOMAIN,
    action: "update",
    resourceId: projectId,
    payload: {
      relation: "brief",
      contentMarkdown: input.contentMarkdown,
      expectedVersion: input.expectedVersion
    }
  });
  const brief = echoLocalProjectBrief(state.manifestStore, projectId, {
    ...(snapshot.context.brief ?? {}),
    projectId,
    contentMarkdown: input.contentMarkdown,
    version: input.expectedVersion + 1,
    updatedByKind: "user",
    updatedAt: now
  });
  await finishLocalProjectContextWrite(state);
  return brief;
}

export async function createLocalProjectMemory(
  state: DaemonState,
  projectId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requireWritableProjectContext(state.manifestStore, projectId);
  if (!PROJECT_MEMORY_KINDS.has(asString(input.kind) ?? "") || !asString(input.bodyMarkdown)) {
    throw invalidLocalProjectContextWrite("A valid memory kind and non-empty bodyMarkdown are required.");
  }
  const now = new Date().toISOString();
  const id = `${LOCAL_CONTEXT_ID_PREFIX}${randomUUID()}`;
  const memory: Record<string, unknown> = {
    ...input,
    id,
    projectId,
    authority: asString(input.authority) ?? "user_confirmed",
    status: "active",
    lifecycleState: asString(input.lifecycleState) ?? "triaged",
    reviewAfter: input.reviewAfter ?? null,
    lastConfirmedAt: input.lastConfirmedAt ?? null,
    reviewReason: input.reviewReason ?? null,
    createdByKind: "user",
    createdAt: now,
    updatedAt: now
  };
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectContextOutboxPath(projectId, "memories", id),
    domain: PROJECT_CONTEXT_DOMAIN,
    action: "create",
    resourceId: projectId,
    payload: { ...input, relation: "memory" }
  });
  echoLocalProjectMemoryCreate(state.manifestStore, projectId, memory);
  await finishLocalProjectContextWrite(state);
  return memory;
}

export async function updateLocalProjectMemory(
  state: DaemonState,
  memoryId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (memoryId.startsWith(LOCAL_CONTEXT_ID_PREFIX)) pendingLocalProjectContextResource(memoryId);
  const found = findLocalProjectMemory(state.manifestStore, memoryId);
  if (!found) {
    throw new LocalProjectContextError(404, "PROJECT_MEMORY_NOT_FOUND", "Project memory not found in the local cache.");
  }
  const patch: Record<string, unknown> = {};
  if (input.bodyMarkdown !== undefined) {
    if (!asString(input.bodyMarkdown)) throw invalidLocalProjectContextWrite("bodyMarkdown must be non-empty when provided.");
    patch.bodyMarkdown = input.bodyMarkdown;
  }
  if (input.status !== undefined) {
    if (!PROJECT_MEMORY_STATUSES.has(asString(input.status) ?? "")) {
      throw invalidLocalProjectContextWrite("status must be active, archived, or superseded.");
    }
    patch.status = input.status;
  }
  if (Object.keys(patch).length === 0) {
    throw invalidLocalProjectContextWrite("A memory bodyMarkdown or status patch is required.");
  }
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectContextOutboxPath(found.projectId, "memories", memoryId),
    domain: PROJECT_CONTEXT_DOMAIN,
    action: "update",
    resourceId: found.projectId,
    payload: { relation: "memory", memoryId, patch: { ...input } }
  });
  const memory = echoLocalProjectMemoryPatch(
    state.manifestStore,
    found.projectId,
    memoryId,
    patch,
    new Date().toISOString()
  );
  await finishLocalProjectContextWrite(state);
  return memory;
}

export async function createLocalProjectRelation(
  state: DaemonState,
  projectId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requireWritableProjectContext(state.manifestStore, projectId);
  const targetProjectId = asString(input.targetProjectId);
  if (!targetProjectId || targetProjectId === projectId || !PROJECT_RELATION_TYPES.has(asString(input.relationType) ?? "")) {
    throw invalidLocalProjectContextWrite("A distinct targetProjectId and valid relationType are required.");
  }
  if (input.directionality !== undefined && !PROJECT_RELATION_DIRECTIONS.has(asString(input.directionality) ?? "")) {
    throw invalidLocalProjectContextWrite("directionality must be directed or bidirectional.");
  }
  const now = new Date().toISOString();
  const id = `${LOCAL_CONTEXT_ID_PREFIX}${randomUUID()}`;
  const relation: Record<string, unknown> = {
    ...input,
    id,
    sourceProjectId: projectId,
    targetProjectId,
    directionality: asString(input.directionality) ?? "directed",
    note: typeof input.note === "string" ? input.note : "",
    origin: "manual",
    createdByKind: "user",
    createdAt: now,
    updatedAt: now
  };
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectContextOutboxPath(projectId, "relations", id),
    domain: PROJECT_CONTEXT_DOMAIN,
    action: "create",
    resourceId: projectId,
    payload: { ...input, relation: "relation" }
  });
  echoLocalProjectRelationCreate(state.manifestStore, projectId, relation);
  await finishLocalProjectContextWrite(state);
  return relation;
}

export function localRelationPatch(input: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof input.expectedVersion !== "number"
    || !Number.isInteger(input.expectedVersion)
    || input.expectedVersion <= 0
  ) {
    throw invalidLocalProjectContextWrite("A positive expectedVersion is required.");
  }
  const patch: Record<string, unknown> = {};
  if (input.relationType !== undefined) {
    if (!PROJECT_RELATION_TYPES.has(asString(input.relationType) ?? "")) {
      throw invalidLocalProjectContextWrite("Invalid relationType.");
    }
    patch.relationType = input.relationType;
  }
  if (input.directionality !== undefined) {
    if (!PROJECT_RELATION_DIRECTIONS.has(asString(input.directionality) ?? "")) {
      throw invalidLocalProjectContextWrite("Invalid directionality.");
    }
    patch.directionality = input.directionality;
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") throw invalidLocalProjectContextWrite("note must be a string.");
    patch.note = input.note;
  }
  if (input.strength !== undefined) {
    if (input.strength !== null && (typeof input.strength !== "number" || input.strength < 0 || input.strength > 1)) {
      throw invalidLocalProjectContextWrite("strength must be null or a number from 0 to 1.");
    }
    patch.strength = input.strength;
  }
  if (Object.keys(patch).length === 0) throw invalidLocalProjectContextWrite("A relation patch is required.");
  return patch;
}

export async function updateLocalProjectRelation(
  state: DaemonState,
  relationId: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (relationId.startsWith(LOCAL_CONTEXT_ID_PREFIX)) pendingLocalProjectContextResource(relationId);
  const found = findLocalProjectRelation(state.manifestStore, relationId);
  if (!found) {
    throw new LocalProjectContextError(404, "PROJECT_RELATION_NOT_FOUND", "Project relation not found in the local cache.");
  }
  const patch = localRelationPatch(input);
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectContextOutboxPath(found.projectId, "relations", relationId),
    domain: PROJECT_CONTEXT_DOMAIN,
    action: "update",
    resourceId: found.projectId,
    payload: { relation: "relation", relationId, patch: { ...input } }
  });
  const result = echoLocalProjectRelationPatch(
    state.manifestStore,
    relationId,
    patch,
    new Date().toISOString()
  );
  await finishLocalProjectContextWrite(state);
  return result.relation;
}

export async function deleteLocalProjectRelation(state: DaemonState, relationId: string): Promise<void> {
  if (relationId.startsWith(LOCAL_CONTEXT_ID_PREFIX)) pendingLocalProjectContextResource(relationId);
  const found = findLocalProjectRelation(state.manifestStore, relationId);
  if (!found) {
    throw new LocalProjectContextError(404, "PROJECT_RELATION_NOT_FOUND", "Project relation not found in the local cache.");
  }
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: projectContextOutboxPath(found.projectId, "relations", relationId),
    domain: PROJECT_CONTEXT_DOMAIN,
    action: "delete",
    resourceId: found.projectId,
    payload: { relation: "relation", relationId }
  });
  echoLocalProjectRelationDelete(state.manifestStore, relationId);
  await finishLocalProjectContextWrite(state);
}
