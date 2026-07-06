import { ensureCoreSchema, getCorePool } from "./db.js";

export const DEFAULT_SYNC_CHANGES_CONSUMER = "maintenance-agent";

export class SyncConsumerCursorInputError extends Error {
  status = 400;
  code = "SYNC_CONSUMER_CURSOR_INPUT_INVALID";
}

export interface SyncConsumerCursorCommit {
  userId: string;
  consumerId: string;
  cursor: string;
  updatedAt: string;
}

type SyncConsumerCursorRow = {
  user_id: string;
  consumer_id: string;
  cursor: string;
  updated_at: string;
};

type SyncConsumerCursorQueryResult<Row> = {
  rows: Row[];
};

type SyncConsumerCursorQueryPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<SyncConsumerCursorQueryResult<Row>>;
};

export function normalizeSyncConsumerId(value: unknown = DEFAULT_SYNC_CHANGES_CONSUMER): string {
  const raw = value === undefined || value === null ? DEFAULT_SYNC_CHANGES_CONSUMER : value;
  if (typeof raw !== "string") {
    throw new SyncConsumerCursorInputError("consumer must be a string");
  }
  const consumerId = raw.trim();
  if (consumerId.length < 1 || consumerId.length > 100) {
    throw new SyncConsumerCursorInputError("consumer must be a trimmed non-empty string of 1 to 100 characters");
  }
  return consumerId;
}

function normalizeCursor(value: unknown): string {
  if (typeof value !== "string") {
    throw new SyncConsumerCursorInputError("cursor must be a string");
  }
  const cursor = value.trim();
  if (!cursor) {
    throw new SyncConsumerCursorInputError("cursor must be a non-empty string");
  }
  return cursor;
}

function toCommit(row: SyncConsumerCursorRow): SyncConsumerCursorCommit {
  return {
    userId: row.user_id,
    consumerId: row.consumer_id,
    cursor: row.cursor,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function getConsumerCursor(userId: string, consumerId: unknown): Promise<string | undefined> {
  await ensureCoreSchema();
  return getConsumerCursorWithPool(getCorePool(), userId, consumerId);
}

/** @internal Exported so consumer isolation can be tested without a live database. */
export async function getConsumerCursorWithPool(
  pool: SyncConsumerCursorQueryPool,
  userId: string,
  consumerId: unknown
): Promise<string | undefined> {
  const normalizedConsumerId = normalizeSyncConsumerId(consumerId);
  const result = await pool.query<Pick<SyncConsumerCursorRow, "cursor">>(
    `
      SELECT cursor
      FROM sync_consumer_cursors
      WHERE user_id = $1 AND consumer_id = $2
      LIMIT 1
    `,
    [userId, normalizedConsumerId]
  );
  return result.rows[0]?.cursor;
}

export async function commitConsumerCursor(
  userId: string,
  consumerId: unknown,
  cursor: unknown
): Promise<SyncConsumerCursorCommit> {
  await ensureCoreSchema();
  return commitConsumerCursorWithPool(getCorePool(), userId, consumerId, cursor);
}

/** @internal Exported so upsert behavior can be tested without a live database. */
export async function commitConsumerCursorWithPool(
  pool: SyncConsumerCursorQueryPool,
  userId: string,
  consumerId: unknown,
  cursor: unknown
): Promise<SyncConsumerCursorCommit> {
  const normalizedConsumerId = normalizeSyncConsumerId(consumerId);
  const normalizedCursor = normalizeCursor(cursor);
  const result = await pool.query<SyncConsumerCursorRow>(
    `
      INSERT INTO sync_consumer_cursors (user_id, consumer_id, cursor, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, consumer_id)
      DO UPDATE SET
        cursor = EXCLUDED.cursor,
        updated_at = NOW()
      RETURNING user_id, consumer_id, cursor, updated_at
    `,
    [userId, normalizedConsumerId, normalizedCursor]
  );
  return toCommit(result.rows[0]);
}
