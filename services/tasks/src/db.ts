import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { Task } from "./types.js";

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

export interface ServiceAccount {
  id: string;
  coreUserId: string;
  usernameSnapshot: string;
  lbsAccessToken?: string;
  lbsRefreshToken?: string;
}

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

function accountIdFromCoreUserId(coreUserId: string): string {
  return createHash("sha256").update(coreUserId).digest("hex").slice(0, 32);
}

export async function upsertServiceAccount(
  coreUserId: string,
  usernameSnapshot: string,
  tokens?: { accessToken?: string; refreshToken?: string }
): Promise<void> {
  await ensureTasksSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const normalizedUsername = usernameSnapshot.trim().toLowerCase();
  if (!normalizedCoreUserId || !normalizedUsername) {
    throw new Error("coreUserId and username are required");
  }

  const id = accountIdFromCoreUserId(normalizedCoreUserId);

  await pool.query(
    `
      INSERT INTO service_accounts (id, core_user_id, username_snapshot, username, password_hash)
      VALUES ($1, $2, $3, $3, $2)
      ON CONFLICT (core_user_id)
      DO UPDATE SET
        username_snapshot = EXCLUDED.username_snapshot,
        username = EXCLUDED.username,
        lbs_access_token = COALESCE($4, service_accounts.lbs_access_token),
        lbs_refresh_token = COALESCE($5, service_accounts.lbs_refresh_token),
        lbs_token_updated_at = CASE
          WHEN $4 IS NOT NULL OR $5 IS NOT NULL THEN NOW()
          ELSE service_accounts.lbs_token_updated_at
        END,
        updated_at = NOW();
    `,
    [id, normalizedCoreUserId, normalizedUsername, tokens?.accessToken ?? null, tokens?.refreshToken ?? null]
  );
}

export async function findServiceAccountByCoreUserId(coreUserId: string): Promise<ServiceAccount | undefined> {
  await ensureTasksSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const result = await pool.query<{
    id: string;
    core_user_id: string | null;
    username_snapshot: string | null;
    username: string | null;
    lbs_access_token: string | null;
    lbs_refresh_token: string | null;
  }>(
    `
      SELECT id, core_user_id, username_snapshot, username, lbs_access_token, lbs_refresh_token
      FROM service_accounts
      WHERE core_user_id = $1
      LIMIT 1
    `,
    [normalizedCoreUserId]
  );

  const row = result.rows[0];
  if (!row || !row.core_user_id) return undefined;

  return {
    id: row.id,
    coreUserId: row.core_user_id,
    usernameSnapshot: (row.username_snapshot ?? row.username ?? "unknown").trim().toLowerCase(),
    lbsAccessToken: row.lbs_access_token ?? undefined,
    lbsRefreshToken: row.lbs_refresh_token ?? undefined
  };
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
