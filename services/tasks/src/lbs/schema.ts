import type { Pool } from "pg";

type SchemaDatabase = Pick<Pool, "query">;

export async function ensureLbsSchema(database: SchemaDatabase): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS task_definitions (
      owner_username TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      context TEXT NOT NULL,
      base_load_score DOUBLE PRECISION NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      rule_type TEXT NOT NULL,
      due_date TEXT,
      mon BOOLEAN NOT NULL DEFAULT FALSE,
      tue BOOLEAN NOT NULL DEFAULT FALSE,
      wed BOOLEAN NOT NULL DEFAULT FALSE,
      thu BOOLEAN NOT NULL DEFAULT FALSE,
      fri BOOLEAN NOT NULL DEFAULT FALSE,
      sat BOOLEAN NOT NULL DEFAULT FALSE,
      sun BOOLEAN NOT NULL DEFAULT FALSE,
      interval_days INTEGER,
      anchor_date TEXT,
      month_day INTEGER,
      nth_in_month INTEGER,
      weekday_mon1 INTEGER,
      start_date TEXT,
      end_date TEXT,
      start_time TEXT,
      end_time TEXT,
      notes TEXT,
      external_sync_id TEXT,
      timezone TEXT DEFAULT 'UTC',
      is_locked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_username, task_id)
    );
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS task_rule_exceptions (
      id SERIAL PRIMARY KEY,
      owner_username TEXT NOT NULL,
      task_id TEXT NOT NULL,
      target_date TEXT NOT NULL,
      exception_type TEXT NOT NULL CHECK (
        exception_type IN ('SKIP', 'FORCE_DO', 'MANUAL_LOCK', 'OVERRIDE_LOAD', 'RESCHEDULE')
      ),
      override_load_value DOUBLE PRECISION,
      start_time TEXT,
      end_time TEXT,
      notes TEXT,
      is_locked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (owner_username, task_id)
        REFERENCES task_definitions(owner_username, task_id) ON DELETE CASCADE
    );
  `);

  await database.query(`
    CREATE INDEX IF NOT EXISTS idx_task_rule_exceptions_owner_task_date
    ON task_rule_exceptions(owner_username, task_id, target_date);
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS task_executions (
      id SERIAL PRIMARY KEY,
      owner_username TEXT NOT NULL,
      task_id TEXT NOT NULL,
      target_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('todo', 'done', 'skipped')),
      progress INTEGER NOT NULL DEFAULT 100,
      actual_time INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner_username, task_id, target_date),
      FOREIGN KEY (owner_username, task_id)
        REFERENCES task_definitions(owner_username, task_id) ON DELETE CASCADE
    );
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS daily_conditions (
      owner_username TEXT NOT NULL,
      target_date TEXT NOT NULL,
      cognitive_fatigue INTEGER NOT NULL DEFAULT 0,
      physical_fatigue INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_username, target_date)
    );
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS lbs_user_config (
      owner_username TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_username, key)
    );
  `);
}
