import type { DaemonConfig } from "./config.js";
import {
  artifactKindForPath,
  relativeSyncPath,
  sanitizeFileName
} from "./paths.js";
import {
  coreJson,
  downloadJobFile
} from "./coreClient.js";
import {
  recordLocalJob,
  upsertResource as upsertManifestResource,
  writeManifestDebugSnapshot
} from "./manifestStore.js";
import type {
  DaemonState,
  LocalJob,
  PendingLocalJobConfirmation
} from "./types.js";

async function completeJob(state: DaemonState, job: LocalJob, result: Record<string, unknown>): Promise<void> {
  if (!state.identity) return;
  await coreJson(state.config, `/api/local-jobs/${encodeURIComponent(job.id)}/complete`, {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result })
  });
}

async function failJob(state: DaemonState, job: LocalJob, error: unknown): Promise<void> {
  if (!state.identity) return;
  const message = error instanceof Error ? error.message : String(error);
  await coreJson(state.config, `/api/local-jobs/${encodeURIComponent(job.id)}/fail`, {
    method: "POST",
    localIdentity: state.identity,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message })
  });
}

export function pendingJobConfirmations(state: DaemonState): Map<string, PendingLocalJobConfirmation> {
  if (!state.pendingJobConfirmations) {
    state.pendingJobConfirmations = new Map();
  }
  return state.pendingJobConfirmations;
}

export function localJobRequiresConfirmation(config: DaemonConfig, job: LocalJob): boolean {
  const policy = config.localJobConfirmationPolicy ?? "off";
  if (policy === "off") return false;
  if (policy === "all") return true;
  return job.target === "downloads";
}

function localJobConfirmationReason(job: LocalJob): string {
  if (job.target === "downloads") {
    return "This job saves a file to the configured downloads folder.";
  }
  return "This job saves a file on this device.";
}

function destinationRootForLocalJob(config: DaemonConfig, job: LocalJob): string {
  return job.target === "sync-folder" ? config.syncRoot : config.downloadsDir;
}

function pendingLocalJobConfirmationPayload(
  state: DaemonState,
  pending: PendingLocalJobConfirmation
): Record<string, unknown> {
  const requestedFilename = typeof pending.job.payload.filename === "string"
    ? sanitizeFileName(pending.job.payload.filename)
    : undefined;
  return {
    jobId: pending.job.id,
    kind: pending.job.kind,
    target: pending.job.target,
    status: "pending_confirmation",
    requestedAt: pending.requestedAt,
    reason: pending.reason,
    destinationRoot: destinationRootForLocalJob(state.config, pending.job),
    requestedFilename,
    payload: {
      artifactItemId: typeof pending.job.payload.artifactItemId === "string" ? pending.job.payload.artifactItemId : undefined,
      taskId: typeof pending.job.payload.taskId === "string" ? pending.job.payload.taskId : undefined,
      attachmentId: typeof pending.job.payload.attachmentId === "string" ? pending.job.payload.attachmentId : undefined,
      domain: typeof pending.job.payload.domain === "string" ? pending.job.payload.domain : undefined,
      filename: typeof pending.job.payload.filename === "string" ? pending.job.payload.filename : undefined
    }
  };
}

export function listPendingLocalJobConfirmations(state: DaemonState): Record<string, unknown>[] {
  return [...pendingJobConfirmations(state).values()]
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
    .map((pending) => pendingLocalJobConfirmationPayload(state, pending));
}

function queueLocalJobConfirmation(state: DaemonState, job: LocalJob): void {
  const pending = pendingJobConfirmations(state);
  if (pending.has(job.id)) {
    return;
  }
  pending.set(job.id, {
    job,
    requestedAt: new Date().toISOString(),
    reason: localJobConfirmationReason(job)
  });
}

async function recordManifestJob(state: DaemonState, job: LocalJob, result: Record<string, unknown>): Promise<void> {
  const completedAt = new Date().toISOString();
  recordLocalJob(state.manifestStore, {
    jobId: job.id,
    kind: job.kind,
    target: job.target,
    result,
    completedAt
  });

  const localPath = typeof result.localPath === "string" ? result.localPath : undefined;
  const relativePath = localPath && job.target === "sync-folder" ? relativeSyncPath(state.config, localPath) : undefined;
  if (relativePath) {
    upsertManifestResource(state.manifestStore, {
      relativePath,
      domain: "artifacts",
      kind: artifactKindForPath(relativePath),
      resourceId: typeof job.payload.artifactItemId === "string"
        ? job.payload.artifactItemId
        : typeof job.payload.id === "string"
          ? job.payload.id
          : undefined,
      checksum: typeof result.checksum === "string" ? result.checksum : undefined,
      sizeBytes: typeof result.sizeBytes === "number" ? result.sizeBytes : undefined,
      dirty: false,
      lastSeenAt: completedAt,
      lastSyncedAt: completedAt
    });
  }

  await writeManifestDebugSnapshot(state.config.syncRoot, state.manifestStore);
}

export async function processJob(
  state: DaemonState,
  job: LocalJob,
  options: { skipConfirmation?: boolean } = {}
): Promise<Record<string, unknown> | undefined> {
  if (!options.skipConfirmation && localJobRequiresConfirmation(state.config, job)) {
    queueLocalJobConfirmation(state, job);
    return undefined;
  }

  try {
    if (job.kind !== "download_artifact" && job.kind !== "download_task_attachment" && job.kind !== "materialize_resource") {
      throw new Error(`Unsupported local job kind: ${job.kind}`);
    }
    const result = await downloadJobFile(state, job);
    await recordManifestJob(state, job, result);
    await completeJob(state, job, result);
    state.processedJobs += 1;
    return result;
  } catch (error) {
    await failJob(state, job, error);
    throw error;
  }
}

export async function approvePendingLocalJobConfirmation(
  state: DaemonState,
  jobId: string
): Promise<Record<string, unknown> | undefined> {
  const pending = pendingJobConfirmations(state).get(jobId);
  if (!pending) {
    return undefined;
  }
  pendingJobConfirmations(state).delete(jobId);
  return processJob(state, pending.job, { skipConfirmation: true });
}

export async function rejectPendingLocalJobConfirmation(
  state: DaemonState,
  jobId: string,
  reason?: string
): Promise<boolean> {
  const pending = pendingJobConfirmations(state).get(jobId);
  if (!pending) {
    return false;
  }
  pendingJobConfirmations(state).delete(jobId);
  await failJob(state, pending.job, new Error(reason?.trim() || "Local job rejected by user confirmation policy."));
  return true;
}
