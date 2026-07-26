import express from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { InternalServiceError } from "../internalClients.js";
import { logger } from "../logger.js";
import { LocalClientStoreError } from "../localClientsStore.js";
import { ProjectContextError } from "../projectContext.js";
import {
  ProjectContextSyncError,
  recordProjectContextInvalidationsBestEffort,
  type ProjectContextChanged
} from "../projectContextSync.js";
import {
  SyncConsumerScopeConflictError,
  SyncConsumerCursorInputError
} from "../syncConsumerCursorsStore.js";
import { SyncConsumerScopeMismatchError } from "../syncChanges.js";
import {
  recordSyncEvent,
  type SyncAction,
  type SyncDomain,
  type SyncEventMetadata
} from "../syncStore.js";

export const CLIENT_OP_ID_HEADER = "x-workbench-client-op-id";
export const facadeSyncDomains = new Set<SyncDomain>(["projects", "notes", "artifacts", "tasks"]);
export const syncRequestContext = new AsyncLocalStorage<{ clientOpId?: string }>();

export function respondInternalError(res: express.Response, error: unknown): express.Response {
  if (error instanceof SyncConsumerCursorInputError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }

  if (error instanceof LocalClientStoreError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }

  if (error instanceof InternalServiceError) {
    if (error.status >= 400 && error.status < 500) {
      try {
        const body = JSON.parse(error.body) as unknown;
        if (body && typeof body === "object") return res.status(error.status).json(body);
      } catch {
        // Preserve legacy message wrapping for non-JSON upstream errors.
      }
      return res.status(error.status).json({ message: error.body || error.message });
    }
    return res.status(502).json({ message: `[${error.service}] ${error.body || error.message}` });
  }

  if (error instanceof ProjectContextError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }

  if (error instanceof ProjectContextSyncError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }

  if (
    error instanceof SyncConsumerScopeConflictError
    || error instanceof SyncConsumerScopeMismatchError
  ) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }

  const message = error instanceof Error ? error.message : "Unexpected internal error";
  return res.status(500).json({ message });
}

export function objectId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id === "string" && id.trim().length > 0) return id;
  const nestedItem = (value as { item?: unknown }).item;
  if (nestedItem && typeof nestedItem === "object") {
    const nestedId = (nestedItem as { id?: unknown }).id;
    if (typeof nestedId === "string" && nestedId.trim().length > 0) return nestedId;
  }
  return undefined;
}

export function jsonRecordFromBuffer(buffer: Buffer): Record<string, unknown> {
  try {
    return asJsonRecord(JSON.parse(buffer.toString("utf8")));
  } catch {
    return {};
  }
}

export type LiveSyncEvent = {
  domain: SyncDomain;
  resourceId: string;
  action: SyncAction;
  ts: string;
};

type LiveSyncEventListener = (event: LiveSyncEvent) => void;
type LiveSyncSubscriber = {
  listener: LiveSyncEventListener;
  drop: () => void;
};

const MAX_SYNC_EVENT_LISTENERS_PER_USER = 10;
const syncEventEmitters = new Map<string, EventEmitter>();
const syncEventSubscribers = new Map<string, LiveSyncSubscriber[]>();

export const syncEventBroadcaster = {
  publish(userId: string, event: LiveSyncEvent): void {
    syncEventEmitters.get(userId)?.emit("sync", event);
  },

  subscribe(
    userId: string,
    listener: LiveSyncEventListener,
    drop: () => void = () => undefined
  ): () => void {
    const emitter = syncEventEmitters.get(userId) ?? new EventEmitter();
    const subscribers = syncEventSubscribers.get(userId) ?? [];
    syncEventEmitters.set(userId, emitter);
    syncEventSubscribers.set(userId, subscribers);

    while (subscribers.length >= MAX_SYNC_EVENT_LISTENERS_PER_USER) {
      const oldest = subscribers.shift();
      if (!oldest) break;
      emitter.off("sync", oldest.listener);
      oldest.drop();
    }

    const subscriber = { listener, drop };
    subscribers.push(subscriber);
    emitter.on("sync", listener);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      emitter.off("sync", listener);
      const currentSubscribers = syncEventSubscribers.get(userId);
      if (currentSubscribers) {
        const index = currentSubscribers.indexOf(subscriber);
        if (index >= 0) currentSubscribers.splice(index, 1);
      }
      if (emitter.listenerCount("sync") === 0) {
        syncEventEmitters.delete(userId);
        syncEventSubscribers.delete(userId);
      }
    };
  },

  listenerCount(userId: string): number {
    return syncEventEmitters.get(userId)?.listenerCount("sync") ?? 0;
  }
};

export async function recordSyncEventBestEffort(
  userId: string,
  domain: SyncDomain,
  resourceId: string | undefined,
  action: SyncAction,
  payload: Record<string, unknown> = {},
  metadata?: SyncEventMetadata
): Promise<void> {
  if (!resourceId) return;
  const clientOpId = facadeSyncDomains.has(domain) ? syncRequestContext.getStore()?.clientOpId : undefined;
  const pending = recordSyncEvent(userId, domain, resourceId, action, {
    ...payload,
    ...(clientOpId ? { clientOpId } : {})
  }, metadata)
    .then((event) => {
      syncEventBroadcaster.publish(userId, {
        domain: event.domain,
        resourceId: event.resourceId,
        action: event.action,
        ts: event.createdAt
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[sync] failed to record event", { domain, resourceId, action, message });
    });
  if (clientOpId) {
    await pending;
  } else {
    void pending;
  }
}

export async function invalidateProjectContextFromApi(
  userId: string,
  projectIds: Array<string | undefined>,
  changed: ProjectContextChanged | readonly ProjectContextChanged[],
  entityType: ProjectContextChanged,
  entityId: string,
  action: "update" | "delete" = "update"
): Promise<void> {
  await recordProjectContextInvalidationsBestEffort(userId, projectIds, {
    changed: Array.isArray(changed) ? [...changed] : [changed],
    entityType,
    entityId,
    source: "core-api",
    action
  });
}

export async function invalidateArtifactIndexFromApi(
  userId: string,
  projectIds: Array<string | undefined>,
  artifactItemId: string
): Promise<void> {
  await invalidateProjectContextFromApi(userId, projectIds, "index", "index", artifactItemId);
}

export function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function queryFlagEnabled(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(queryFlagEnabled);
  }
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function sha256Checksum(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}
