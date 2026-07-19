import { isDeepStrictEqual } from "node:util";
import { ensureCoreSchema, getCorePool } from "./db.js";
import { SYNC_DOMAINS, type SyncAction, type SyncDomain } from "./syncStore.js";

export const DEFAULT_SYNC_CHANGES_CONSUMER = "maintenance-agent";

export class SyncConsumerCursorInputError extends Error {
  status = 400;
  code = "SYNC_CONSUMER_CURSOR_INPUT_INVALID";
}

export class SyncConsumerScopeConflictError extends Error {
  status = 409;
  code = "SYNC_CONSUMER_SCOPE_CONFLICT";
}

export type SyncConsumerScope = {
  projectId?: string;
  pathPrefix?: string;
  domains?: SyncDomain[];
  resourceTypes?: string[];
  actions?: SyncAction[];
};

export type SyncConsumerState = {
  cursor: string;
  scope?: SyncConsumerScope;
  initializedAt?: string;
};

export type SyncConsumerInitializeResult = SyncConsumerState & {
  consumer: string;
  alreadyInitialized: boolean;
};

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
  scope_json: unknown | null;
  initialized_at: string | Date | null;
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

const SYNC_ACTIONS: SyncAction[] = ["create", "update", "delete", "upsert"];
const SYNC_CONSUMER_SCOPE_KEYS = new Set([
  "projectId",
  "pathPrefix",
  "domains",
  "resourceTypes",
  "actions"
]);

function normalizeScopeString(value: unknown, field: "projectId" | "pathPrefix"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SyncConsumerCursorInputError(`scope.${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeScopeArray<T extends string>(
  value: unknown,
  field: "domains" | "resourceTypes" | "actions",
  supported?: ReadonlySet<string>
): T[] {
  if (!Array.isArray(value)) {
    throw new SyncConsumerCursorInputError(`scope.${field} must be an array`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new SyncConsumerCursorInputError(`scope.${field} must contain only non-empty strings`);
    }
    const trimmed = entry.trim();
    if (supported && !supported.has(trimmed)) {
      throw new SyncConsumerCursorInputError(`unsupported scope ${field} value: ${trimmed}`);
    }
    return trimmed as T;
  });
  return [...new Set(normalized)].sort();
}

export function normalizeSyncConsumerScope(value: unknown): SyncConsumerScope | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SyncConsumerCursorInputError("scope must be an object");
  }

  const input = value as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((key) => !SYNC_CONSUMER_SCOPE_KEYS.has(key));
  if (unknownKey) {
    throw new SyncConsumerCursorInputError(`unknown scope field: ${unknownKey}`);
  }

  const scope: SyncConsumerScope = {};
  if (input.projectId !== undefined) scope.projectId = normalizeScopeString(input.projectId, "projectId");
  if (input.pathPrefix !== undefined) scope.pathPrefix = normalizeScopeString(input.pathPrefix, "pathPrefix");
  if (input.domains !== undefined) {
    scope.domains = normalizeScopeArray<SyncDomain>(input.domains, "domains", new Set(SYNC_DOMAINS));
  }
  if (input.resourceTypes !== undefined) {
    scope.resourceTypes = normalizeScopeArray<string>(input.resourceTypes, "resourceTypes");
  }
  if (input.actions !== undefined) {
    scope.actions = normalizeScopeArray<SyncAction>(input.actions, "actions", new Set(SYNC_ACTIONS));
  }

  return Object.keys(scope).length === 0 ? undefined : scope;
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

function toConsumerState(row: Pick<SyncConsumerCursorRow, "cursor" | "scope_json" | "initialized_at">): SyncConsumerState {
  const scope = normalizeSyncConsumerScope(row.scope_json);
  return {
    cursor: row.cursor,
    ...(scope ? { scope } : {}),
    ...(row.initialized_at ? { initializedAt: new Date(row.initialized_at).toISOString() } : {})
  };
}

export async function getConsumerState(userId: string, consumerId: unknown): Promise<SyncConsumerState | undefined> {
  await ensureCoreSchema();
  return getConsumerStateWithPool(getCorePool(), userId, consumerId);
}

/** @internal Exported so consumer isolation can be tested without a live database. */
export async function getConsumerStateWithPool(
  pool: SyncConsumerCursorQueryPool,
  userId: string,
  consumerId: unknown
): Promise<SyncConsumerState | undefined> {
  const normalizedConsumerId = normalizeSyncConsumerId(consumerId);
  const result = await pool.query<Pick<SyncConsumerCursorRow, "cursor" | "scope_json" | "initialized_at">>(
    `
      SELECT cursor, scope_json, initialized_at
      FROM sync_consumer_cursors
      WHERE user_id = $1 AND consumer_id = $2
      LIMIT 1
    `,
    [userId, normalizedConsumerId]
  );
  const row = result.rows[0];
  return row ? toConsumerState(row) : undefined;
}

export async function initializeSyncConsumer(
  userId: string,
  input: { consumer: unknown; startAt?: unknown; scope?: unknown }
): Promise<SyncConsumerInitializeResult> {
  await ensureCoreSchema();
  return initializeSyncConsumerWithPool(getCorePool(), userId, input);
}

/** @internal Exported so atomic initialization can be tested without a live database. */
export async function initializeSyncConsumerWithPool(
  pool: SyncConsumerCursorQueryPool,
  userId: string,
  input: { consumer: unknown; startAt?: unknown; scope?: unknown }
): Promise<SyncConsumerInitializeResult> {
  if (input.consumer === undefined || input.consumer === null) {
    throw new SyncConsumerCursorInputError("consumer is required");
  }
  const consumer = normalizeSyncConsumerId(input.consumer);
  if (input.startAt !== undefined && input.startAt !== "current") {
    throw new SyncConsumerCursorInputError('only startAt "current" is supported');
  }
  const scope = normalizeSyncConsumerScope(input.scope);
  const inserted = await pool.query<Pick<SyncConsumerCursorRow, "cursor" | "scope_json" | "initialized_at">>(
    `
      INSERT INTO sync_consumer_cursors (user_id, consumer_id, cursor, scope_json, initialized_at, updated_at)
      SELECT $1, $2, COALESCE((SELECT MAX(id) FROM sync_events WHERE user_id = $1), 0)::text, $3::jsonb, NOW(), NOW()
      ON CONFLICT (user_id, consumer_id) DO NOTHING
      RETURNING cursor, scope_json, initialized_at
    `,
    [userId, consumer, scope ? JSON.stringify(scope) : null]
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return {
      consumer,
      ...toConsumerState(insertedRow),
      alreadyInitialized: false
    };
  }

  const existing = await getConsumerStateWithPool(pool, userId, consumer);
  if (!existing) {
    throw new Error("Sync consumer initialization conflicted but the existing consumer was not found");
  }
  if (scope !== undefined && !isDeepStrictEqual(scope, existing.scope)) {
    throw new SyncConsumerScopeConflictError("Sync consumer is already initialized with a different scope");
  }
  return {
    consumer,
    ...existing,
    alreadyInitialized: true
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
