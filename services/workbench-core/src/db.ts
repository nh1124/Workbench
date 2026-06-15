import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
  host: requireEnv("CORE_DB_HOST"),
  port: Number(requireEnv("CORE_DB_PORT")),
  database: requireEnv("CORE_DB_NAME"),
  user: requireEnv("CORE_DB_USER"),
  password: requireEnv("CORE_DB_PASSWORD")
});

const DB_STARTUP_RETRY_ATTEMPTS = 20;
const DB_STARTUP_RETRY_DELAY_MS = 1000;

let schemaReady: Promise<void> | undefined;

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

export async function ensureCoreSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await runWithDbStartupRetry(async () => {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS workbench_users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS integration_configs (
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            integration_id TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            values_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, integration_id)
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS service_provisionings (
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            service_id TEXT NOT NULL,
            status TEXT NOT NULL,
            message TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, service_id)
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS deep_research_jobs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            query TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            speed TEXT NOT NULL,
            timeout_sec INTEGER NOT NULL,
            async_on_timeout BOOLEAN NOT NULL DEFAULT TRUE,
            save_to_artifacts BOOLEAN NOT NULL DEFAULT FALSE,
            artifact_title TEXT,
            artifact_path TEXT,
            artifact_item_id TEXT,
            artifact_item_path TEXT,
            result_markdown TEXT,
            error_message TEXT,
            progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_deep_research_jobs_user_created_at
            ON deep_research_jobs (user_id, created_at DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS local_clients (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            device_id TEXT NOT NULL,
            client_name TEXT NOT NULL,
            platform TEXT NOT NULL,
            capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            sync_root_id TEXT NOT NULL,
            sync_root_label TEXT NOT NULL,
            is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (user_id, device_id, sync_root_id)
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_clients_user_updated
            ON local_clients (user_id, updated_at DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS local_client_tokens (
            id TEXT PRIMARY KEY,
            local_client_id TEXT NOT NULL REFERENCES local_clients(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_client_tokens_client_active
            ON local_client_tokens (local_client_id)
            WHERE revoked_at IS NULL;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS local_client_heartbeats (
            local_client_id TEXT PRIMARY KEY REFERENCES local_clients(id) ON DELETE CASCADE,
            daemon_version TEXT,
            sync_root_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS local_jobs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            local_client_id TEXT NOT NULL REFERENCES local_clients(id) ON DELETE CASCADE,
            idempotency_key TEXT,
            kind TEXT NOT NULL,
            target TEXT NOT NULL,
            payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            claimed_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            failed_at TIMESTAMPTZ,
            next_attempt_at TIMESTAMPTZ,
            expires_at TIMESTAMPTZ,
            result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            error_message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          ALTER TABLE local_jobs
            ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
            ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_jobs_client_status_created
            ON local_jobs (local_client_id, status, created_at ASC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_jobs_client_claimable
            ON local_jobs (local_client_id, status, next_attempt_at, created_at ASC)
            WHERE status = 'pending';
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_jobs_user_created
            ON local_jobs (user_id, created_at DESC);
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_local_jobs_idempotency_active
            ON local_jobs (user_id, local_client_id, idempotency_key)
            WHERE idempotency_key IS NOT NULL
              AND status IN ('pending', 'running', 'completed');
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS local_job_events (
            id BIGSERIAL PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES local_jobs(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            local_client_id TEXT NOT NULL REFERENCES local_clients(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_job_events_job_created
            ON local_job_events (job_id, created_at ASC, id ASC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_job_events_user_created
            ON local_job_events (user_id, created_at DESC, id DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS local_client_audit_events (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            local_client_id TEXT REFERENCES local_clients(id) ON DELETE SET NULL,
            event_type TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT,
            detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_client_audit_events_user_created
            ON local_client_audit_events (user_id, created_at DESC, id DESC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_local_client_audit_events_client_created
            ON local_client_audit_events (local_client_id, created_at DESC, id DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS sync_resource_versions (
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            domain TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ,
            PRIMARY KEY (user_id, domain, resource_id)
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS sync_events (
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES workbench_users(id) ON DELETE CASCADE,
            domain TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            action TEXT NOT NULL,
            version INTEGER NOT NULL,
            payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_sync_events_user_id
            ON sync_events (user_id, id ASC);
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

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const original = Buffer.from(hash, "hex");
  if (derived.length !== original.length) return false;
  return timingSafeEqual(derived, original);
}

export function getCorePool(): Pool {
  return pool;
}
