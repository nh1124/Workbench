import type { ExceptionType, TaskException } from "./types.js";
import { getLbsStoreDatabase, isoTimestamp, requireOwner, type LbsStoreDatabase } from "./storeUtils.js";

const VALID_EXCEPTION_TYPES = new Set<ExceptionType>(["SKIP", "FORCE_DO", "MANUAL_LOCK", "OVERRIDE_LOAD", "RESCHEDULE"]);

type ExceptionRow = Omit<TaskException, "user_id" | "created_at"> & { owner_username: string; created_at: string | Date };
export interface ExceptionCreate {
  task_id: string;
  target_date: string;
  exception_type: ExceptionType;
  override_load_value?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  notes?: string | null;
  is_locked?: boolean;
}
export type ExceptionUpdate = Partial<Omit<ExceptionCreate, "task_id" | "target_date">>;

function assertExceptionType(value: ExceptionType): void {
  if (!VALID_EXCEPTION_TYPES.has(value)) throw new Error(`Invalid exception_type: ${value}`);
}

function toException(row: ExceptionRow): TaskException {
  const { owner_username, created_at, ...exception } = row;
  return { ...exception, user_id: owner_username, created_at: isoTimestamp(created_at) };
}

const COLUMNS = `id, owner_username, task_id, target_date, exception_type, override_load_value,
  start_time, end_time, notes, is_locked, created_at`;

export async function listExceptions(
  ownerCoreUserId: string,
  filters: { taskId?: string; startDate?: string; endDate?: string } = {},
  database?: LbsStoreDatabase
): Promise<TaskException[]> {
  const values: unknown[] = [requireOwner(ownerCoreUserId)];
  const where = ["owner_username = $1"];
  if (filters.taskId) { values.push(filters.taskId.trim()); where.push(`task_id = $${values.length}`); }
  if (filters.startDate) { values.push(filters.startDate); where.push(`target_date >= $${values.length}`); }
  if (filters.endDate) { values.push(filters.endDate); where.push(`target_date <= $${values.length}`); }
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ExceptionRow>(
    `SELECT ${COLUMNS} FROM task_rule_exceptions WHERE ${where.join(" AND ")} ORDER BY target_date, id`, values
  );
  return result.rows.map(toException);
}

export async function createException(ownerCoreUserId: string, input: ExceptionCreate, database?: LbsStoreDatabase): Promise<TaskException> {
  assertExceptionType(input.exception_type);
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ExceptionRow>(
    `INSERT INTO task_rule_exceptions (owner_username, task_id, target_date, exception_type,
       override_load_value, start_time, end_time, notes, is_locked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLUMNS}`,
    [requireOwner(ownerCoreUserId), input.task_id.trim(), input.target_date, input.exception_type,
      input.override_load_value ?? null, input.start_time ?? null, input.end_time ?? null,
      input.notes ?? null, input.is_locked ?? false]
  );
  return toException(result.rows[0]);
}

export async function updateException(ownerCoreUserId: string, id: number, patch: ExceptionUpdate, database?: LbsStoreDatabase): Promise<TaskException | undefined> {
  if (patch.exception_type !== undefined) assertExceptionType(patch.exception_type);
  const columns: Record<keyof ExceptionUpdate, string> = {
    exception_type: "exception_type", override_load_value: "override_load_value", start_time: "start_time",
    end_time: "end_time", notes: "notes", is_locked: "is_locked"
  };
  const values: unknown[] = [requireOwner(ownerCoreUserId), id];
  const sets: string[] = [];
  for (const [key, column] of Object.entries(columns) as Array<[keyof ExceptionUpdate, string]>) {
    if (patch[key] !== undefined) { values.push(patch[key]); sets.push(`${column} = $${values.length}`); }
  }
  if (sets.length === 0) {
    const rows = await listExceptions(ownerCoreUserId, {}, database);
    return rows.find((row) => row.id === id);
  }
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ExceptionRow>(
    `UPDATE task_rule_exceptions SET ${sets.join(", ")} WHERE owner_username = $1 AND id = $2 RETURNING ${COLUMNS}`, values
  );
  return result.rows[0] ? toException(result.rows[0]) : undefined;
}

export async function deleteException(ownerCoreUserId: string, id: number, database?: LbsStoreDatabase): Promise<boolean> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query(`DELETE FROM task_rule_exceptions WHERE owner_username = $1 AND id = $2`, [requireOwner(ownerCoreUserId), id]);
  return (result.rowCount ?? 0) > 0;
}
