import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ensureCoreSchema, getCorePool } from "./db.js";

export type LocalJobKind = "download_artifact" | "download_task_attachment" | "materialize_resource";
export type LocalJobTarget = "downloads" | "sync-folder";
export type LocalJobStatus = "pending" | "running" | "completed" | "failed";
export type LocalJobEventType = "created" | "claimed" | "completed" | "failed" | "retry_scheduled" | "expired";

export class LocalClientStoreError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface LocalClient {
  id: string;
  userId: string;
  deviceId: string;
  clientName: string;
  platform: string;
  capabilities: Record<string, unknown>;
  syncRootId: string;
  syncRootLabel: string;
  enabled: boolean;
  default: boolean;
  createdAt: string;
  updatedAt: string;
  heartbeat?: {
    daemonVersion?: string;
    syncRootState: Record<string, unknown>;
    lastSeenAt: string;
    online: boolean;
  };
}

export interface LocalJob {
  id: string;
  userId: string;
  localClientId: string;
  idempotencyKey?: string;
  kind: LocalJobKind;
  target: LocalJobTarget;
  payload: Record<string, unknown>;
  status: LocalJobStatus;
  attempts: number;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  nextAttemptAt?: string;
  expiresAt?: string;
  result: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalJobEvent {
  id: string;
  jobId: string;
  userId: string;
  localClientId: string;
  eventType: LocalJobEventType;
  detail: Record<string, unknown>;
  createdAt: string;
}

type LocalClientRow = {
  id: string;
  user_id: string;
  device_id: string;
  client_name: string;
  platform: string;
  capabilities_json: unknown;
  sync_root_id: string;
  sync_root_label: string;
  is_enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  daemon_version: string | null;
  sync_root_state_json: unknown;
  last_seen_at: string | null;
};

type LocalJobRow = {
  id: string;
  user_id: string;
  local_client_id: string;
  idempotency_key: string | null;
  kind: string;
  target: string;
  payload_json: unknown;
  status: string;
  attempts: number;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  next_attempt_at: string | null;
  expires_at: string | null;
  result_json: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type LocalJobEventRow = {
  id: string;
  job_id: string;
  user_id: string;
  local_client_id: string;
  event_type: string;
  detail_json: unknown;
  created_at: string;
};

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const ACTIVE_IDEMPOTENCY_STATUSES = ["pending", "running", "completed"] as const;

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toIso(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function makeClientToken(): string {
  return `wblc_${randomBytes(32).toString("base64url")}`;
}

function toClient(row: LocalClientRow): LocalClient {
  const lastSeenAt = toIso(row.last_seen_at);
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    clientName: row.client_name,
    platform: row.platform,
    capabilities: jsonObject(row.capabilities_json),
    syncRootId: row.sync_root_id,
    syncRootLabel: row.sync_root_label,
    enabled: row.is_enabled,
    default: row.is_default,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    heartbeat: lastSeenAt
      ? {
          daemonVersion: row.daemon_version ?? undefined,
          syncRootState: jsonObject(row.sync_root_state_json),
          lastSeenAt,
          online: Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS
        }
      : undefined
  };
}

function toJob(row: LocalJobRow): LocalJob {
  return {
    id: row.id,
    userId: row.user_id,
    localClientId: row.local_client_id,
    idempotencyKey: row.idempotency_key ?? undefined,
    kind: row.kind as LocalJobKind,
    target: row.target as LocalJobTarget,
    payload: jsonObject(row.payload_json),
    status: row.status as LocalJobStatus,
    attempts: row.attempts,
    claimedAt: toIso(row.claimed_at),
    completedAt: toIso(row.completed_at),
    failedAt: toIso(row.failed_at),
    nextAttemptAt: toIso(row.next_attempt_at),
    expiresAt: toIso(row.expires_at),
    result: jsonObject(row.result_json),
    errorMessage: row.error_message ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toJobEvent(row: LocalJobEventRow): LocalJobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    localClientId: row.local_client_id,
    eventType: row.event_type as LocalJobEventType,
    detail: jsonObject(row.detail_json),
    createdAt: new Date(row.created_at).toISOString()
  };
}

async function recordLocalJobEvent(
  pool: Pool | PoolClient,
  job: { id: string; userId: string; localClientId: string },
  eventType: LocalJobEventType,
  detail: Record<string, unknown> = {}
): Promise<void> {
  await pool.query(
    `
      INSERT INTO local_job_events (job_id, user_id, local_client_id, event_type, detail_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [job.id, job.userId, job.localClientId, eventType, JSON.stringify(detail)]
  );
}

async function markExpiredLocalJobsForUser(userId: string): Promise<void> {
  const pool = getCorePool();
  await pool.query(
    `
      WITH expired AS (
        UPDATE local_jobs
        SET
          status = 'failed',
          failed_at = NOW(),
          next_attempt_at = NULL,
          error_message = COALESCE(error_message, 'expired'),
          updated_at = NOW()
        WHERE user_id = $1
          AND status IN ('pending', 'running')
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING id, user_id, local_client_id
      )
      INSERT INTO local_job_events (job_id, user_id, local_client_id, event_type, detail_json)
      SELECT id, user_id, local_client_id, 'expired', jsonb_build_object('reason', 'expired')
      FROM expired
    `,
    [userId]
  );
}

async function markExpiredLocalJobsForClient(localClientId: string): Promise<void> {
  const pool = getCorePool();
  await pool.query(
    `
      WITH expired AS (
        UPDATE local_jobs
        SET
          status = 'failed',
          failed_at = NOW(),
          next_attempt_at = NULL,
          error_message = COALESCE(error_message, 'expired'),
          updated_at = NOW()
        WHERE local_client_id = $1
          AND status IN ('pending', 'running')
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING id, user_id, local_client_id
      )
      INSERT INTO local_job_events (job_id, user_id, local_client_id, event_type, detail_json)
      SELECT id, user_id, local_client_id, 'expired', jsonb_build_object('reason', 'expired')
      FROM expired
    `,
    [localClientId]
  );
}

async function readClientById(userId: string, id: string): Promise<LocalClient | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalClientRow>(
    `
      SELECT
        c.id, c.user_id, c.device_id, c.client_name, c.platform, c.capabilities_json,
        c.sync_root_id, c.sync_root_label, c.is_enabled, c.is_default, c.created_at, c.updated_at,
        h.daemon_version, h.sync_root_state_json, h.last_seen_at
      FROM local_clients c
      LEFT JOIN local_client_heartbeats h ON h.local_client_id = c.id
      WHERE c.user_id = $1 AND c.id = $2
      LIMIT 1
    `,
    [userId, id]
  );
  return result.rows[0] ? toClient(result.rows[0]) : undefined;
}

export async function registerLocalClient(
  userId: string,
  input: {
    deviceId: string;
    clientName: string;
    platform: string;
    capabilities?: Record<string, unknown>;
    syncRootId?: string;
    syncRootLabel?: string;
    default?: boolean;
  }
): Promise<{ client: LocalClient; clientToken: string }> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const id = randomUUID();
  const tokenId = randomUUID();
  const clientToken = makeClientToken();
  const syncRootId = input.syncRootId?.trim() || "default";
  const syncRootLabel = input.syncRootLabel?.trim() || "Workbench Sync";
  const makeDefault = input.default === true;

  await pool.query("BEGIN");
  try {
    if (makeDefault) {
      await pool.query(`UPDATE local_clients SET is_default = FALSE WHERE user_id = $1`, [userId]);
    }

    const result = await pool.query<{ id: string }>(
      `
        INSERT INTO local_clients (
          id, user_id, device_id, client_name, platform, capabilities_json,
          sync_root_id, sync_root_label, is_default, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, NOW())
        ON CONFLICT (user_id, device_id, sync_root_id)
        DO UPDATE SET
          client_name = EXCLUDED.client_name,
          platform = EXCLUDED.platform,
          capabilities_json = EXCLUDED.capabilities_json,
          sync_root_label = EXCLUDED.sync_root_label,
          is_enabled = TRUE,
          is_default = CASE WHEN EXCLUDED.is_default THEN TRUE ELSE local_clients.is_default END,
          updated_at = NOW()
        RETURNING id
      `,
      [
        id,
        userId,
        input.deviceId.trim(),
        input.clientName.trim(),
        input.platform.trim(),
        JSON.stringify(input.capabilities ?? {}),
        syncRootId,
        syncRootLabel,
        makeDefault
      ]
    );

    const clientId = result.rows[0].id;
    await pool.query(
      `
        UPDATE local_client_tokens
        SET revoked_at = NOW()
        WHERE local_client_id = $1 AND revoked_at IS NULL
      `,
      [clientId]
    );
    await pool.query(
      `
        INSERT INTO local_client_tokens (id, local_client_id, token_hash)
        VALUES ($1, $2, $3)
      `,
      [tokenId, clientId, hashToken(clientToken)]
    );
    await pool.query("COMMIT");

    const client = await readClientById(userId, clientId);
    if (!client) {
      throw new LocalClientStoreError(500, "LOCAL_CLIENT_NOT_FOUND_AFTER_REGISTER", "Registered local client was not found.");
    }
    return { client, clientToken };
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function listLocalClients(userId: string): Promise<LocalClient[]> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalClientRow>(
    `
      SELECT
        c.id, c.user_id, c.device_id, c.client_name, c.platform, c.capabilities_json,
        c.sync_root_id, c.sync_root_label, c.is_enabled, c.is_default, c.created_at, c.updated_at,
        h.daemon_version, h.sync_root_state_json, h.last_seen_at
      FROM local_clients c
      LEFT JOIN local_client_heartbeats h ON h.local_client_id = c.id
      WHERE c.user_id = $1
      ORDER BY c.is_default DESC, h.last_seen_at DESC NULLS LAST, c.updated_at DESC
    `,
    [userId]
  );
  return result.rows.map(toClient);
}

export async function revokeLocalClientTokens(userId: string, id: string): Promise<boolean> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query(
    `
      UPDATE local_client_tokens t
      SET revoked_at = NOW()
      FROM local_clients c
      WHERE t.local_client_id = c.id
        AND c.user_id = $1
        AND c.id = $2
        AND t.revoked_at IS NULL
    `,
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteLocalClient(userId: string, id: string): Promise<boolean> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query(
    `
      DELETE FROM local_clients
      WHERE user_id = $1 AND id = $2
    `,
    [userId, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateLocalClient(
  userId: string,
  id: string,
  updates: {
    clientName?: string;
    enabled?: boolean;
    capabilities?: Record<string, unknown>;
    syncRootLabel?: string;
    default?: boolean;
  }
): Promise<LocalClient | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();

  await pool.query("BEGIN");
  try {
    if (updates.default === true) {
      await pool.query(`UPDATE local_clients SET is_default = FALSE WHERE user_id = $1`, [userId]);
    }

    const existing = await readClientById(userId, id);
    if (!existing) {
      await pool.query("ROLLBACK");
      return undefined;
    }

    await pool.query(
      `
        UPDATE local_clients
        SET
          client_name = $3,
          is_enabled = $4,
          capabilities_json = $5::jsonb,
          sync_root_label = $6,
          is_default = $7,
          updated_at = NOW()
        WHERE user_id = $1 AND id = $2
      `,
      [
        userId,
        id,
        updates.clientName?.trim() || existing.clientName,
        updates.enabled ?? existing.enabled,
        JSON.stringify(updates.capabilities ?? existing.capabilities),
        updates.syncRootLabel?.trim() || existing.syncRootLabel,
        updates.default ?? existing.default
      ]
    );

    await pool.query("COMMIT");
    return readClientById(userId, id);
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function verifyLocalClientToken(localClientId: string, token: string): Promise<LocalClient> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalClientRow>(
    `
      SELECT
        c.id, c.user_id, c.device_id, c.client_name, c.platform, c.capabilities_json,
        c.sync_root_id, c.sync_root_label, c.is_enabled, c.is_default, c.created_at, c.updated_at,
        h.daemon_version, h.sync_root_state_json, h.last_seen_at
      FROM local_clients c
      JOIN local_client_tokens t ON t.local_client_id = c.id
      LEFT JOIN local_client_heartbeats h ON h.local_client_id = c.id
      WHERE c.id = $1
        AND t.token_hash = $2
        AND t.revoked_at IS NULL
      LIMIT 1
    `,
    [localClientId, hashToken(token)]
  );
  const row = result.rows[0];
  if (!row || !row.is_enabled) {
    throw new LocalClientStoreError(401, "INVALID_LOCAL_CLIENT_TOKEN", "Invalid or disabled local client token.");
  }
  return toClient(row);
}

export async function recordLocalClientHeartbeat(
  client: LocalClient,
  input: { daemonVersion?: string; syncRootState?: Record<string, unknown> }
): Promise<LocalClient> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      INSERT INTO local_client_heartbeats (local_client_id, daemon_version, sync_root_state_json, last_seen_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (local_client_id)
      DO UPDATE SET
        daemon_version = EXCLUDED.daemon_version,
        sync_root_state_json = EXCLUDED.sync_root_state_json,
        last_seen_at = NOW()
    `,
    [client.id, input.daemonVersion ?? null, JSON.stringify(input.syncRootState ?? {})]
  );
  const updated = await readClientById(client.userId, client.id);
  if (!updated) {
    throw new LocalClientStoreError(404, "LOCAL_CLIENT_NOT_FOUND", "Local client not found.");
  }
  return updated;
}

async function selectLocalClientForJob(userId: string, requestedClientId?: string): Promise<LocalClient> {
  if (requestedClientId) {
    const requested = await readClientById(userId, requestedClientId);
    if (!requested || !requested.enabled) {
      throw new LocalClientStoreError(404, "LOCAL_CLIENT_NOT_FOUND", "Local client not found or disabled.");
    }
    return requested;
  }

  const clients = await listLocalClients(userId);
  const online = clients.filter((client) => client.enabled && client.heartbeat?.online);
  const defaultOnline = online.filter((client) => client.default);
  if (defaultOnline.length === 1) {
    return defaultOnline[0];
  }
  if (online.length === 1) {
    return online[0];
  }
  if (online.length === 0) {
    throw new LocalClientStoreError(409, "NO_ONLINE_LOCAL_CLIENT", "No enabled online local client is available.");
  }
  throw new LocalClientStoreError(409, "AMBIGUOUS_LOCAL_CLIENT", "Multiple local clients are online; specify localClientId.");
}

export async function createLocalJob(
  userId: string,
  input: {
    localClientId?: string;
    idempotencyKey?: string;
    kind: LocalJobKind;
    target: LocalJobTarget;
    payload?: Record<string, unknown>;
    ttlSeconds?: number;
  }
): Promise<LocalJob> {
  await ensureCoreSchema();
  await markExpiredLocalJobsForUser(userId);
  const pool = getCorePool();
  const client = await selectLocalClientForJob(userId, input.localClientId);
  const id = randomUUID();
  const ttlSeconds = Number.isFinite(input.ttlSeconds) ? Math.max(60, Math.min(86400, Math.floor(input.ttlSeconds ?? 86400))) : 86400;
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");

    if (idempotencyKey) {
      const inserted = await dbClient.query<LocalJobRow>(
        `
          INSERT INTO local_jobs (
            id, user_id, local_client_id, idempotency_key, kind, target, payload_json, expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW() + ($8::text || ' seconds')::interval)
          ON CONFLICT (user_id, local_client_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL
              AND status IN ('pending', 'running', 'completed')
          DO NOTHING
          RETURNING
            id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
            claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
        `,
        [id, userId, client.id, idempotencyKey, input.kind, input.target, JSON.stringify(input.payload ?? {}), ttlSeconds]
      );
      if (inserted.rows[0]) {
        const job = toJob(inserted.rows[0]);
        await recordLocalJobEvent(dbClient, job, "created", { idempotencyKey });
        await dbClient.query("COMMIT");
        return job;
      }

      const existing = await dbClient.query<LocalJobRow>(
        `
          SELECT
            id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
            claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
          FROM local_jobs
          WHERE user_id = $1
            AND local_client_id = $2
            AND idempotency_key = $3
            AND status = ANY($4::text[])
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [userId, client.id, idempotencyKey, ACTIVE_IDEMPOTENCY_STATUSES]
      );
      if (existing.rows[0]) {
        await dbClient.query("COMMIT");
        return toJob(existing.rows[0]);
      }
      throw new LocalClientStoreError(409, "LOCAL_JOB_IDEMPOTENCY_CONFLICT", "Local job idempotency key is temporarily unavailable.");
    }

    const result = await dbClient.query<LocalJobRow>(
      `
        INSERT INTO local_jobs (
          id, user_id, local_client_id, kind, target, payload_json, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() + ($7::text || ' seconds')::interval)
        RETURNING
          id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
          claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      `,
      [id, userId, client.id, input.kind, input.target, JSON.stringify(input.payload ?? {}), ttlSeconds]
    );
    const job = toJob(result.rows[0]);
    await recordLocalJobEvent(dbClient, job, "created");
    await dbClient.query("COMMIT");
    return job;
  } catch (error) {
    await dbClient.query("ROLLBACK");
    throw error;
  } finally {
    dbClient.release();
  }
}

export async function getLocalJob(userId: string, jobId: string): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  await markExpiredLocalJobsForUser(userId);
  const pool = getCorePool();
  const result = await pool.query<LocalJobRow>(
    `
      SELECT
        id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      FROM local_jobs
      WHERE user_id = $1 AND id = $2
      LIMIT 1
    `,
    [userId, jobId]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}

export async function listLocalJobEventsForUser(userId: string, jobId: string, limit = 100): Promise<LocalJobEvent[]> {
  await ensureCoreSchema();
  await markExpiredLocalJobsForUser(userId);
  const pool = getCorePool();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const result = await pool.query<LocalJobEventRow>(
    `
      SELECT e.id, e.job_id, e.user_id, e.local_client_id, e.event_type, e.detail_json, e.created_at
      FROM local_job_events e
      JOIN local_jobs j ON j.id = e.job_id
      WHERE e.user_id = $1
        AND e.job_id = $2
        AND j.user_id = $1
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT $3
    `,
    [userId, jobId, safeLimit]
  );
  return result.rows.map(toJobEvent);
}

export async function listLocalJobsForUser(
  userId: string,
  options: {
    localClientId?: string;
    status?: LocalJobStatus;
    limit?: number;
  } = {}
): Promise<LocalJob[]> {
  await ensureCoreSchema();
  await markExpiredLocalJobsForUser(userId);
  const pool = getCorePool();
  const values: unknown[] = [userId];
  const where = ["user_id = $1"];
  if (options.localClientId) {
    values.push(options.localClientId);
    where.push(`local_client_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    where.push(`status = $${values.length}`);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  values.push(limit);
  const result = await pool.query<LocalJobRow>(
    `
      SELECT
        id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      FROM local_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${values.length}
    `,
    values
  );
  return result.rows.map(toJob);
}

export async function getLocalJobForClient(localClientId: string, jobId: string): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  await markExpiredLocalJobsForClient(localClientId);
  const pool = getCorePool();
  const result = await pool.query<LocalJobRow>(
    `
      SELECT
        id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      FROM local_jobs
      WHERE local_client_id = $1 AND id = $2
      LIMIT 1
    `,
    [localClientId, jobId]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}

export async function claimLocalJobsForClient(localClientId: string, limit: number): Promise<LocalJob[]> {
  await ensureCoreSchema();
  await markExpiredLocalJobsForClient(localClientId);
  const pool = getCorePool();
  const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  const result = await pool.query<LocalJobRow>(
    `
      WITH selected AS (
        SELECT id
        FROM local_jobs
        WHERE local_client_id = $1
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      ),
      claimed AS (
        UPDATE local_jobs j
        SET
          status = 'running',
          attempts = j.attempts + 1,
          claimed_at = NOW(),
          next_attempt_at = NULL,
          updated_at = NOW()
        FROM selected
        WHERE j.id = selected.id
        RETURNING
          j.id, j.user_id, j.local_client_id, j.idempotency_key, j.kind, j.target, j.payload_json, j.status, j.attempts,
          j.claimed_at, j.completed_at, j.failed_at, j.next_attempt_at, j.expires_at, j.result_json, j.error_message, j.created_at, j.updated_at
      ),
      events AS (
        INSERT INTO local_job_events (job_id, user_id, local_client_id, event_type, detail_json)
        SELECT id, user_id, local_client_id, 'claimed', jsonb_build_object('attempts', attempts)
        FROM claimed
        RETURNING id
      )
      SELECT
        id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      FROM claimed
    `,
    [localClientId, safeLimit]
  );
  return result.rows.map(toJob);
}

export async function completeLocalJobForClient(
  localClientId: string,
  jobId: string,
  resultPayload: Record<string, unknown>
): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalJobRow>(
    `
      WITH updated AS (
        UPDATE local_jobs
        SET
          status = 'completed',
          result_json = $3::jsonb,
          completed_at = NOW(),
          failed_at = NULL,
          next_attempt_at = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE local_client_id = $1 AND id = $2 AND status IN ('pending', 'running')
        RETURNING
          id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
          claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      ),
      events AS (
        INSERT INTO local_job_events (job_id, user_id, local_client_id, event_type, detail_json)
        SELECT id, user_id, local_client_id, 'completed', jsonb_build_object()
        FROM updated
        RETURNING id
      )
      SELECT
        id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      FROM updated
    `,
    [localClientId, jobId, JSON.stringify(resultPayload)]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}

export async function failLocalJobForClient(
  localClientId: string,
  jobId: string,
  errorMessage: string,
  options: {
    retryable?: boolean;
    retryAfterSeconds?: number;
  } = {}
): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const retryable = options.retryable === false ? false : options.retryable === true || options.retryAfterSeconds !== undefined;
  const retryAfterSeconds =
    options.retryAfterSeconds === undefined ? undefined : Math.max(0, Math.min(86400, Math.floor(options.retryAfterSeconds)));
  const result = await pool.query<LocalJobRow>(
    `
      WITH updated AS (
        UPDATE local_jobs
        SET
          status = CASE WHEN $4::boolean THEN 'pending' ELSE 'failed' END,
          claimed_at = CASE WHEN $4::boolean THEN NULL ELSE claimed_at END,
          failed_at = CASE WHEN $4::boolean THEN NULL ELSE NOW() END,
          next_attempt_at = CASE
            WHEN $4::boolean AND $5::integer IS NOT NULL THEN NOW() + ($5::text || ' seconds')::interval
            WHEN $4::boolean THEN NULL
            ELSE NULL
          END,
          error_message = $3,
          updated_at = NOW()
        WHERE local_client_id = $1 AND id = $2 AND status IN ('pending', 'running')
        RETURNING
          id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
          claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      ),
      events AS (
        INSERT INTO local_job_events (job_id, user_id, local_client_id, event_type, detail_json)
        SELECT
          id,
          user_id,
          local_client_id,
          CASE WHEN $4::boolean THEN 'retry_scheduled' ELSE 'failed' END,
          jsonb_build_object(
            'error', $3::text,
            'retryable', $4::boolean,
            'retryAfterSeconds', $5::integer
          )
        FROM updated
        RETURNING id
      )
      SELECT
        id, user_id, local_client_id, idempotency_key, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, next_attempt_at, expires_at, result_json, error_message, created_at, updated_at
      FROM updated
    `,
    [localClientId, jobId, errorMessage.slice(0, 2000), retryable, retryAfterSeconds ?? null]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}
