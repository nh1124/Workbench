import { randomUUID } from "node:crypto";
import { ensureCoreSchema, getCorePool } from "../db.js";
import type {
  DeepResearchArtifactRef,
  DeepResearchEventLog,
  DeepResearchJobRecord,
  DeepResearchJobStatus,
  DeepResearchProgress
} from "./types.js";

type DeepResearchJobRow = {
  id: string;
  user_id: string;
  status: string;
  query: string;
  provider: string;
  model: string;
  speed: string;
  timeout_sec: number;
  async_on_timeout: boolean;
  save_to_artifacts: boolean;
  artifact_title: string | null;
  artifact_path: string | null;
  artifact_item_id: string | null;
  artifact_item_path: string | null;
  result_markdown: string | null;
  error_message: string | null;
  progress_json: unknown;
  metadata_json: unknown;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

function normalizeStatus(status: string): DeepResearchJobStatus {
  if (status === "running" || status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "failed";
}

function normalizeProgress(raw: unknown): DeepResearchProgress {
  if (!raw || typeof raw !== "object") {
    return {
      stage: "queued",
      percent: 0,
      message: "Queued"
    };
  }

  const value = raw as { stage?: unknown; percent?: unknown; message?: unknown };
  const stage = typeof value.stage === "string" ? value.stage : "queued";
  const percentValue = typeof value.percent === "number" ? value.percent : Number(value.percent);
  return {
    stage:
      stage === "queued" ||
      stage === "running" ||
      stage === "saving_artifact" ||
      stage === "completed" ||
      stage === "failed" ||
      stage === "cancelled"
        ? stage
        : "queued",
    percent: Number.isFinite(percentValue) ? Math.max(0, Math.min(100, percentValue)) : 0,
    message: typeof value.message === "string" && value.message.trim().length > 0 ? value.message : "Queued"
  };
}

function normalizeMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function toJobRecord(row: DeepResearchJobRow): DeepResearchJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: normalizeStatus(row.status),
    query: row.query,
    provider: row.provider as DeepResearchJobRecord["provider"],
    model: row.model,
    speed: row.speed as DeepResearchJobRecord["speed"],
    timeoutSec: row.timeout_sec,
    asyncOnTimeout: row.async_on_timeout,
    saveToArtifacts: row.save_to_artifacts,
    artifactTitle: row.artifact_title ?? undefined,
    artifactPath: row.artifact_path ?? undefined,
    artifactItemId: row.artifact_item_id ?? undefined,
    artifactItemPath: row.artifact_item_path ?? undefined,
    resultMarkdown: row.result_markdown ?? undefined,
    errorMessage: row.error_message ?? undefined,
    progress: normalizeProgress(row.progress_json),
    metadata: normalizeMetadata(row.metadata_json),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : undefined
  };
}

export async function createDeepResearchJob(input: {
  userId: string;
  query: string;
  provider: DeepResearchJobRecord["provider"];
  model: string;
  speed: DeepResearchJobRecord["speed"];
  timeoutSec: number;
  asyncOnTimeout: boolean;
  saveToArtifacts: boolean;
  artifactTitle?: string;
  artifactPath?: string;
  metadata?: Record<string, unknown>;
  progress?: DeepResearchProgress;
}): Promise<DeepResearchJobRecord> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const id = randomUUID();
  const progress = input.progress ?? {
    stage: "queued",
    percent: 0,
    message: "Queued"
  };
  const result = await pool.query<DeepResearchJobRow>(
    `
      INSERT INTO deep_research_jobs (
        id,
        user_id,
        status,
        query,
        provider,
        model,
        speed,
        timeout_sec,
        async_on_timeout,
        save_to_artifacts,
        artifact_title,
        artifact_path,
        progress_json,
        metadata_json,
        started_at,
        updated_at
      )
      VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, NOW(), NOW())
      RETURNING
        id, user_id, status, query, provider, model, speed, timeout_sec, async_on_timeout, save_to_artifacts,
        artifact_title, artifact_path, artifact_item_id, artifact_item_path, result_markdown, error_message,
        progress_json, metadata_json, created_at, updated_at, started_at, completed_at, cancelled_at
    `,
    [
      id,
      input.userId,
      input.query,
      input.provider,
      input.model,
      input.speed,
      input.timeoutSec,
      input.asyncOnTimeout,
      input.saveToArtifacts,
      input.artifactTitle ?? null,
      input.artifactPath ?? null,
      JSON.stringify(progress),
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return toJobRecord(result.rows[0]);
}

export async function getDeepResearchJob(userId: string, jobId: string): Promise<DeepResearchJobRecord | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<DeepResearchJobRow>(
    `
      SELECT
        id, user_id, status, query, provider, model, speed, timeout_sec, async_on_timeout, save_to_artifacts,
        artifact_title, artifact_path, artifact_item_id, artifact_item_path, result_markdown, error_message,
        progress_json, metadata_json, created_at, updated_at, started_at, completed_at, cancelled_at
      FROM deep_research_jobs
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [jobId, userId]
  );

  if (!result.rows[0]) {
    return undefined;
  }
  return toJobRecord(result.rows[0]);
}

export async function listDeepResearchJobs(userId: string, limit = 50): Promise<DeepResearchJobRecord[]> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const safeLimit = Math.max(1, Math.min(200, Math.round(limit)));
  const result = await pool.query<DeepResearchJobRow>(
    `
      SELECT
        id, user_id, status, query, provider, model, speed, timeout_sec, async_on_timeout, save_to_artifacts,
        artifact_title, artifact_path, artifact_item_id, artifact_item_path, result_markdown, error_message,
        progress_json, metadata_json, created_at, updated_at, started_at, completed_at, cancelled_at
      FROM deep_research_jobs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [userId, safeLimit]
  );

  return result.rows.map((row) => toJobRecord(row));
}

export async function updateDeepResearchJobProgress(
  userId: string,
  jobId: string,
  progress: DeepResearchProgress
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      UPDATE deep_research_jobs
      SET progress_json = $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'running'
    `,
    [jobId, userId, JSON.stringify(progress)]
  );
}

export async function completeDeepResearchJob(
  userId: string,
  jobId: string,
  result: {
    resultMarkdown: string;
    provider: DeepResearchJobRecord["provider"];
    model: string;
    speed: DeepResearchJobRecord["speed"];
    artifact?: DeepResearchArtifactRef;
    artifactSaveError?: string;
    progress?: DeepResearchProgress;
  }
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const progress = result.progress ?? {
    stage: "completed",
    percent: 100,
    message: "Completed"
  };

  const metadataPatch = result.artifactSaveError ? { artifactSaveError: result.artifactSaveError } : {};
  await pool.query(
    `
      UPDATE deep_research_jobs
      SET
        status = 'completed',
        provider = $3,
        model = $4,
        speed = $5,
        result_markdown = $6,
        artifact_item_id = $7,
        artifact_item_path = $8,
        progress_json = $9::jsonb,
        metadata_json = metadata_json || $10::jsonb,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'running'
    `,
    [
      jobId,
      userId,
      result.provider,
      result.model,
      result.speed,
      result.resultMarkdown,
      result.artifact?.id ?? null,
      result.artifact?.path ?? null,
      JSON.stringify(progress),
      JSON.stringify(metadataPatch)
    ]
  );
}

export async function failDeepResearchJob(
  userId: string,
  jobId: string,
  errorMessage: string
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      UPDATE deep_research_jobs
      SET
        status = 'failed',
        error_message = $3,
        progress_json = $4::jsonb,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'running'
    `,
    [
      jobId,
      userId,
      errorMessage,
      JSON.stringify({
        stage: "failed",
        percent: 100,
        message: "Failed"
      } satisfies DeepResearchProgress)
    ]
  );
}

export async function cancelDeepResearchJob(userId: string, jobId: string): Promise<boolean> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query(
    `
      UPDATE deep_research_jobs
      SET
        status = 'cancelled',
        progress_json = $3::jsonb,
        cancelled_at = NOW(),
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'running'
    `,
    [
      jobId,
      userId,
      JSON.stringify({
        stage: "cancelled",
        percent: 100,
        message: "Cancelled"
      } satisfies DeepResearchProgress)
    ]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function attachDeepResearchArtifact(
  userId: string,
  jobId: string,
  artifact: DeepResearchArtifactRef
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      UPDATE deep_research_jobs
      SET
        artifact_item_id = $3,
        artifact_item_path = $4,
        updated_at = NOW()
      WHERE id = $1 AND user_id = $2
    `,
    [jobId, userId, artifact.id, artifact.path]
  );
}

export async function mergeDeepResearchJobMetadata(
  userId: string,
  jobId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      UPDATE deep_research_jobs
      SET metadata_json = metadata_json || $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
    `,
    [jobId, userId, JSON.stringify(metadata)]
  );
}

export async function appendDeepResearchJobLog(
  userId: string,
  jobId: string,
  entry: DeepResearchEventLog
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      UPDATE deep_research_jobs
      SET
        metadata_json = jsonb_set(
          COALESCE(metadata_json, '{}'::jsonb),
          '{eventLogs}',
          COALESCE(metadata_json->'eventLogs', '[]'::jsonb) || $3::jsonb,
          true
        ),
        updated_at = NOW()
      WHERE id = $1 AND user_id = $2
    `,
    [jobId, userId, JSON.stringify([entry])]
  );
}
