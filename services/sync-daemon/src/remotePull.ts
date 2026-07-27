import {
  getMeta,
  markRemoteResourceDeleted,
  setMeta,
  writeManifestDebugSnapshot
} from "./manifestStore.js";
import { asRecord, asString, refreshManifestStats } from "./localStore.js";
import {
  PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY,
  PROJECT_CONTEXT_DOMAIN,
  PROJECT_CONTEXT_SCHEMA_VERSION,
  PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY,
  PROJECT_CONTEXT_SUPPORTED_META_KEY
} from "./projectContextCache.js";
import {
  REMOTE_ARTIFACT_CURSOR_META_KEY,
  REMOTE_SYNC_CURSOR_META_KEY,
  REMOTE_SYNC_DOMAINS,
  applyRemoteArtifactEvent,
  applyRemoteDomainEvent,
  applyRemoteSnapshot,
  bootstrapPagedDomainSnapshots,
  bootstrapProjectContextSnapshot,
  fetchProjectContextDetail,
  getSyncPullPage,
  getSyncSnapshot,
  isRemoteResourceTombstone,
  projectContextEventIsStale,
  snapshotSupportsProjectContext
} from "./remoteSync.js";
import { scheduleTick } from "./tickScheduler.js";
import type { DaemonState, RemoteSyncEvent, SyncSnapshotResponse } from "./types.js";

/**
 * Pulls remote sync state and applies it locally.
 *
 * This was the last cluster stuck in index.ts. It could not move while it
 * called index.ts's own scheduleTick — that closed a cycle back through the
 * tick. With the scheduler in its own module the dependency runs one way, and
 * everything else this needs already lived in a module.
 */

export const REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY = "remoteArtifactSnapshotComplete";
const LAST_REMOTE_PULL_AT_META_KEY = "lastRemotePullAt";
const REMOTE_PULL_LIMIT = 100;
const REMOTE_CURSOR_DRAIN_LIMIT = 500;

function markProjectContextRescanRequired(state: DaemonState): void {
  setMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY, undefined);
  setMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  if (state.tickRunning) {
    state.tickQueued = true;
  } else {
    scheduleTick(state, 0);
  }
}

async function applyRemoteProjectContextEvent(state: DaemonState, event: RemoteSyncEvent): Promise<void> {
  if (event.domain !== PROJECT_CONTEXT_DOMAIN) return;
  const projectId = event.resourceId;
  if (!projectId || projectContextEventIsStale(state, event)) return;
  const payload = asRecord(event.payload) ?? {};
  if (asString(payload.localClientId) === state.identity?.localClientId) return;
  const createdAt = asString(event.createdAt) ?? new Date().toISOString();

  if (isRemoteResourceTombstone(event)) {
    markRemoteResourceDeleted(state.manifestStore, {
      domain: PROJECT_CONTEXT_DOMAIN,
      resourceId: projectId,
      version: event.version,
      payload,
      deletedAt: createdAt,
      lastSyncedAt: createdAt
    });
    return;
  }

  if (payload.schemaVersion !== PROJECT_CONTEXT_SCHEMA_VERSION) {
    markProjectContextRescanRequired(state);
    return;
  }
  if (payload.kind !== "invalidate") return;
  if (asString(payload.projectId) !== projectId) {
    markProjectContextRescanRequired(state);
    return;
  }
  await fetchProjectContextDetail(state, projectId, event.version);
}

async function applyRemoteSyncEvent(state: DaemonState, event: RemoteSyncEvent): Promise<void> {
  if (event.domain === PROJECT_CONTEXT_DOMAIN) {
    await applyRemoteProjectContextEvent(state, event);
    return;
  }
  if (event.domain === "artifacts") {
    await applyRemoteArtifactEvent(state, event);
    return;
  }
  applyRemoteDomainEvent(state, event);
}

async function bootstrapRemoteArtifactSnapshot(state: DaemonState): Promise<string | undefined> {
  if (!state.identity) throw new Error("Missing local client identity");
  let snapshot: SyncSnapshotResponse;
  let fullSnapshotAvailable = true;
  try {
    snapshot = await getSyncSnapshot(state, REMOTE_SYNC_DOMAINS);
  } catch (error) {
    fullSnapshotAvailable = false;
    console.warn(
      `[sync-daemon] all-domain remote snapshot failed; falling back to artifacts-only snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    snapshot = await getSyncSnapshot(state, ["artifacts"]);
  }
  const generatedAt = asString(snapshot.generatedAt) ?? new Date().toISOString();
  await applyRemoteSnapshot(state, snapshot, generatedAt);
  await bootstrapPagedDomainSnapshots(state, snapshot, generatedAt);

  let contextBaselineCursor: string | undefined;
  if (fullSnapshotAvailable && snapshotSupportsProjectContext(snapshot)) {
    const contextBootstrap = await bootstrapProjectContextSnapshot(state, asString(snapshot.baselineCursor));
    contextBaselineCursor = contextBootstrap.supported ? contextBootstrap.baselineCursor : undefined;
  } else if (fullSnapshotAvailable) {
    setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, "0");
  }

  const snapshotBaselineCursor = asString(snapshot.baselineCursor);
  let cursor: string | undefined = contextBaselineCursor ?? snapshotBaselineCursor;
  const drainFromBaseline = cursor !== undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await getSyncPullPage(state, cursor, REMOTE_CURSOR_DRAIN_LIMIT);
    const events = page.events ?? [];
    for (const event of events) {
      if (drainFromBaseline) {
        await applyRemoteSyncEvent(state, event);
      } else {
        const eventTime = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
        if (Number.isFinite(eventTime) && eventTime > Date.parse(generatedAt)) {
          await applyRemoteSyncEvent(state, event);
        }
      }
    }
    if (!page.nextCursor || page.nextCursor === cursor) {
      return cursor ?? "0";
    }
    cursor = page.nextCursor;
    if (events.length < REMOTE_CURSOR_DRAIN_LIMIT) {
      return cursor;
    }
  }
  return cursor ?? "0";
}

export async function pullRemoteArtifactSyncState(state: DaemonState): Promise<void> {
  if (!state.identity) return;
  let cursor = getMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY)
    ?? getMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY)
    ?? state.remoteArtifactCursor;
  const snapshotComplete = getMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY) === "1";
  const contextSupported = getMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY);
  const contextSnapshotComplete = getMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY) === "1";
  const contextBootstrapRequired = contextSupported === undefined
    || (contextSupported === "1" && !contextSnapshotComplete);
  if (!cursor || !snapshotComplete || contextBootstrapRequired) {
    cursor = await bootstrapRemoteArtifactSnapshot(state);
    setMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY, "1");
  } else {
    const page = await getSyncPullPage(state, cursor, REMOTE_PULL_LIMIT);
    for (const event of page.events ?? []) {
      await applyRemoteSyncEvent(state, event);
    }
    cursor = page.nextCursor ?? cursor;
  }

  const now = new Date().toISOString();
  setMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY, cursor ?? "0");
  setMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY, cursor ?? "0");
  setMeta(state.manifestStore, LAST_REMOTE_PULL_AT_META_KEY, now);
  state.remoteArtifactCursor = cursor ?? "0";
  state.lastRemotePullAt = now;
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}

export async function requestRemoteSnapshotRescan(state: DaemonState): Promise<void> {
  setMeta(state.manifestStore, REMOTE_SYNC_CURSOR_META_KEY, undefined);
  setMeta(state.manifestStore, REMOTE_ARTIFACT_CURSOR_META_KEY, undefined);
  setMeta(state.manifestStore, REMOTE_ARTIFACT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_SUPPORTED_META_KEY, undefined);
  setMeta(state.manifestStore, PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY, undefined);
  state.remoteArtifactCursor = undefined;
  scheduleTick(state, 0);
  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
  await refreshManifestStats(state);
}
