import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

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
  host: requireEnv("WBS_DB_HOST"),
  port: Number(requireEnv("WBS_DB_PORT")),
  database: requireEnv("WBS_DB_NAME"),
  user: requireEnv("WBS_DB_USER"),
  password: requireEnv("WBS_DB_PASSWORD")
});

const DB_STARTUP_RETRY_ATTEMPTS = 20;
const DB_STARTUP_RETRY_DELAY_MS = 1000;

let schemaReady: Promise<void> | undefined;

export interface ServiceAccount {
  id: string;
  coreUserId: string;
  usernameSnapshot: string;
}

function isTransientStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
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

export async function ensureWbsSchema(): Promise<void> {
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
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS core_user_id TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS username_snapshot TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS username TEXT;`);
        await pool.query(`ALTER TABLE service_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_wbs_service_accounts_core_user_id ON service_accounts(core_user_id);`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS wbs_plans (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            project_id TEXT,
            project_name TEXT,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            version INTEGER NOT NULL DEFAULT 1,
            deleted_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await pool.query(`ALTER TABLE wbs_plans ADD COLUMN IF NOT EXISTS project_id TEXT;`);
        await pool.query(`ALTER TABLE wbs_plans ADD COLUMN IF NOT EXISTS project_name TEXT;`);
        await pool.query(`ALTER TABLE wbs_plans ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;`);
        await pool.query(`ALTER TABLE wbs_plans ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_plans_owner_updated
          ON wbs_plans(owner_core_user_id, updated_at DESC, id DESC)
          WHERE deleted_at IS NULL;
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_plans_owner_project_updated
          ON wbs_plans(owner_core_user_id, project_id, updated_at DESC, id DESC)
          WHERE deleted_at IS NULL;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS wbs_items (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            parent_id TEXT,
            code TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            owner_label TEXT,
            start_date TEXT,
            due_date TEXT,
            effort_hours NUMERIC,
            status TEXT NOT NULL DEFAULT 'todo',
            progress INTEGER,
            linked_task_id TEXT,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            version INTEGER NOT NULL DEFAULT 1,
            deleted_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS parent_id TEXT;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS owner_label TEXT;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS start_date TEXT;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS due_date TEXT;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS effort_hours NUMERIC;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS progress INTEGER;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS linked_task_id TEXT;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;`);
        await pool.query(`ALTER TABLE wbs_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_items_owner_plan_parent_sort
          ON wbs_items(owner_core_user_id, plan_id, parent_id, sort_order, id)
          WHERE deleted_at IS NULL;
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_items_owner_plan_code
          ON wbs_items(owner_core_user_id, plan_id, code)
          WHERE deleted_at IS NULL;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS wbs_dependencies (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            from_item_id TEXT NOT NULL,
            to_item_id TEXT NOT NULL,
            dependency_type TEXT NOT NULL,
            lag_days INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_dependencies_owner_plan
          ON wbs_dependencies(owner_core_user_id, plan_id, created_at DESC, id DESC);
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_dependencies_owner_items
          ON wbs_dependencies(owner_core_user_id, from_item_id, to_item_id);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS wbs_artifact_exports (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            source_version INTEGER NOT NULL,
            artifact_item_id TEXT NOT NULL,
            artifact_path TEXT,
            format TEXT NOT NULL,
            exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_wbs_artifact_exports_owner_plan_exported
          ON wbs_artifact_exports(owner_core_user_id, plan_id, exported_at DESC, id DESC);
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

export async function upsertServiceAccount(coreUserId: string, usernameSnapshot: string): Promise<void> {
  await ensureWbsSchema();
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
        updated_at = NOW()
    `,
    [id, normalizedCoreUserId, normalizedUsername]
  );
}

export async function findServiceAccountByCoreUserId(coreUserId: string): Promise<ServiceAccount | undefined> {
  await ensureWbsSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const result = await pool.query<{
    id: string;
    core_user_id: string;
    username_snapshot: string | null;
    username: string | null;
  }>(
    `
      SELECT id, core_user_id, username_snapshot, username
      FROM service_accounts
      WHERE core_user_id = $1
      LIMIT 1
    `,
    [normalizedCoreUserId]
  );

  const row = result.rows[0];
  if (!row) return undefined;

  return {
    id: row.id,
    coreUserId: row.core_user_id,
    usernameSnapshot: (row.username_snapshot ?? row.username ?? "unknown").trim().toLowerCase()
  };
}

export function getWbsPool(): Pool {
  return pool;
}
