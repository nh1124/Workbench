import type { OutboxItem } from "./manifestStore.js";

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

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
