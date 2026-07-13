import type { TaskExecution, TaskStatus } from "./types.js";
import { getLbsStoreDatabase, isoTimestamp, requireOwner, type LbsStoreDatabase } from "./storeUtils.js";

type ExecutionRow = Omit<TaskExecution, "user_id" | "created_at"> & { owner_username: string; created_at: string | Date };
const COLUMNS = `id, owner_username, task_id, target_date, status, progress, actual_time, created_at`;

function toExecution(row: ExecutionRow): TaskExecution {
  const { owner_username, created_at, ...execution } = row;
  return { ...execution, user_id: owner_username, created_at: isoTimestamp(created_at) };
}

export async function upsertExecution(
  ownerCoreUserId: string,
  input: { taskId: string; targetDate: string; status: TaskStatus; progress?: number; actualTime?: number | null },
  database?: LbsStoreDatabase
): Promise<TaskExecution> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ExecutionRow>(
    `INSERT INTO task_executions (owner_username, task_id, target_date, status, progress, actual_time)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_username, task_id, target_date) DO UPDATE SET
       status = EXCLUDED.status, progress = EXCLUDED.progress, actual_time = EXCLUDED.actual_time
     RETURNING ${COLUMNS}`,
    [requireOwner(ownerCoreUserId), input.taskId.trim(), input.targetDate, input.status,
      input.progress ?? 100, input.actualTime ?? null]
  );
  return toExecution(result.rows[0]);
}

export async function deleteExecution(
  ownerCoreUserId: string,
  taskId: string,
  targetDate: string,
  database?: LbsStoreDatabase
): Promise<boolean> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query(
    `DELETE FROM task_executions
     WHERE owner_username = $1 AND task_id = $2 AND target_date = $3`,
    [requireOwner(ownerCoreUserId), taskId.trim(), targetDate]
  );
  return (result.rowCount ?? 0) > 0;
}

async function list(ownerCoreUserId: string, startDate: string, endDate: string, taskId: string | undefined, database?: LbsStoreDatabase): Promise<TaskExecution[]> {
  const values: unknown[] = [requireOwner(ownerCoreUserId), startDate, endDate];
  let taskPredicate = "";
  if (taskId !== undefined) { values.push(taskId.trim()); taskPredicate = ` AND task_id = $${values.length}`; }
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ExecutionRow>(
    `SELECT ${COLUMNS} FROM task_executions
     WHERE owner_username = $1 AND target_date >= $2 AND target_date <= $3${taskPredicate}
     ORDER BY target_date, task_id`, values
  );
  return result.rows.map(toExecution);
}

export function listExecutionsByTaskRange(ownerCoreUserId: string, taskId: string, startDate: string, endDate: string, database?: LbsStoreDatabase): Promise<TaskExecution[]> {
  return list(ownerCoreUserId, startDate, endDate, taskId, database);
}

export function listExecutionsByRange(ownerCoreUserId: string, startDate: string, endDate: string, database?: LbsStoreDatabase): Promise<TaskExecution[]> {
  return list(ownerCoreUserId, startDate, endDate, undefined, database);
}
