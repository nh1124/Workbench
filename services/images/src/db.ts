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
  host: requireEnv("IMAGES_DB_HOST"),
  port: Number(requireEnv("IMAGES_DB_PORT")),
  database: requireEnv("IMAGES_DB_NAME"),
  user: requireEnv("IMAGES_DB_USER"),
  password: requireEnv("IMAGES_DB_PASSWORD")
});

// pg emits this when an idle pooled client's connection drops: a database
// restart, a network blip, an idle timeout. Without a listener Node treats it
// as an unhandled 'error' event and kills the process — and these services are
// supervised together by `concurrently -k`, so one of them dying takes all of
// them down until someone restarts them by hand. The pool discards the broken
// client and reconnects on the next query by itself, so logging is all that is
// owed here.
pool.on("error", (error) => {
  console.error("[db] idle client error", error);
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

export async function ensureImagesSchema(): Promise<void> {
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
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_images_service_accounts_core_user_id ON service_accounts(core_user_id);`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS image_generation_jobs (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            status TEXT NOT NULL,
            intent TEXT NOT NULL DEFAULT 'create',
            parent_job_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt TEXT NOT NULL,
            instruction TEXT,
            negative_prompt TEXT,
            request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            context_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            error_code TEXT,
            error_message TEXT,
            save_to_artifacts BOOLEAN NOT NULL DEFAULT false,
            project_id TEXT,
            project_name TEXT,
            artifact_title TEXT,
            artifact_path TEXT,
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
          );
        `);

        await pool.query(`ALTER TABLE image_generation_jobs ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'create';`);
        await pool.query(`ALTER TABLE image_generation_jobs ADD COLUMN IF NOT EXISTS parent_job_id TEXT;`);
        await pool.query(`ALTER TABLE image_generation_jobs ADD COLUMN IF NOT EXISTS instruction TEXT;`);
        await pool.query(`ALTER TABLE image_generation_jobs ADD COLUMN IF NOT EXISTS context_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb;`);
        await pool.query(`ALTER TABLE image_generation_jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_image_jobs_owner_updated
          ON image_generation_jobs(owner_core_user_id, updated_at DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS image_references (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            purpose TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER,
            height INTEGER,
            size_bytes BIGINT NOT NULL,
            sha256 TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            project_id TEXT,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
          );
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_image_references_owner_created
          ON image_references(owner_core_user_id, created_at DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS image_assets (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES image_generation_jobs(id) ON DELETE CASCADE,
            owner_core_user_id TEXT NOT NULL,
            source_asset_id TEXT,
            source_reference_id TEXT,
            index_in_job INTEGER NOT NULL DEFAULT 0,
            mime_type TEXT NOT NULL,
            width INTEGER,
            height INTEGER,
            size_bytes BIGINT NOT NULL,
            sha256 TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            original_provider_url TEXT,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            artifact_item_id TEXT,
            artifact_item_path TEXT,
            artifact_title TEXT,
            project_id TEXT,
            project_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
          );
        `);
        await pool.query(`ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS source_asset_id TEXT;`);
        await pool.query(`ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS source_reference_id TEXT;`);
        await pool.query(`ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS artifact_title TEXT;`);
        await pool.query(`ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS project_id TEXT;`);
        await pool.query(`ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS project_name TEXT;`);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_image_assets_owner_created
          ON image_assets(owner_core_user_id, created_at DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS image_job_events (
            id BIGSERIAL PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES image_generation_jobs(id) ON DELETE CASCADE,
            owner_core_user_id TEXT NOT NULL,
            level TEXT NOT NULL,
            stage TEXT,
            message TEXT NOT NULL,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS image_job_inputs (
            id BIGSERIAL PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES image_generation_jobs(id) ON DELETE CASCADE,
            owner_core_user_id TEXT NOT NULL,
            input_kind TEXT NOT NULL,
            input_id TEXT,
            input_summary TEXT,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
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
  await ensureImagesSchema();
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
  await ensureImagesSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const result = await pool.query<{
    id: string;
    core_user_id: string | null;
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
  if (!row || !row.core_user_id) return undefined;

  return {
    id: row.id,
    coreUserId: row.core_user_id,
    usernameSnapshot: (row.username_snapshot ?? row.username ?? "unknown").trim().toLowerCase()
  };
}

export function getImagesPool(): Pool {
  return pool;
}
