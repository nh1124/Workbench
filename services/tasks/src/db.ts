import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { Task } from "./types.js";
import { ensureLbsSchema } from "./lbs/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, "../.env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const pool = new Pool({
  host: requireEnv("TASKS_DB_HOST"),
  port: Number(requireEnv("TASKS_DB_PORT")),
  database: requireEnv("TASKS_DB_NAME"),
  user: requireEnv("TASKS_DB_USER"),
  password: requireEnv("TASKS_DB_PASSWORD")
});

const DB_STARTUP_RETRY_ATTEMPTS = 20;
const DB_STARTUP_RETRY_DELAY_MS = 1000;

let schemaReady: Promise<void> | undefined;

function normalizeOwner(ownerCoreUserId: string): string {
  return ownerCoreUserId.trim().toLowerCase();
}

function isTransientStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const codeValue = (error as { code?: unknown }).code;
  const code = typeof codeValue === "string" ? codeValue : "";
  if (["57P03", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(code)) {
    return true;
  }

  const message = error.message.toLowerCase();
  return message.includes("connection terminated unexpectedly") || message.includes("the database system is starting up");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runWithDbStartupRetry(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= DB_STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isTransientStartupError(error) || attempt === DB_STARTUP_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(DB_STARTUP_RETRY_DELAY_MS);
    }
  }
}

export async function ensureTasksSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await runWithDbStartupRetry(async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS service_accounts (
            id TEXT PRIMARY KEY,
            core_user_id TEXT UNIQUE,
            username_snapshot TEXT,
            username TEXT,
            password_hash TEXT,
            lbs_access_token TEXT,
            lbs_refresh_token TEXT,
            lbs_token_updated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS core_user_id TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS username_snapshot TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS username TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
        // Legacy LBS token columns remain for rollback/schema compatibility only.
        // Runtime code intentionally does not read or write them.
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS lbs_access_token TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS lbs_refresh_token TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS lbs_token_updated_at TIMESTAMPTZ;`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_service_accounts_core_user_id ON service_accounts(core_user_id);`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_cache (
            owner_username TEXT NOT NULL,
            task_id TEXT NOT NULL,
            payload JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (owner_username, task_id)
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_pins (
            owner_username TEXT NOT NULL,
            task_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (owner_username, task_id)
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_attachments (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            owner_username TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT,
            size_bytes BIGINT,
            storage_path TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_task_attachments_owner_task
          ON task_attachments(owner_username, task_id);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_subtasks (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            owner_username TEXT NOT NULL,
            occurrence_date TEXT NOT NULL,
            title TEXT NOT NULL,
            is_done BOOLEAN NOT NULL DEFAULT FALSE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_task_subtasks_owner_task_date
          ON task_subtasks(owner_username, task_id, occurrence_date);
        `);

        // Occurrence schedule: replaces the old task_today / task_today_refresh_log tables.
        //   occurrence_date = LBS execution date (used for task completion)
        //   scheduled_date  = calendar date the user plans to work on the task
        //                     (matches Today's date when added via "My Day" button)
        // Migrate: drop old ephemeral tables if they still exist.
        await pool.query(`DROP TABLE IF EXISTS task_today;`);
        await pool.query(`DROP TABLE IF EXISTS task_today_refresh_log;`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS task_occurrence_schedule (
            id               BIGSERIAL PRIMARY KEY,
            owner_username   TEXT NOT NULL,
            task_id          TEXT NOT NULL,
            occurrence_date  TEXT NOT NULL,
            scheduled_date   TEXT NOT NULL,
            start_time       TEXT,
            end_time         TEXT,
            timezone         TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY owner_username, task_id, occurrence_date, scheduled_date
                ORDER BY updated_at DESC, created_at DESC, id DESC
              ) AS duplicate_rank
            FROM task_occurrence_schedule
          )
          DELETE FROM task_occurrence_schedule schedule
          USING ranked
          WHERE schedule.id = ranked.id
            AND ranked.duplicate_rank > 1;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_task_occ_schedule_owner_scheduled_date
          ON task_occurrence_schedule(owner_username, scheduled_date);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_task_occ_schedule_owner_task_occ
          ON task_occurrence_schedule(owner_username, task_id, occurrence_date);
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_task_occ_schedule_owner_task_occ_scheduled
          ON task_occurrence_schedule(owner_username, task_id, occurrence_date, scheduled_date);
        `);

        await ensureLbsSchema(pool);
      });
    })();
  }

  try {
    await schemaReady;
  } catch (error) {
    schemaReady = undefined;
    throw error;
  }
}

export async function cacheTasks(tasks: Task[], ownerCoreUserId: string): Promise<void> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) {
    throw new Error("Owner core user id is required");
  }

  for (const task of tasks) {
    await pool.query(
      `
        INSERT INTO task_cache (owner_username, task_id, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (owner_username, task_id)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();
      `,
      [owner, task.id, JSON.stringify(task)]
    );
  }
}

export function getTasksPool(): Pool {
  return pool;
}

export async function listPinnedTaskIds(ownerCoreUserId: string): Promise<string[]> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return [];

  const result = await pool.query<{ task_id: string }>(
    `
      SELECT task_id
      FROM task_pins
      WHERE owner_username = $1
      ORDER BY created_at DESC
    `,
    [owner]
  );
  return result.rows.map((row) => row.task_id);
}

// ── Occurrence schedule ───────────────────────────────────────────────────────

export interface ScheduleItemRow {
  id: number;
  taskId: string;
  occurrenceDate: string;
  scheduledDate: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToScheduleItem(r: {
  id: string | number;
  task_id: string;
  occurrence_date: string;
  scheduled_date: string;
  start_time: string | null;
  end_time: string | null;
  timezone: string | null;
  created_at: string;
  updated_at: string;
}): ScheduleItemRow {
  return {
    id: typeof r.id === "string" ? parseInt(r.id, 10) : r.id,
    taskId: r.task_id,
    occurrenceDate: r.occurrence_date,
    scheduledDate: r.scheduled_date,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    timezone: r.timezone ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

/**
 * List all schedule items for a given scheduled_date (Today/calendar view).
 */
export async function listScheduleItemsByScheduledDate(
  ownerCoreUserId: string,
  scheduledDate: string
): Promise<ScheduleItemRow[]> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return [];

  const result = await pool.query<{
    id: string;
    task_id: string;
    occurrence_date: string;
    scheduled_date: string;
    start_time: string | null;
    end_time: string | null;
    timezone: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
      FROM task_occurrence_schedule
      WHERE owner_username = $1 AND scheduled_date = $2
      ORDER BY start_time ASC NULLS LAST, created_at ASC
    `,
    [owner, scheduledDate]
  );
  return result.rows.map(rowToScheduleItem);
}

/**
 * List all schedule items for a date range (calendar view).
 */
export async function listScheduleItemsByDateRange(
  ownerCoreUserId: string,
  startDate: string,
  endDate: string
): Promise<ScheduleItemRow[]> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return [];

  const result = await pool.query<{
    id: string;
    task_id: string;
    occurrence_date: string;
    scheduled_date: string;
    start_time: string | null;
    end_time: string | null;
    timezone: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
      FROM task_occurrence_schedule
      WHERE owner_username = $1 AND scheduled_date >= $2 AND scheduled_date <= $3
      ORDER BY scheduled_date ASC, start_time ASC NULLS LAST, created_at ASC
    `,
    [owner, startDate, endDate]
  );
  return result.rows.map(rowToScheduleItem);
}

/**
 * List schedule items that either appear in the calendar window or override
 * an occurrence in that window.
 */
export async function listScheduleItemsForCalendarWindow(
  ownerCoreUserId: string,
  startDate: string,
  endDate: string
): Promise<ScheduleItemRow[]> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return [];

  const result = await pool.query<{
    id: string;
    task_id: string;
    occurrence_date: string;
    scheduled_date: string;
    start_time: string | null;
    end_time: string | null;
    timezone: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
      FROM task_occurrence_schedule
      WHERE owner_username = $1
        AND (
          (scheduled_date >= $2 AND scheduled_date <= $3)
          OR (occurrence_date >= $2 AND occurrence_date <= $3)
        )
      ORDER BY scheduled_date ASC, start_time ASC NULLS LAST, created_at ASC
    `,
    [owner, startDate, endDate]
  );
  return result.rows.map(rowToScheduleItem);
}

/**
 * List all schedule items for a specific task (all occurrences).
 */
export async function listScheduleItemsByTask(
  ownerCoreUserId: string,
  taskId: string
): Promise<ScheduleItemRow[]> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return [];

  const result = await pool.query<{
    id: string;
    task_id: string;
    occurrence_date: string;
    scheduled_date: string;
    start_time: string | null;
    end_time: string | null;
    timezone: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
      FROM task_occurrence_schedule
      WHERE owner_username = $1 AND task_id = $2
      ORDER BY scheduled_date ASC, start_time ASC NULLS LAST
    `,
    [owner, taskId.trim()]
  );
  return result.rows.map(rowToScheduleItem);
}

/**
 * Create a new schedule item. Returns the created row.
 */
export async function createScheduleItem(
  ownerCoreUserId: string,
  taskId: string,
  occurrenceDate: string,
  scheduledDate: string,
  opts?: { startTime?: string; endTime?: string; timezone?: string }
): Promise<ScheduleItemRow> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const tid = taskId.trim();
  const occurrence = occurrenceDate.trim();
  const scheduled = scheduledDate.trim();
  if (!owner || !tid || !occurrence || !scheduled) {
    throw new Error("owner, taskId, occurrenceDate, and scheduledDate are required");
  }

  const result = await pool.query<{
    id: string;
    task_id: string;
    occurrence_date: string;
    scheduled_date: string;
    start_time: string | null;
    end_time: string | null;
    timezone: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      INSERT INTO task_occurrence_schedule
        (owner_username, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (owner_username, task_id, occurrence_date, scheduled_date)
      DO UPDATE SET
        start_time = COALESCE(EXCLUDED.start_time, task_occurrence_schedule.start_time),
        end_time = COALESCE(EXCLUDED.end_time, task_occurrence_schedule.end_time),
        timezone = COALESCE(EXCLUDED.timezone, task_occurrence_schedule.timezone),
        updated_at = NOW()
      RETURNING id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
    `,
    [owner, tid, occurrence, scheduled, opts?.startTime ?? null, opts?.endTime ?? null, opts?.timezone ?? null]
  );
  return rowToScheduleItem(result.rows[0]);
}

/**
 * Update an existing schedule item by id.
 */
export async function updateScheduleItem(
  ownerCoreUserId: string,
  id: number,
  patch: { scheduledDate?: string; occurrenceDate?: string; startTime?: string | null; endTime?: string | null; timezone?: string | null }
): Promise<ScheduleItemRow | undefined> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return undefined;

  type ScheduleItemDbRow = {
    id: string;
    task_id: string;
    occurrence_date: string;
    scheduled_date: string;
    start_time: string | null;
    end_time: string | null;
    timezone: string | null;
    created_at: string;
    updated_at: string;
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<ScheduleItemDbRow>(
      `
        SELECT id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
        FROM task_occurrence_schedule
        WHERE owner_username = $1 AND id = $2
        FOR UPDATE
      `,
      [owner, id]
    );
    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }

    const current = currentResult.rows[0];
    const nextScheduledDate = patch.scheduledDate !== undefined
      ? patch.scheduledDate.trim()
      : current.scheduled_date;
    const nextOccurrenceDate = patch.occurrenceDate !== undefined
      ? patch.occurrenceDate.trim()
      : current.occurrence_date;
    if (!nextScheduledDate || !nextOccurrenceDate) {
      throw new Error("scheduledDate and occurrenceDate must be non-empty when provided");
    }

    const nextStartTime = "startTime" in patch ? patch.startTime ?? null : current.start_time;
    const nextEndTime = "endTime" in patch ? patch.endTime ?? null : current.end_time;
    const nextTimezone = "timezone" in patch ? patch.timezone ?? null : current.timezone;

    const conflictResult = await client.query<ScheduleItemDbRow>(
      `
        SELECT id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
        FROM task_occurrence_schedule
        WHERE owner_username = $1
          AND task_id = $2
          AND occurrence_date = $3
          AND scheduled_date = $4
          AND id <> $5
        FOR UPDATE
      `,
      [owner, current.task_id, nextOccurrenceDate, nextScheduledDate, id]
    );

    if (conflictResult.rows.length > 0) {
      const conflict = conflictResult.rows[0];
      const mergedResult = await client.query<ScheduleItemDbRow>(
        `
          UPDATE task_occurrence_schedule
          SET
            start_time = $3,
            end_time = $4,
            timezone = $5,
            updated_at = NOW()
          WHERE owner_username = $1 AND id = $2
          RETURNING id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
        `,
        [owner, conflict.id, nextStartTime, nextEndTime, nextTimezone]
      );
      await client.query(
        `DELETE FROM task_occurrence_schedule WHERE owner_username = $1 AND id = $2`,
        [owner, id]
      );
      await client.query("COMMIT");
      return rowToScheduleItem(mergedResult.rows[0]);
    }

    const result = await client.query<ScheduleItemDbRow>(
      `
        UPDATE task_occurrence_schedule
        SET
          scheduled_date = $3,
          occurrence_date = $4,
          start_time = $5,
          end_time = $6,
          timezone = $7,
          updated_at = NOW()
        WHERE owner_username = $1 AND id = $2
        RETURNING id, task_id, occurrence_date, scheduled_date, start_time, end_time, timezone, created_at, updated_at
      `,
      [owner, id, nextScheduledDate, nextOccurrenceDate, nextStartTime, nextEndTime, nextTimezone]
    );
    await client.query("COMMIT");
    return rowToScheduleItem(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete a single schedule item by id.
 */
export async function deleteScheduleItem(ownerCoreUserId: string, id: number): Promise<boolean> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  if (!owner) return false;

  const result = await pool.query(
    `DELETE FROM task_occurrence_schedule WHERE owner_username = $1 AND id = $2`,
    [owner, id]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Delete one occurrence-level Today/schedule membership by its natural key.
 */
export async function deleteScheduleItemByTaskOccurrenceAndScheduledDate(
  ownerCoreUserId: string,
  taskId: string,
  scheduledDate: string,
  occurrenceDate: string
): Promise<number> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const tid = taskId.trim();
  const scheduled = scheduledDate.trim();
  const occurrence = occurrenceDate.trim();
  if (!owner || !tid || !scheduled || !occurrence) return 0;

  const result = await pool.query(
    `
      DELETE FROM task_occurrence_schedule
      WHERE owner_username = $1
        AND task_id = $2
        AND scheduled_date = $3
        AND occurrence_date = $4
    `,
    [owner, tid, scheduled, occurrence]
  );
  return result.rowCount ?? 0;
}

/**
 * Delete all schedule items for a task + scheduled_date pair.
 * Compatibility fallback for old clients that do not pass occurrenceDate.
 */
export async function deleteScheduleItemsByTaskAndScheduledDate(
  ownerCoreUserId: string,
  taskId: string,
  scheduledDate: string
): Promise<number> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const tid = taskId.trim();
  const scheduled = scheduledDate.trim();
  if (!owner || !tid || !scheduled) return 0;

  const result = await pool.query(
    `
      DELETE FROM task_occurrence_schedule
      WHERE owner_username = $1 AND task_id = $2 AND scheduled_date = $3
    `,
    [owner, tid, scheduled]
  );
  return result.rowCount ?? 0;
}

export async function setTaskPinned(ownerCoreUserId: string, taskId: string, pinned: boolean): Promise<void> {
  await ensureTasksSchema();
  const owner = normalizeOwner(ownerCoreUserId);
  const normalizedTaskId = taskId.trim();
  if (!owner || !normalizedTaskId) {
    throw new Error("owner and taskId are required");
  }

  if (pinned) {
    await pool.query(
      `
        INSERT INTO task_pins (owner_username, task_id, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (owner_username, task_id)
        DO NOTHING
      `,
      [owner, normalizedTaskId]
    );
    return;
  }

  await pool.query(
    `
      DELETE FROM task_pins
      WHERE owner_username = $1
        AND task_id = $2
    `,
    [owner, normalizedTaskId]
  );
}
