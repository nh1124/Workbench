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
  host: requireEnv("MINDMAPS_DB_HOST"),
  port: Number(requireEnv("MINDMAPS_DB_PORT")),
  database: requireEnv("MINDMAPS_DB_NAME"),
  user: requireEnv("MINDMAPS_DB_USER"),
  password: requireEnv("MINDMAPS_DB_PASSWORD")
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

export async function ensureMindmapsSchema(): Promise<void> {
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
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_mindmaps_service_accounts_core_user_id ON service_accounts(core_user_id);`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS mindmap_documents (
            id TEXT PRIMARY KEY,
            owner_core_user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            mode TEXT NOT NULL DEFAULT 'mindmap',
            project_id TEXT,
            project_name TEXT,
            body_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            tags TEXT[] NOT NULL DEFAULT '{}',
            search_text TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
          );
        `);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS description TEXT;`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'mindmap';`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS project_id TEXT;`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS project_name TEXT;`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;`);
        await pool.query(`ALTER TABLE mindmap_documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_mindmap_documents_owner_updated
          ON mindmap_documents(owner_core_user_id, updated_at DESC)
          WHERE deleted_at IS NULL;
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_mindmap_documents_owner_project_updated
          ON mindmap_documents(owner_core_user_id, project_id, updated_at DESC)
          WHERE deleted_at IS NULL;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS mindmap_artifact_exports (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES mindmap_documents(id) ON DELETE CASCADE,
            owner_core_user_id TEXT NOT NULL,
            source_version INTEGER NOT NULL,
            artifact_item_id TEXT NOT NULL,
            artifact_item_path TEXT,
            artifact_title TEXT,
            project_id TEXT,
            project_name TEXT,
            export_format TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_mindmap_artifact_exports_document_created
          ON mindmap_artifact_exports(document_id, created_at DESC);
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
  await ensureMindmapsSchema();
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
  await ensureMindmapsSchema();
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

export function getMindmapsPool(): Pool {
  return pool;
}
