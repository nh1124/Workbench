import { randomUUID } from "node:crypto";
import { ensureTasksSchema, getTasksPool } from "./db.js";
import type { TaskSubtask } from "./types.js";

type SubtaskRow = {
  id: string;
  task_id: string;
  owner_username: string;
  occurrence_date: string;
  title: string;
  is_done: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

function normalizeOwner(ownerCoreUserId: string): string {
  return ownerCoreUserId.trim().toLowerCase();
}

function toSubtask(row: SubtaskRow): TaskSubtask {
  return {
    id: row.id,
    taskId: row.task_id,
    occurrenceDate: row.occurrence_date,
    title: row.title,
    isDone: row.is_done,
    sortOrder: row.sort_order,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function listSubtasks(
  taskId: string,
  occurrenceDate: string,
  ownerCoreUserId: string
): Promise<TaskSubtask[]> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const result = await pool.query<SubtaskRow>(
    `
      SELECT id, task_id, owner_username, occurrence_date, title, is_done, sort_order, created_at, updated_at
      FROM task_subtasks
      WHERE owner_username = $1 AND task_id = $2 AND occurrence_date = $3
      ORDER BY sort_order ASC, created_at ASC
    `,
    [owner, taskId, occurrenceDate]
  );

  return result.rows.map(toSubtask);
}

export async function createSubtask(
  taskId: string,
  occurrenceDate: string,
  ownerCoreUserId: string,
  title: string
): Promise<TaskSubtask> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const maxOrderResult = await pool.query<{ max: number | null }>(
    `
      SELECT MAX(sort_order) AS max
      FROM task_subtasks
      WHERE owner_username = $1 AND task_id = $2 AND occurrence_date = $3
    `,
    [owner, taskId, occurrenceDate]
  );

  const nextOrder = (maxOrderResult.rows[0].max ?? -1) + 1;
  const id = randomUUID();

  const result = await pool.query<SubtaskRow>(
    `
      INSERT INTO task_subtasks (id, task_id, owner_username, occurrence_date, title, is_done, sort_order)
      VALUES ($1, $2, $3, $4, $5, FALSE, $6)
      RETURNING id, task_id, owner_username, occurrence_date, title, is_done, sort_order, created_at, updated_at
    `,
    [id, taskId, owner, occurrenceDate, title.trim(), nextOrder]
  );

  return toSubtask(result.rows[0]);
}

export async function updateSubtask(
  subtaskId: string,
  taskId: string,
  ownerCoreUserId: string,
  updates: { title?: string; isDone?: boolean; sortOrder?: number }
): Promise<TaskSubtask | undefined> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const setClauses: string[] = ["updated_at = NOW()"];
  const values: unknown[] = [subtaskId, taskId, owner];
  let idx = 4;

  if (updates.title !== undefined) {
    setClauses.push(`title = $${idx}`);
    values.push(updates.title.trim());
    idx++;
  }
  if (updates.isDone !== undefined) {
    setClauses.push(`is_done = $${idx}`);
    values.push(updates.isDone);
    idx++;
  }
  if (updates.sortOrder !== undefined) {
    setClauses.push(`sort_order = $${idx}`);
    values.push(updates.sortOrder);
    idx++;
  }

  const result = await pool.query<SubtaskRow>(
    `
      UPDATE task_subtasks
      SET ${setClauses.join(", ")}
      WHERE id = $1 AND task_id = $2 AND owner_username = $3
      RETURNING id, task_id, owner_username, occurrence_date, title, is_done, sort_order, created_at, updated_at
    `,
    values
  );

  if (result.rows.length === 0) return undefined;
  return toSubtask(result.rows[0]);
}

export async function deleteSubtask(
  subtaskId: string,
  taskId: string,
  ownerCoreUserId: string
): Promise<boolean> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  const result = await pool.query(
    `
      DELETE FROM task_subtasks
      WHERE id = $1 AND task_id = $2 AND owner_username = $3
    `,
    [subtaskId, taskId, owner]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function deleteSubtasksForTask(taskId: string, ownerCoreUserId: string): Promise<void> {
  await ensureTasksSchema();
  const pool = getTasksPool();
  const owner = normalizeOwner(ownerCoreUserId);

  await pool.query(
    `
      DELETE FROM task_subtasks
      WHERE task_id = $1 AND owner_username = $2
    `,
    [taskId, owner]
  );
}
