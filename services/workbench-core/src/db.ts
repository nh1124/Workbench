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
