import { randomUUID } from "node:crypto";
import {
  markRemoteResourceDeleted,
  removeRemoteResource,
  upsertRemoteResource,
  writeManifestDebugSnapshot
} from "./manifestStore.js";
import {
  asNumber,
  asString,
  enqueueManifestOutbox,
  listLocalRemoteDomainItems,
  localProjectId,
  localProjectName,
  localRemoteDomainItem,
  refreshManifestStats,
  supersedeOpenOutboxForPath
} from "./localStore.js";
import type { DaemonState } from "./types.js";

export const LOCAL_NOTE_ID_PREFIX = "local-note-";

export function isLocalNoteId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_NOTE_ID_PREFIX);
}

export function noteOutboxPath(id: string): string {
  return `notes/${id}`;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizeLocalNotePayload(
  state: DaemonState,
  input: Record<string, unknown>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  const now = new Date().toISOString();
  const title = typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : typeof existing?.title === "string" && existing.title.trim()
      ? existing.title
      : "Untitled";
  const content = typeof input.content === "string"
    ? input.content
    : typeof existing?.content === "string"
      ? existing.content
      : "";
  const projectId = typeof input.projectId === "string" && input.projectId.trim()
    ? input.projectId.trim()
    : typeof existing?.projectId === "string" && existing.projectId.trim()
      ? existing.projectId
      : localProjectId(state);
  const projectName = typeof input.projectName === "string"
    ? input.projectName
    : typeof existing?.projectName === "string"
      ? existing.projectName
      : localProjectName(state);
  return {
    ...(existing ?? {}),
    title,
    content,
    projectId,
    projectName,
    tags: Array.isArray(input.tags) ? normalizeStringArray(input.tags) : normalizeStringArray(existing?.tags),
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : now,
    updatedAt: now
  };
}

export function localNoteProjectSummaries(state: DaemonState): Record<string, unknown>[] {
  const byProject = new Map<string, { projectId: string; projectName?: string; noteCount: number; latestUpdatedAt: string }>();
  for (const note of listLocalRemoteDomainItems(state, "notes")) {
    const projectId = typeof note.projectId === "string" && note.projectId.trim() ? note.projectId : localProjectId(state);
    const projectName = typeof note.projectName === "string" ? note.projectName : undefined;
    const updatedAt = typeof note.updatedAt === "string" ? note.updatedAt : new Date().toISOString();
    const existing = byProject.get(projectId);
    if (!existing) {
      byProject.set(projectId, { projectId, projectName, noteCount: 1, latestUpdatedAt: updatedAt });
    } else {
      existing.noteCount += 1;
      if (!existing.projectName && projectName) existing.projectName = projectName;
      if (existing.latestUpdatedAt < updatedAt) existing.latestUpdatedAt = updatedAt;
    }
  }
  return [...byProject.values()].sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));
}

export async function createLocalNote(state: DaemonState, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `${LOCAL_NOTE_ID_PREFIX}${randomUUID()}`;
  const payload: Record<string, unknown> = {
    ...normalizeLocalNotePayload(state, input),
    id
  };
  const now = new Date().toISOString();
  const outboxPath = noteOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local note was recreated through daemon facade; stale note operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "notes",
    action: "create",
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "notes",
    resourceId: id,
    payload,
    updatedAt: asString(payload.updatedAt) ?? now
  });
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
  return payload;
}

export async function updateLocalNote(
  state: DaemonState,
  id: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const existing = localRemoteDomainItem(state, "notes", id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ...normalizeLocalNotePayload(state, input, existing),
    id
  };
  const outboxPath = noteOutboxPath(id);
  const action = isLocalNoteId(id) ? "create" : "update";
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local note was updated through daemon facade; stale note operation was superseded.",
    now
  );
  enqueueManifestOutbox(state.manifestStore, {
    relativePath: outboxPath,
    domain: "notes",
    action,
    resourceId: id,
    payload
  });
  upsertRemoteResource(state.manifestStore, {
    domain: "notes",
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

export async function deleteLocalNote(state: DaemonState, id: string): Promise<boolean> {
  const existing = localRemoteDomainItem(state, "notes", id);
  if (!existing) return false;
  const now = new Date().toISOString();
  const outboxPath = noteOutboxPath(id);
  supersedeOpenOutboxForPath(
    state,
    outboxPath,
    () => true,
    "Local note was deleted through daemon facade; stale note operation was superseded.",
    now
  );

  if (isLocalNoteId(id)) {
    removeRemoteResource(state.manifestStore, "notes", id);
  } else {
    enqueueManifestOutbox(state.manifestStore, {
      relativePath: outboxPath,
      domain: "notes",
      action: "delete",
      resourceId: id,
      payload: existing
    });
    markRemoteResourceDeleted(state.manifestStore, {
      domain: "notes",
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
