import { randomUUID } from "node:crypto";
import type { LBSTask, RuleType } from "./types.js";
import { getLbsStoreDatabase, isoTimestamp, requireOwner, type LbsStoreDatabase } from "./storeUtils.js";

type DefinitionRow = Omit<LBSTask, "user_id" | "created_at" | "updated_at"> & {
  owner_username: string;
  created_at: string | Date;
  updated_at: string | Date;
};

export interface TaskDefinitionCreate {
  task_id?: string;
  task_name: string;
  context: string;
  base_load_score: number;
  active?: boolean;
  rule_type: RuleType;
  due_date?: string | null;
  mon?: boolean; tue?: boolean; wed?: boolean; thu?: boolean; fri?: boolean; sat?: boolean; sun?: boolean;
  interval_days?: number | null;
  anchor_date?: string | null;
  month_day?: number | null;
  nth_in_month?: number | null;
  weekday_mon1?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  notes?: string | null;
  external_sync_id?: string | null;
  timezone?: string | null;
  is_locked?: boolean;
}

export type TaskDefinitionUpdate = Partial<Omit<TaskDefinitionCreate, "task_id">>;

const COLUMNS = `owner_username, task_id, task_name, context, base_load_score, active, rule_type,
  due_date, mon, tue, wed, thu, fri, sat, sun, interval_days, anchor_date, month_day,
  nth_in_month, weekday_mon1, start_date, end_date, start_time, end_time, notes,
  external_sync_id, timezone, is_locked, created_at, updated_at`;

function toTask(row: DefinitionRow): LBSTask {
  const { owner_username, created_at, updated_at, ...task } = row;
  return { ...task, user_id: owner_username, created_at: isoTimestamp(created_at), updated_at: isoTimestamp(updated_at) };
}

export async function listDefinitions(
  ownerCoreUserId: string,
  filters: { context?: string; active?: boolean } = {},
  database?: LbsStoreDatabase
): Promise<LBSTask[]> {
  const values: unknown[] = [requireOwner(ownerCoreUserId)];
  const where = ["owner_username = $1"];
  if (filters.context !== undefined) { values.push(filters.context); where.push(`context = $${values.length}`); }
  if (filters.active !== undefined) { values.push(filters.active); where.push(`active = $${values.length}`); }
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<DefinitionRow>(
    `SELECT ${COLUMNS} FROM task_definitions WHERE ${where.join(" AND ")} ORDER BY created_at, task_id`, values
  );
  return result.rows.map(toTask);
}

export async function getDefinition(ownerCoreUserId: string, taskId: string, database?: LbsStoreDatabase): Promise<LBSTask | undefined> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<DefinitionRow>(
    `SELECT ${COLUMNS} FROM task_definitions WHERE owner_username = $1 AND task_id = $2`,
    [requireOwner(ownerCoreUserId), taskId.trim()]
  );
  return result.rows[0] ? toTask(result.rows[0]) : undefined;
}

export async function createDefinition(ownerCoreUserId: string, input: TaskDefinitionCreate, database?: LbsStoreDatabase): Promise<LBSTask> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<DefinitionRow>(
    `INSERT INTO task_definitions (owner_username, task_id, task_name, context, base_load_score, active, rule_type,
       due_date, mon, tue, wed, thu, fri, sat, sun, interval_days, anchor_date, month_day, nth_in_month,
       weekday_mon1, start_date, end_date, start_time, end_time, notes, external_sync_id, timezone, is_locked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING ${COLUMNS}`,
    [requireOwner(ownerCoreUserId), input.task_id?.trim() || randomUUID(), input.task_name.trim(), input.context.trim(),
      input.base_load_score, input.active ?? true, input.rule_type, input.due_date ?? null, input.mon ?? false,
      input.tue ?? false, input.wed ?? false, input.thu ?? false, input.fri ?? false, input.sat ?? false,
      input.sun ?? false, input.interval_days ?? null, input.anchor_date ?? null, input.month_day ?? null,
      input.nth_in_month ?? null, input.weekday_mon1 ?? null, input.start_date ?? null, input.end_date ?? null,
      input.start_time ?? null, input.end_time ?? null, input.notes ?? null, input.external_sync_id ?? null,
      input.timezone ?? "UTC", input.is_locked ?? false]
  );
  return toTask(result.rows[0]);
}

const UPDATE_COLUMNS: Record<keyof TaskDefinitionUpdate, string> = {
  task_name: "task_name", context: "context", base_load_score: "base_load_score", active: "active",
  rule_type: "rule_type", due_date: "due_date", mon: "mon", tue: "tue", wed: "wed", thu: "thu",
  fri: "fri", sat: "sat", sun: "sun", interval_days: "interval_days", anchor_date: "anchor_date",
  month_day: "month_day", nth_in_month: "nth_in_month", weekday_mon1: "weekday_mon1",
  start_date: "start_date", end_date: "end_date", start_time: "start_time", end_time: "end_time",
  notes: "notes", external_sync_id: "external_sync_id", timezone: "timezone", is_locked: "is_locked"
};

export async function updateDefinition(ownerCoreUserId: string, taskId: string, patch: TaskDefinitionUpdate, database?: LbsStoreDatabase): Promise<LBSTask | undefined> {
  const values: unknown[] = [requireOwner(ownerCoreUserId), taskId.trim()];
  const sets = ["updated_at = NOW()"];
  for (const [key, column] of Object.entries(UPDATE_COLUMNS) as Array<[keyof TaskDefinitionUpdate, string]>) {
    if (patch[key] !== undefined) { values.push(patch[key]); sets.push(`${column} = $${values.length}`); }
  }
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<DefinitionRow>(
    `UPDATE task_definitions SET ${sets.join(", ")} WHERE owner_username = $1 AND task_id = $2 RETURNING ${COLUMNS}`, values
  );
  return result.rows[0] ? toTask(result.rows[0]) : undefined;
}

export async function deleteDefinition(ownerCoreUserId: string, taskId: string, database?: LbsStoreDatabase): Promise<boolean> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query(`DELETE FROM task_definitions WHERE owner_username = $1 AND task_id = $2`, [requireOwner(ownerCoreUserId), taskId.trim()]);
  return (result.rowCount ?? 0) > 0;
}

export async function bulkDeleteDefinitions(ownerCoreUserId: string, taskIds: readonly string[], database?: LbsStoreDatabase): Promise<number> {
  if (taskIds.length === 0) return 0;
  const db = await getLbsStoreDatabase(database);
  const result = await db.query(
    `DELETE FROM task_definitions WHERE owner_username = $1 AND task_id = ANY($2::text[])`,
    [requireOwner(ownerCoreUserId), taskIds.map((id) => id.trim())]
  );
  return result.rowCount ?? 0;
}

export async function bulkUpdateDefinitionsActive(ownerCoreUserId: string, taskIds: readonly string[], active: boolean, database?: LbsStoreDatabase): Promise<LBSTask[]> {
  if (taskIds.length === 0) return [];
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<DefinitionRow>(
    `UPDATE task_definitions SET active = $3, updated_at = NOW()
     WHERE owner_username = $1 AND task_id = ANY($2::text[]) RETURNING ${COLUMNS}`,
    [requireOwner(ownerCoreUserId), taskIds.map((id) => id.trim()), active]
  );
  return result.rows.map(toTask);
}
