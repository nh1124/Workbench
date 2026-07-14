import { notesClient, projectsClient } from "./internalClients.js";
import { logger } from "./logger.js";
import {
  projectIdFromMutationResult,
  recordProjectContextInvalidationsBestEffort,
  type ProjectContextSyncSource
} from "./projectContextSync.js";
import { recordSyncEvent, type SyncEvent } from "./syncStore.js";

export const MAINTENANCE_FLAG_TARGET_TYPES = ["memory", "note"] as const;
export type MaintenanceFlagTargetType = (typeof MAINTENANCE_FLAG_TARGET_TYPES)[number];

export const MAINTENANCE_FLAG_REASONS = ["conflict", "manual"] as const;
export type MaintenanceFlagReason = (typeof MAINTENANCE_FLAG_REASONS)[number];

export type MaintenanceActionContext = {
  accessToken: string;
  userId: string;
  source: ProjectContextSyncSource;
};

export type MaintenanceFlagInput = {
  target: {
    type: MaintenanceFlagTargetType;
    id: string;
  };
  reason: MaintenanceFlagReason;
  note?: string;
};

export type MaintenanceActionClients = {
  projects: Pick<typeof projectsClient, "confirmMemory" | "snoozeMemory" | "flagMemory">;
  notes: Pick<typeof notesClient, "confirmNote" | "snoozeNote" | "flagNote">;
};

export type MaintenanceActionRecorders = {
  recordSyncEvent: typeof recordSyncEvent;
  recordProjectContextInvalidations: typeof recordProjectContextInvalidationsBestEffort;
};

const defaultClients: MaintenanceActionClients = {
  projects: projectsClient,
  notes: notesClient
};

const defaultRecorders: MaintenanceActionRecorders = {
  recordSyncEvent,
  recordProjectContextInvalidations: recordProjectContextInvalidationsBestEffort
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function recordNoteMutationBestEffort(
  context: MaintenanceActionContext,
  noteId: string,
  operation: "confirm" | "snooze" | "flag",
  patch: Record<string, unknown>,
  result: unknown,
  recorders: MaintenanceActionRecorders
): Promise<void> {
  try {
    await recorders.recordSyncEvent(context.userId, "notes", noteId, "update", {
      source: context.source,
      operation,
      patch,
      resource: asRecord(result)
    });
  } catch (error) {
    logger.warn("[sync] failed to record maintenance note event", {
      noteId,
      operation,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function recordMemoryInvalidationBestEffort(
  context: MaintenanceActionContext,
  memoryId: string,
  operation: "confirm" | "snooze" | "flag",
  result: unknown,
  extraPayload: Record<string, unknown>,
  recorders: MaintenanceActionRecorders
): Promise<void> {
  const projectId = projectIdFromMutationResult(result);
  if (!projectId) return;
  try {
    await recorders.recordProjectContextInvalidations(context.userId, [projectId], {
      changed: ["memory"],
      entityType: "memory",
      entityId: memoryId,
      source: context.source,
      action: "update",
      extraPayload: {
        operation,
        ...extraPayload,
        resource: asRecord(result)
      }
    });
  } catch (error) {
    logger.warn("[sync] failed to record maintenance memory invalidation", {
      memoryId,
      projectId,
      operation,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function confirmMaintenanceMemory(
  context: MaintenanceActionContext,
  memoryId: string,
  payload: { reviewAfter?: string | null },
  clients: MaintenanceActionClients = defaultClients,
  recorders: MaintenanceActionRecorders = defaultRecorders
): Promise<unknown> {
  const result = await clients.projects.confirmMemory(context.accessToken, memoryId, payload);
  await recordMemoryInvalidationBestEffort(context, memoryId, "confirm", result, { patch: payload }, recorders);
  return result;
}

export async function snoozeMaintenanceMemory(
  context: MaintenanceActionContext,
  memoryId: string,
  payload: { until: string },
  clients: MaintenanceActionClients = defaultClients,
  recorders: MaintenanceActionRecorders = defaultRecorders
): Promise<unknown> {
  const result = await clients.projects.snoozeMemory(context.accessToken, memoryId, payload);
  await recordMemoryInvalidationBestEffort(context, memoryId, "snooze", result, { patch: payload }, recorders);
  return result;
}

export async function confirmMaintenanceNote(
  context: MaintenanceActionContext,
  noteId: string,
  payload: { lifecycleState?: "curated" | "verified"; reviewAfter?: string | null },
  clients: MaintenanceActionClients = defaultClients,
  recorders: MaintenanceActionRecorders = defaultRecorders
): Promise<unknown> {
  const result = await clients.notes.confirmNote(context.accessToken, noteId, payload);
  await recordNoteMutationBestEffort(context, noteId, "confirm", payload, result, recorders);
  return result;
}

export async function snoozeMaintenanceNote(
  context: MaintenanceActionContext,
  noteId: string,
  payload: { until: string },
  clients: MaintenanceActionClients = defaultClients,
  recorders: MaintenanceActionRecorders = defaultRecorders
): Promise<unknown> {
  const result = await clients.notes.snoozeNote(context.accessToken, noteId, payload);
  await recordNoteMutationBestEffort(context, noteId, "snooze", payload, result, recorders);
  return result;
}

export async function flagMaintenanceTarget(
  context: MaintenanceActionContext,
  input: MaintenanceFlagInput,
  clients: MaintenanceActionClients = defaultClients,
  recorders: MaintenanceActionRecorders = defaultRecorders
): Promise<unknown> {
  const payload = {
    reason: input.reason,
    ...(input.note !== undefined ? { note: input.note } : {})
  };
  if (input.target.type === "memory") {
    const result = await clients.projects.flagMemory(context.accessToken, input.target.id, payload);
    await recordMemoryInvalidationBestEffort(context, input.target.id, "flag", result, payload, recorders);
    return result;
  }

  const result = await clients.notes.flagNote(context.accessToken, input.target.id, payload);
  await recordNoteMutationBestEffort(context, input.target.id, "flag", payload, result, recorders);
  return result;
}
