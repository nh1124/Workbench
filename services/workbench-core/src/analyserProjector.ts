import { getCorePool } from "./db.js";
import {
  analyserInternalClient,
  InternalServiceError,
  serviceBaseUrls,
  type AnalyserInternalEffectiveSettingsResult,
  type AnalyserInternalIngestResult
} from "./internalClients.js";
import { logger } from "./logger.js";
import { pullSyncChanges, type SyncChangesPullOptions, type SyncChangesPullResult } from "./syncChanges.js";
import {
  commitConsumerCursor,
  getConsumerState,
  initializeSyncConsumer,
  type SyncConsumerCursorCommit,
  type SyncConsumerInitializeResult,
  type SyncConsumerState
} from "./syncConsumerCursorsStore.js";
import { getLatestSyncCursor, type SyncEvent } from "./syncStore.js";

export const ANALYSER_PROJECTOR_CONSUMER = "analyser-projector";

type ProjectorPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};

type ProjectorLogger = {
  error(message: string, details?: Record<string, unknown>): void;
};

export interface AnalyserProjectorDeps {
  getEffectiveSettings(query: { coreUserId: string; machineId?: string }): Promise<AnalyserInternalEffectiveSettingsResult>;
  ingestObservations(body: {
    coreUserId: string;
    machineId?: string;
    observations: unknown[];
  }): Promise<AnalyserInternalIngestResult>;
  initializeSyncConsumer(
    userId: string,
    input: { consumer: unknown; startAt?: unknown; scope?: unknown }
  ): Promise<SyncConsumerInitializeResult>;
  getConsumerState(userId: string, consumerId: unknown): Promise<SyncConsumerState | undefined>;
  pullSyncChanges(userId: string, options?: SyncChangesPullOptions): Promise<SyncChangesPullResult>;
  commitConsumerCursor(userId: string, consumerId: unknown, cursor: unknown): Promise<SyncConsumerCursorCommit>;
  getLatestSyncCursor(userId: string): Promise<string>;
  pool: ProjectorPool;
  analyserBaseUrl?: string;
  logger: ProjectorLogger;
}

export type ProjectSyncEventsResult =
  | { projected: number; skipped: true }
  | { projected: number; duplicates: number; rejected: number; batches: number };

export interface ProjectSyncEventsOptions {
  batchSize?: number;
  maxBatches?: number;
  deps?: Partial<AnalyserProjectorDeps>;
}

function realDeps(): AnalyserProjectorDeps {
  return {
    getEffectiveSettings: analyserInternalClient.getEffectiveSettings,
    ingestObservations: analyserInternalClient.ingestObservations,
    initializeSyncConsumer,
    getConsumerState,
    pullSyncChanges,
    commitConsumerCursor,
    getLatestSyncCursor,
    pool: getCorePool(),
    analyserBaseUrl: serviceBaseUrls.analyser,
    logger
  };
}

function resolveDeps(overrides: Partial<AnalyserProjectorDeps> = {}): AnalyserProjectorDeps {
  return { ...realDeps(), ...overrides };
}

function clampPositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  const parsed = value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.trunc(value));
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function metadataForEvent(event: SyncEvent): Record<string, string | number> {
  return {
    domain: event.domain,
    action: event.action,
    ...(event.resourceType === undefined ? {} : { resourceType: event.resourceType }),
    ...(event.path === undefined ? {} : { path: event.path }),
    ...(event.previousPath === undefined ? {} : { previousPath: event.previousPath }),
    version: event.version
  };
}

function observationForEvent(event: SyncEvent): Record<string, unknown> {
  return {
    source: "workbench_change",
    action: `${event.domain}.${event.action}`,
    actorKind: "user",
    ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
    occurredAt: event.createdAt,
    resourceRefs: [{
      service: event.domain,
      resourceType: event.resourceType ?? event.domain,
      resourceId: event.resourceId,
      ...(event.path === undefined ? {} : { pathSnapshot: event.path })
    }],
    metadata: metadataForEvent(event),
    sourceEventId: event.cursor,
    dedupeKey: `workbench_change:${event.cursor}`
  };
}

function rejectedCount(rejected: Record<string, number>): number {
  return Object.values(rejected).reduce((total, count) => total + count, 0);
}

export async function projectSyncEventsForUser(
  userId: string,
  options: ProjectSyncEventsOptions = {}
): Promise<ProjectSyncEventsResult> {
  const deps = resolveDeps(options.deps);
  let settings: AnalyserInternalEffectiveSettingsResult;
  try {
    settings = await deps.getEffectiveSettings({ coreUserId: userId });
  } catch (error) {
    // The user has never touched Analyser (no service account yet); nothing to project.
    if (error instanceof InternalServiceError && error.status === 404) {
      return { projected: 0, skipped: true };
    }
    throw error;
  }
  if (settings.settings.workbenchChanges === "off") {
    const latestCursor = await deps.getLatestSyncCursor(userId);
    // Collection is disabled, so fail closed by permanently skipping events produced while off.
    await deps.commitConsumerCursor(userId, ANALYSER_PROJECTOR_CONSUMER, latestCursor);
    return { projected: 0, skipped: true };
  }

  const initialized = await deps.initializeSyncConsumer(userId, {
    consumer: ANALYSER_PROJECTOR_CONSUMER,
    startAt: "current"
  });
  const consumerState = await deps.getConsumerState(userId, ANALYSER_PROJECTOR_CONSUMER);
  let cursor = consumerState?.cursor ?? initialized.cursor;
  const batchSize = clampPositiveInteger(options.batchSize, 200, 500);
  const maxBatches = clampPositiveInteger(options.maxBatches, 5);
  let projected = 0;
  let duplicates = 0;
  let rejected = 0;
  let batches = 0;

  for (let index = 0; index < maxBatches; index += 1) {
    const pulled = await deps.pullSyncChanges(userId, {
      consumer: ANALYSER_PROJECTOR_CONSUMER,
      cursor,
      limit: batchSize
    });
    if (pulled.events.length === 0) break;

    const observations = pulled.events.map(observationForEvent);
    const result = await deps.ingestObservations({ coreUserId: userId, observations });
    const lastCursor = pulled.events[pulled.events.length - 1].cursor;
    await deps.commitConsumerCursor(userId, ANALYSER_PROJECTOR_CONSUMER, lastCursor);

    projected += result.ingested;
    duplicates += result.duplicates;
    rejected += rejectedCount(result.rejected);
    batches += 1;
    cursor = lastCursor;
    if (pulled.events.length < batchSize) break;
  }

  return { projected, duplicates, rejected, batches };
}

export async function runAnalyserProjectorOnce(
  overrides: Partial<AnalyserProjectorDeps> = {}
): Promise<void> {
  const deps = resolveDeps(overrides);
  if (!deps.analyserBaseUrl) return;

  const result = await deps.pool.query<{ user_id: string }>(`
    SELECT DISTINCT user_id
    FROM sync_events
    ORDER BY user_id ASC
  `);
  for (const row of result.rows) {
    try {
      await projectSyncEventsForUser(row.user_id, { deps });
    } catch (error) {
      deps.logger.error("Analyser projector failed for user", {
        userId: row.user_id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function startAnalyserProjector(
  intervalMs = 60_000,
  overrides: Partial<AnalyserProjectorDeps> = {}
): () => void {
  const deps = resolveDeps(overrides);
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runAnalyserProjectorOnce(deps).catch((error: unknown) => {
      deps.logger.error("Analyser projector tick failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => {
      inFlight = false;
    });
  }, clampPositiveInteger(intervalMs, 60_000));
  timer.unref?.();
  return () => clearInterval(timer);
}
