import { logger } from "./logger.js";
import {
  recordSyncEvent,
  type SyncAction,
  type SyncDomain,
  type SyncEvent,
  type SyncEventMetadata
} from "./syncStore.js";

type JsonRecord = Record<string, unknown>;

export const PROJECT_CONTEXT_SYNC_SCHEMA_VERSION = 1;
export const SYNC_SUPPORTED_DOMAINS: SyncDomain[] = [
  "projects",
  "notes",
  "artifacts",
  "tasks",
  "project_context"
];

export const PROJECT_CONTEXT_CHANGED_VALUES = [
  "project",
  "brief",
  "memory",
  "relation",
  "link",
  "summary",
  "index",
  "membership"
] as const;

export type ProjectContextChanged = (typeof PROJECT_CONTEXT_CHANGED_VALUES)[number];
export type ProjectContextSyncSource = "core-api" | "core-mcp" | "sync-push";

export type ProjectContextInvalidationInput = {
  projectId: string;
  changed: ProjectContextChanged[];
  entityType: ProjectContextChanged;
  entityId: string;
  source: ProjectContextSyncSource;
  action?: Extract<SyncAction, "update" | "delete">;
  extraPayload?: JsonRecord;
};

type SyncEventRecorder = (
  userId: string,
  domain: SyncDomain,
  resourceId: string,
  action: SyncAction,
  payload: JsonRecord,
  metadata?: SyncEventMetadata
) => Promise<SyncEvent>;

export class ProjectContextSyncError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function buildProjectContextInvalidationPayload(input: ProjectContextInvalidationInput): JsonRecord {
  return {
    schemaVersion: PROJECT_CONTEXT_SYNC_SCHEMA_VERSION,
    kind: "invalidate",
    projectId: input.projectId,
    changed: [...new Set(input.changed)],
    entityType: input.entityType,
    entityId: input.entityId,
    source: input.source,
    ...(input.extraPayload ?? {})
  };
}

export async function recordProjectContextInvalidation(
  userId: string,
  input: ProjectContextInvalidationInput,
  recorder: SyncEventRecorder = recordSyncEvent
): Promise<SyncEvent> {
  return recorder(
    userId,
    "project_context",
    input.projectId,
    input.action ?? "update",
    buildProjectContextInvalidationPayload(input),
    { projectId: input.projectId, resourceType: "project_context" }
  );
}

export async function recordProjectContextInvalidationsBestEffort(
  userId: string,
  projectIds: Array<string | undefined>,
  input: Omit<ProjectContextInvalidationInput, "projectId">,
  recorder: SyncEventRecorder = recordSyncEvent
): Promise<void> {
  const ids = [...new Set(projectIds.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  await Promise.all(ids.map(async (projectId) => {
    try {
      await recordProjectContextInvalidation(userId, { ...input, projectId }, recorder);
    } catch (error) {
      logger.warn("[sync] failed to record Project context invalidation", {
        projectId,
        changed: input.changed,
        entityType: input.entityType,
        entityId: input.entityId,
        source: input.source,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }));
}

export function parseProjectContextBaselineCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ProjectContextSyncError(400, "SYNC_BASELINE_CURSOR_INVALID", "baselineCursor must be a non-negative integer cursor.");
  }
  return value;
}

export function projectContextSnapshotPage(value: unknown): { items: JsonRecord[]; nextCursor?: string } {
  const page = asRecord(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(page.items)) {
    throw new ProjectContextSyncError(
      502,
      "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE",
      "Projects service returned an invalid Project snapshot page."
    );
  }
  const items = page.items.map((item) => {
    const record = asRecord(item);
    if (Object.keys(record).length === 0) {
      throw new ProjectContextSyncError(
        502,
        "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE",
        "Projects service returned an invalid Project snapshot page item."
      );
    }
    return record;
  });
  let nextCursor: string | undefined;
  if (page.nextCursor !== undefined) {
    if (
      typeof page.nextCursor !== "string"
      || page.nextCursor.length === 0
      || page.nextCursor.trim() !== page.nextCursor
    ) {
      throw new ProjectContextSyncError(
        502,
        "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE",
        "Projects service returned an invalid Project snapshot cursor."
      );
    }
    nextCursor = page.nextCursor;
  }
  return {
    items,
    nextCursor
  };
}

export function buildProjectContextSyncItem(
  value: unknown,
  baselineCursor: string,
  fetchedAt: string
): JsonRecord {
  const snapshot = asRecord(value);
  const projectId = asNonEmptyString(snapshot.projectId);
  const project = asRecord(snapshot.project);
  const memories = Array.isArray(snapshot.memories) ? snapshot.memories : undefined;
  const relations = Array.isArray(snapshot.relations) ? snapshot.relations : undefined;
  const counts = asRecord(snapshot.counts);
  const memoryCount = asNonNegativeInteger(counts.memories);
  const relationCount = asNonNegativeInteger(counts.relations);

  if (
    !projectId
    || snapshot.complete !== true
    || asNonEmptyString(project.id) !== projectId
    || !memories
    || !relations
    || memoryCount === undefined
    || relationCount === undefined
    || memories.length !== memoryCount
    || relations.length !== relationCount
  ) {
    throw new ProjectContextSyncError(
      502,
      "INVALID_PROJECT_CONTEXT_SYNC_RESPONSE",
      "Projects service returned an incomplete or invalid Project context sync item."
    );
  }

  return {
    schemaVersion: PROJECT_CONTEXT_SYNC_SCHEMA_VERSION,
    projectId,
    fetchedAt,
    baselineCursor,
    complete: true,
    counts: {
      memories: memoryCount,
      relations: relationCount
    },
    context: {
      project,
      brief: snapshot.brief ?? null,
      memories,
      relations
    }
  };
}

export function projectContextEndpoints(value: unknown): { sourceProjectId?: string; targetProjectId?: string; id?: string } {
  const relation = asRecord(value);
  return {
    sourceProjectId: asNonEmptyString(relation.sourceProjectId),
    targetProjectId: asNonEmptyString(relation.targetProjectId),
    id: asNonEmptyString(relation.id)
  };
}

export function requireProjectContextEndpoints(value: unknown): {
  sourceProjectId: string;
  targetProjectId: string;
  id: string;
} {
  const endpoints = projectContextEndpoints(value);
  if (!endpoints.sourceProjectId || !endpoints.targetProjectId || !endpoints.id) {
    throw new ProjectContextSyncError(
      502,
      "INVALID_PROJECT_RELATION_RESPONSE",
      "Projects service returned a relation without both Project endpoints."
    );
  }
  return endpoints as { sourceProjectId: string; targetProjectId: string; id: string };
}

export function projectIdFromMutationResult(value: unknown): string | undefined {
  return asNonEmptyString(asRecord(value).projectId);
}
