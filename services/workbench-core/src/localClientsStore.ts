import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureCoreSchema, getCorePool } from "./db.js";

export type LocalJobKind = "download_artifact" | "download_task_attachment" | "materialize_resource";
export type LocalJobTarget = "downloads" | "sync-folder";
export type LocalJobStatus = "pending" | "running" | "completed" | "failed";

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
  kind: LocalJobKind;
  target: LocalJobTarget;
  payload: Record<string, unknown>;
  status: LocalJobStatus;
  attempts: number;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  expiresAt?: string;
  result: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
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
  kind: string;
  target: string;
  payload_json: unknown;
  status: string;
  attempts: number;
  claimed_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  expires_at: string | null;
  result_json: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

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
    kind: row.kind as LocalJobKind,
    target: row.target as LocalJobTarget,
    payload: jsonObject(row.payload_json),
    status: row.status as LocalJobStatus,
    attempts: row.attempts,
    claimedAt: toIso(row.claimed_at),
    completedAt: toIso(row.completed_at),
    failedAt: toIso(row.failed_at),
    expiresAt: toIso(row.expires_at),
    result: jsonObject(row.result_json),
    errorMessage: row.error_message ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
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
    kind: LocalJobKind;
    target: LocalJobTarget;
    payload?: Record<string, unknown>;
    ttlSeconds?: number;
  }
): Promise<LocalJob> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const client = await selectLocalClientForJob(userId, input.localClientId);
  const id = randomUUID();
  const ttlSeconds = Number.isFinite(input.ttlSeconds) ? Math.max(60, Math.min(86400, Math.floor(input.ttlSeconds ?? 86400))) : 86400;

  const result = await pool.query<LocalJobRow>(
    `
      INSERT INTO local_jobs (
        id, user_id, local_client_id, kind, target, payload_json, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() + ($7::text || ' seconds')::interval)
      RETURNING
        id, user_id, local_client_id, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, expires_at, result_json, error_message, created_at, updated_at
    `,
    [id, userId, client.id, input.kind, input.target, JSON.stringify(input.payload ?? {}), ttlSeconds]
  );
  return toJob(result.rows[0]);
}

export async function getLocalJob(userId: string, jobId: string): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalJobRow>(
    `
      SELECT
        id, user_id, local_client_id, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, expires_at, result_json, error_message, created_at, updated_at
      FROM local_jobs
      WHERE user_id = $1 AND id = $2
      LIMIT 1
    `,
    [userId, jobId]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}

export async function getLocalJobForClient(localClientId: string, jobId: string): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalJobRow>(
    `
      SELECT
        id, user_id, local_client_id, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, expires_at, result_json, error_message, created_at, updated_at
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
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE local_jobs j
      SET
        status = 'running',
        attempts = j.attempts + 1,
        claimed_at = NOW(),
        updated_at = NOW()
      FROM selected
      WHERE j.id = selected.id
      RETURNING
        j.id, j.user_id, j.local_client_id, j.kind, j.target, j.payload_json, j.status, j.attempts,
        j.claimed_at, j.completed_at, j.failed_at, j.expires_at, j.result_json, j.error_message, j.created_at, j.updated_at
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
      UPDATE local_jobs
      SET
        status = 'completed',
        result_json = $3::jsonb,
        completed_at = NOW(),
        failed_at = NULL,
        error_message = NULL,
        updated_at = NOW()
      WHERE local_client_id = $1 AND id = $2 AND status IN ('pending', 'running')
      RETURNING
        id, user_id, local_client_id, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, expires_at, result_json, error_message, created_at, updated_at
    `,
    [localClientId, jobId, JSON.stringify(resultPayload)]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}

export async function failLocalJobForClient(
  localClientId: string,
  jobId: string,
  errorMessage: string
): Promise<LocalJob | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<LocalJobRow>(
    `
      UPDATE local_jobs
      SET
        status = 'failed',
        failed_at = NOW(),
        error_message = $3,
        updated_at = NOW()
      WHERE local_client_id = $1 AND id = $2 AND status IN ('pending', 'running')
      RETURNING
        id, user_id, local_client_id, kind, target, payload_json, status, attempts,
        claimed_at, completed_at, failed_at, expires_at, result_json, error_message, created_at, updated_at
    `,
    [localClientId, jobId, errorMessage.slice(0, 2000)]
  );
  return result.rows[0] ? toJob(result.rows[0]) : undefined;
}
