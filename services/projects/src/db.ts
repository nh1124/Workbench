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
  host: requireEnv("PROJECTS_DB_HOST"),
  port: Number(requireEnv("PROJECTS_DB_PORT")),
  database: requireEnv("PROJECTS_DB_NAME"),
  user: requireEnv("PROJECTS_DB_USER"),
  password: requireEnv("PROJECTS_DB_PASSWORD")
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

export async function ensureProjectsSchema(): Promise<void> {
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
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_service_accounts_core_user_id ON service_accounts(core_user_id);`);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            is_fallback_default BOOLEAN NOT NULL DEFAULT FALSE,
            owner_account_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_fallback_default BOOLEAN NOT NULL DEFAULT FALSE;`);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_owner_fallback_default
          ON projects(owner_account_id)
          WHERE is_fallback_default = TRUE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_projects_owner_status_updated
          ON projects(owner_account_id, status, updated_at DESC, id DESC);
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_links (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            target_service TEXT NOT NULL,
            target_resource_type TEXT NOT NULL,
            target_resource_id TEXT NOT NULL,
            relation_type TEXT NOT NULL DEFAULT 'reference',
            title_snapshot TEXT,
            summary_snapshot TEXT,
            linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_deleted BOOLEAN NOT NULL DEFAULT FALSE
          );
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_project_links_active
          ON project_links(project_id, target_service, target_resource_type, target_resource_id, relation_type)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_links_project_linked
          ON project_links(project_id, linked_at DESC, id DESC)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_links_target_lookup
          ON project_links(target_service, target_resource_type, target_resource_id)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_links_target_relation_lookup
          ON project_links(target_service, target_resource_type, target_resource_id, relation_type, linked_at DESC, id DESC)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_briefs (
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            content_markdown TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
            updated_by_kind TEXT NOT NULL CHECK (updated_by_kind IN ('user', 'agent')),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_memory_entries (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('decision', 'fact', 'preference', 'pitfall', 'observation')),
            body_markdown TEXT NOT NULL,
            authority TEXT NOT NULL CHECK (authority IN ('user_confirmed', 'agent_observed', 'imported')),
            source_service TEXT,
            source_resource_type TEXT,
            source_resource_id TEXT,
            confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
            supersedes_id TEXT REFERENCES project_memory_entries(id) ON DELETE SET NULL,
            lifecycle_state TEXT NOT NULL DEFAULT 'triaged' CHECK (lifecycle_state IN ('raw','triaged','curated','verified')),
            review_after TIMESTAMPTZ,
            last_confirmed_at TIMESTAMPTZ,
            review_reason TEXT CHECK (review_reason IS NULL OR review_reason IN ('conflict','manual')),
            created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent', 'system')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          ALTER TABLE project_memory_entries
            ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'triaged'
              CHECK (lifecycle_state IN ('raw','triaged','curated','verified')),
            ADD COLUMN IF NOT EXISTS review_after TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS review_reason TEXT
              CHECK (review_reason IS NULL OR review_reason IN ('conflict','manual'));
        `);

        await runProjectMemoryLifecycleBackfill();

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_memory_project_status_updated
          ON project_memory_entries(project_id, status, updated_at DESC, id DESC);
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_memory_project_kind_authority
          ON project_memory_entries(project_id, kind, authority, updated_at DESC)
          WHERE status = 'active';
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_index_entries (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source_service TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            association_kind TEXT NOT NULL CHECK (association_kind IN ('primary', 'secondary')),
            association_id TEXT,
            path TEXT,
            title TEXT NOT NULL,
            summary_text TEXT NOT NULL,
            summary_source TEXT NOT NULL DEFAULT 'deterministic',
            source_version TEXT,
            content_hash TEXT,
            source_updated_at TIMESTAMPTZ NOT NULL,
            indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
            CHECK (
              (association_kind = 'primary' AND association_id IS NULL)
              OR (association_kind = 'secondary' AND association_id IS NOT NULL)
            )
          );
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_project_index_entries_active_resource
          ON project_index_entries(project_id, source_service, resource_type, resource_id)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_index_project_indexed
          ON project_index_entries(project_id, indexed_at DESC, id DESC)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_index_association
          ON project_index_entries(association_id)
          WHERE is_deleted = FALSE AND association_id IS NOT NULL;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_relations (
            id TEXT PRIMARY KEY,
            source_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            target_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            relation_type TEXT NOT NULL CHECK (relation_type IN ('related', 'depends_on', 'supports', 'informs', 'overlaps')),
            directionality TEXT NOT NULL DEFAULT 'directed' CHECK (directionality IN ('directed', 'bidirectional')),
            note TEXT NOT NULL DEFAULT '',
            origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'inferred')),
            strength DOUBLE PRECISION CHECK (strength IS NULL OR (strength >= 0 AND strength <= 1)),
            created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent', 'system')),
            version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
            CHECK (source_project_id <> target_project_id)
          );
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_project_relations_active_directed
          ON project_relations(source_project_id, target_project_id, relation_type)
          WHERE is_deleted = FALSE AND directionality = 'directed';
        `);

        await pool.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS ux_project_relations_active_bidirectional
          ON project_relations(
            LEAST(source_project_id, target_project_id),
            GREATEST(source_project_id, target_project_id),
            relation_type
          )
          WHERE is_deleted = FALSE AND directionality = 'bidirectional';
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_relations_source_updated
          ON project_relations(source_project_id, updated_at DESC, id DESC)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_project_relations_target_updated
          ON project_relations(target_project_id, updated_at DESC, id DESC)
          WHERE is_deleted = FALSE;
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_context_summaries (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
            summary_text TEXT NOT NULL,
            source TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        await pool.query(`
          CREATE TABLE IF NOT EXISTS project_user_preferences (
            owner_account_id TEXT PRIMARY KEY,
            default_project_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

async function runProjectMemoryLifecycleBackfill(): Promise<void> {
  await pool.query(`
    UPDATE project_memory_entries
    SET lifecycle_state = 'verified',
        last_confirmed_at = updated_at
    WHERE authority = 'user_confirmed'
      AND last_confirmed_at IS NULL
      AND lifecycle_state = 'triaged';
  `);
}

export async function backfillProjectMemoryLifecycle(): Promise<void> {
  await ensureProjectsSchema();
  await runProjectMemoryLifecycleBackfill();
}

function accountIdFromCoreUserId(coreUserId: string): string {
  return createHash("sha256").update(coreUserId).digest("hex").slice(0, 32);
}

export async function upsertServiceAccount(coreUserId: string, usernameSnapshot: string): Promise<void> {
  await ensureProjectsSchema();
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
  await ensureProjectsSchema();
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

export function getProjectsPool(): Pool {
  return pool;
}
