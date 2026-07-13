import type { QueryResult, QueryResultRow } from "pg";
import { ensureTasksSchema, getTasksPool } from "../db.js";

export interface LbsStoreDatabase {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[]
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
}

export function normalizeOwner(ownerCoreUserId: string): string {
  return ownerCoreUserId.trim().toLowerCase();
}

export function requireOwner(ownerCoreUserId: string): string {
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) throw new Error("Owner core user id is required");
  return owner;
}

export async function getLbsStoreDatabase(database?: LbsStoreDatabase): Promise<LbsStoreDatabase> {
  if (database) return database;
  await ensureTasksSchema();
  return getTasksPool();
}

export function isoTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}
