import { ensureCoreSchema, getCorePool } from "./db.js";

export type SyncDomain = "projects" | "notes" | "artifacts" | "tasks";
export type SyncAction = "create" | "update" | "delete" | "upsert";

export interface SyncEvent {
  cursor: string;
  userId: string;
  domain: SyncDomain;
  resourceId: string;
  action: SyncAction;
  version: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

type SyncEventRow = {
  id: string | number;
  user_id: string;
  domain: string;
  resource_id: string;
  action: string;
  version: number;
  payload_json: unknown;
  created_at: string;
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toEvent(row: SyncEventRow): SyncEvent {
  return {
    cursor: String(row.id),
    userId: row.user_id,
    domain: row.domain as SyncDomain,
    resourceId: row.resource_id,
    action: row.action as SyncAction,
    version: row.version,
    payload: jsonObject(row.payload_json),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function recordSyncEvent(
  userId: string,
  domain: SyncDomain,
  resourceId: string,
  action: SyncAction,
  payload: Record<string, unknown> = {}
): Promise<SyncEvent> {
  await ensureCoreSchema();
  const pool = getCorePool();

  await pool.query("BEGIN");
  try {
    const versionResult = await pool.query<{ version: number }>(
      `
        INSERT INTO sync_resource_versions (user_id, domain, resource_id, version, deleted_at, updated_at)
        VALUES ($1, $2, $3, 1, CASE WHEN $4 = 'delete' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (user_id, domain, resource_id)
        DO UPDATE SET
          version = sync_resource_versions.version + 1,
          deleted_at = CASE WHEN $4 = 'delete' THEN NOW() ELSE NULL END,
          updated_at = NOW()
        RETURNING version
      `,
      [userId, domain, resourceId, action]
    );
    const version = versionResult.rows[0].version;
    const eventResult = await pool.query<SyncEventRow>(
      `
        INSERT INTO sync_events (user_id, domain, resource_id, action, version, payload_json)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING id, user_id, domain, resource_id, action, version, payload_json, created_at
      `,
      [userId, domain, resourceId, action, version, JSON.stringify(payload)]
    );
    await pool.query("COMMIT");
    return toEvent(eventResult.rows[0]);
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function listSyncEvents(
  userId: string,
  cursor: string | undefined,
  limit: number
): Promise<{ events: SyncEvent[]; nextCursor?: string }> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const parsedCursor = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await pool.query<SyncEventRow>(
    `
      SELECT id, user_id, domain, resource_id, action, version, payload_json, created_at
      FROM sync_events
      WHERE user_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3
    `,
    [userId, parsedCursor, safeLimit]
  );
  const events = result.rows.map(toEvent);
  return {
    events,
    nextCursor: events.length > 0 ? events[events.length - 1].cursor : cursor
  };
}

export async function recordSyncPushRejection(
  userId: string,
  payload: Record<string, unknown>
): Promise<SyncEvent> {
  return recordSyncEvent(userId, "artifacts", `sync-push-rejected:${Date.now()}`, "update", payload);
}
