import {
  listOpenOutboxForResource,
  listRemoteResources,
  markOutboxSuperseded,
  upsertRemoteResource,
  type OutboxItem
} from "./manifestStore.js";
import { asString } from "./localStore.js";
import type { DaemonState } from "./types.js";

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
