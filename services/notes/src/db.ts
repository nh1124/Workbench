import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
  host: requireEnv("NOTES_DB_HOST"),
  port: Number(requireEnv("NOTES_DB_PORT")),
  database: requireEnv("NOTES_DB_NAME"),
  user: requireEnv("NOTES_DB_USER"),
  password: requireEnv("NOTES_DB_PASSWORD")
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

export async function ensureNotesSchema(): Promise<void> {
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
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_notes_service_accounts_core_user_id ON service_accounts(core_user_id);`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            owner_username TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            project_id TEXT NOT NULL,
            project_name TEXT,
            tags JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_notes_owner_updated
          ON notes(owner_username, updated_at DESC);
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
  await ensureNotesSchema();
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
        updated_at = NOW();
    `,
    [id, normalizedCoreUserId, normalizedUsername]
  );
}

export async function findServiceAccountByCoreUserId(coreUserId: string): Promise<ServiceAccount | undefined> {
  await ensureNotesSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const result = await pool.query<{ id: string; core_user_id: string | null; username_snapshot: string | null; username: string | null }>(
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

export function getNotesPool(): Pool {
  return pool;
}
