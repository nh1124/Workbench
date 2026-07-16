import { ensureCoreSchema, getCorePool } from "./db.js";

export const SYNC_DOMAINS = ["projects", "notes", "artifacts", "tasks", "project_context"] as const;
export type SyncDomain = (typeof SYNC_DOMAINS)[number];
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

export interface SyncResourceVersion {
  userId: string;
  domain: SyncDomain;
  resourceId: string;
  version: number;
  updatedAt: string;
  deletedAt?: string;
}

export interface SyncAppliedClientOp {
  userId: string;
  clientOpId: string;
  domain: SyncDomain;
  action: SyncAction;
  resourceId: string;
  version: number;
  cursor: string;
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
  resource_deleted_at?: string | null;
};

type SyncResourceVersionRow = {
  user_id: string;
  domain: string;
  resource_id: string;
  version: number;
  updated_at: string;
  deleted_at: string | null;
};

type SyncAppliedClientOpRow = {
  user_id: string;
  client_op_id: string;
  domain: string;
  action: string;
  resource_id: string;
  version: number;
  cursor: string | number;
  created_at: string;
};

type SyncEventQueryResult<Row> = {
  rows: Row[];
};

type SyncEventTransactionClient = {
  query<Row = never>(text: string, values?: unknown[]): Promise<SyncEventQueryResult<Row>>;
  release(): void;
};

type SyncEventTransactionPool = {
  connect(): Promise<SyncEventTransactionClient>;
};

type SyncCursorQueryPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<SyncEventQueryResult<Row>>;
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toEvent(row: SyncEventRow): SyncEvent {
  const payload = { ...jsonObject(row.payload_json) };
  const resourceDeletedAt = row.resource_deleted_at ? new Date(row.resource_deleted_at).toISOString() : undefined;
  if (resourceDeletedAt && payload.resourceDeletedAt === undefined) {
    payload.resourceDeletedAt = resourceDeletedAt;
  }
  if (row.action === "delete") {
    if (payload.deleted === undefined) {
      payload.deleted = true;
    }
    if (resourceDeletedAt && payload.deletedAt === undefined) {
      payload.deletedAt = resourceDeletedAt;
    }
  }
  return {
    cursor: String(row.id),
    userId: row.user_id,
    domain: row.domain as SyncDomain,
    resourceId: row.resource_id,
    action: row.action as SyncAction,
    version: row.version,
    payload,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function toResourceVersion(row: SyncResourceVersionRow): SyncResourceVersion {
  return {
    userId: row.user_id,
    domain: row.domain as SyncDomain,
    resourceId: row.resource_id,
    version: Number(row.version),
    updatedAt: new Date(row.updated_at).toISOString(),
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : undefined
  };
}

function toAppliedClientOp(row: SyncAppliedClientOpRow): SyncAppliedClientOp {
  return {
    userId: row.user_id,
    clientOpId: row.client_op_id,
    domain: row.domain as SyncDomain,
    action: row.action as SyncAction,
    resourceId: row.resource_id,
    version: Number(row.version),
    cursor: String(row.cursor),
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
  return recordSyncEventWithPool(getCorePool(), userId, domain, resourceId, action, payload);
}

/** @internal Exported only so transaction ownership can be tested without a live database. */
export async function recordSyncEventWithPool(
  pool: SyncEventTransactionPool,
  userId: string,
  domain: SyncDomain,
  resourceId: string,
  action: SyncAction,
  payload: Record<string, unknown> = {}
): Promise<SyncEvent> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const versionResult = await client.query<{ version: number; deleted_at: string | null }>(
      `
        INSERT INTO sync_resource_versions (user_id, domain, resource_id, version, deleted_at, updated_at)
        VALUES ($1, $2, $3, 1, CASE WHEN $4 = 'delete' THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (user_id, domain, resource_id)
        DO UPDATE SET
          version = sync_resource_versions.version + 1,
          deleted_at = CASE WHEN $4 = 'delete' THEN NOW() ELSE NULL END,
          updated_at = NOW()
        RETURNING version, deleted_at
      `,
      [userId, domain, resourceId, action]
    );
    const versionRow = versionResult.rows[0];
    const version = versionRow.version;
    const eventPayload = { ...payload };
    if (action === "delete") {
      if (eventPayload.deleted === undefined) {
        eventPayload.deleted = true;
      }
      if (versionRow.deleted_at && eventPayload.deletedAt === undefined) {
        eventPayload.deletedAt = new Date(versionRow.deleted_at).toISOString();
      }
      if (versionRow.deleted_at && eventPayload.resourceDeletedAt === undefined) {
        eventPayload.resourceDeletedAt = new Date(versionRow.deleted_at).toISOString();
      }
    }
    const eventResult = await client.query<SyncEventRow>(
      `
        INSERT INTO sync_events (user_id, domain, resource_id, action, version, payload_json)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        RETURNING id, user_id, domain, resource_id, action, version, payload_json, created_at
      `,
      [userId, domain, resourceId, action, version, JSON.stringify(eventPayload)]
    );
    const eventRow = eventResult.rows[0];
    const clientOpId = typeof eventPayload.clientOpId === "string" && eventPayload.clientOpId.trim()
      ? eventPayload.clientOpId.trim()
      : undefined;
    if (clientOpId) {
      await client.query(
        `
          INSERT INTO sync_applied_client_ops (
            user_id, client_op_id, domain, action, resource_id, version, cursor, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (user_id, client_op_id) DO NOTHING
        `,
        [userId, clientOpId, domain, action, resourceId, version, eventRow.id, eventRow.created_at]
      );
    }
    await client.query("COMMIT");
    return toEvent(eventRow);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the mutation/commit error when rollback also fails.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getAppliedClientOp(
  userId: string,
  clientOpId: string
): Promise<SyncAppliedClientOp | undefined> {
  await ensureCoreSchema();
  return getAppliedClientOpWithPool(getCorePool(), userId, clientOpId);
}

/** @internal Exported so owner-scoped idempotency lookup can be tested without a live database. */
export async function getAppliedClientOpWithPool(
  pool: SyncCursorQueryPool,
  userId: string,
  clientOpId: string
): Promise<SyncAppliedClientOp | undefined> {
  const result = await pool.query<SyncAppliedClientOpRow>(
    `
      SELECT user_id, client_op_id, domain, action, resource_id, version, cursor, created_at
      FROM sync_applied_client_ops
      WHERE user_id = $1 AND client_op_id = $2
      LIMIT 1
    `,
    [userId, clientOpId]
  );
  const row = result.rows[0];
  return row ? toAppliedClientOp(row) : undefined;
}

export async function getSyncResourceVersion(
  userId: string,
  domain: SyncDomain,
  resourceId: string
): Promise<SyncResourceVersion | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<SyncResourceVersionRow>(
    `
      SELECT user_id, domain, resource_id, version, updated_at, deleted_at
      FROM sync_resource_versions
      WHERE user_id = $1 AND domain = $2 AND resource_id = $3
      LIMIT 1
    `,
    [userId, domain, resourceId]
  );
  const row = result.rows[0];
  return row ? toResourceVersion(row) : undefined;
}

export async function listSyncEvents(
  userId: string,
  cursor: string | undefined,
  limit: number,
  domains?: SyncDomain[]
): Promise<{ events: SyncEvent[]; nextCursor?: string }> {
  await ensureCoreSchema();
  return listSyncEventsWithPool(getCorePool(), userId, cursor, limit, domains);
}

/** @internal Exported so event filtering can be tested without a live database. */
export async function listSyncEventsWithPool(
  pool: SyncCursorQueryPool,
  userId: string,
  cursor: string | undefined,
  limit: number,
  domains?: SyncDomain[]
): Promise<{ events: SyncEvent[]; nextCursor?: string }> {
  const parsedCursor = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const result = await pool.query<SyncEventRow>(
    `
      SELECT e.id, e.user_id, e.domain, e.resource_id, e.action, e.version, e.payload_json, e.created_at,
        v.deleted_at AS resource_deleted_at
      FROM sync_events e
      LEFT JOIN sync_resource_versions v
        ON v.user_id = e.user_id
       AND v.domain = e.domain
       AND v.resource_id = e.resource_id
      WHERE e.user_id = $1
        AND e.id > $2
        AND ($4::text[] IS NULL OR e.domain = ANY($4::text[]))
      ORDER BY e.id ASC
      LIMIT $3
    `,
    [userId, parsedCursor, safeLimit, domains ?? null]
  );
  const events = result.rows.map(toEvent);
  return {
    events,
    nextCursor: events.length > 0 ? events[events.length - 1].cursor : cursor
  };
}

export async function getLatestSyncCursor(userId: string): Promise<string> {
  await ensureCoreSchema();
  return getLatestSyncCursorWithPool(getCorePool(), userId);
}

/** @internal Exported so cursor capture can be tested without a live database. */
export async function getLatestSyncCursorWithPool(pool: SyncCursorQueryPool, userId: string): Promise<string> {
  const result = await pool.query<{ cursor: string | number | null }>(
    `
      SELECT COALESCE(MAX(id), 0) AS cursor
      FROM sync_events
      WHERE user_id = $1
    `,
    [userId]
  );
  return String(result.rows[0]?.cursor ?? "0");
}

export async function listSyncResourceVersions(
  userId: string,
  domains?: SyncDomain[],
  limit = 500
): Promise<SyncResourceVersion[]> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const domainFilter = domains?.filter((domain): domain is SyncDomain =>
    (SYNC_DOMAINS as readonly string[]).includes(domain)
  );
  const result = await pool.query<SyncResourceVersionRow>(
    `
      SELECT user_id, domain, resource_id, version, updated_at, deleted_at
      FROM sync_resource_versions
      WHERE user_id = $1
        AND ($2::text[] IS NULL OR domain = ANY($2::text[]))
      ORDER BY updated_at DESC, domain ASC, resource_id ASC
      LIMIT $3
    `,
    [userId, domainFilter && domainFilter.length > 0 ? domainFilter : null, safeLimit]
  );
  return result.rows.map(toResourceVersion);
}

export async function recordSyncPushRejection(
  userId: string,
  payload: Record<string, unknown>
): Promise<SyncEvent> {
  return recordSyncEvent(userId, "artifacts", `sync-push-rejected:${Date.now()}`, "update", payload);
}
