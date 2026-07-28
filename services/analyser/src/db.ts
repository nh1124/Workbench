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
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const pool = new Pool({
  host: requireEnv("ANALYSER_DB_HOST"),
  port: Number(requireEnv("ANALYSER_DB_PORT")),
  database: requireEnv("ANALYSER_DB_NAME"),
  user: requireEnv("ANALYSER_DB_USER"),
  password: requireEnv("ANALYSER_DB_PASSWORD")
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
  const rawCode = (error as { code?: unknown }).code;
  if (typeof rawCode === "string" && ["57P03", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(rawCode)) return true;
  const message = error.message.toLowerCase();
  return message.includes("connection terminated unexpectedly") || message.includes("the database system is starting up");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithDbStartupRetry(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= DB_STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isTransientStartupError(error) || attempt === DB_STARTUP_RETRY_ATTEMPTS) throw error;
      await sleep(DB_STARTUP_RETRY_DELAY_MS);
    }
  }
}

export async function ensureAnalyserSchema(): Promise<void> {
  if (!schemaReady) schemaReady = runWithDbStartupRetry(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS service_accounts (
      id TEXT PRIMARY KEY,
      core_user_id TEXT UNIQUE,
      username_snapshot TEXT,
      username TEXT,
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_analyser_service_accounts_core_user_id
      ON service_accounts(core_user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_machines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_key TEXT NOT NULL,
      display_name TEXT,
      platform TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, machine_key),
      UNIQUE(service_account_id, id)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_collection_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_id UUID NULL REFERENCES analyser_machines(id) ON DELETE CASCADE,
      settings_json JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, machine_id)
    )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_analyser_collection_policy_owner_default
      ON analyser_collection_policies(service_account_id) WHERE machine_id IS NULL`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_automation_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL UNIQUE REFERENCES service_accounts(id) ON DELETE CASCADE,
      policy_json JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_observations (
      seq BIGSERIAL UNIQUE,
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('workbench_change','mcp_access','ui_access','agent_session','pc_activity','local_file')),
      action TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
      machine_id UUID NULL,
      project_id TEXT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resource_refs JSONB NOT NULL DEFAULT '[]',
      metadata JSONB NOT NULL DEFAULT '{}',
      source_event_id TEXT NULL,
      dedupe_key TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE(service_account_id, dedupe_key)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_observations_owner_seq
      ON analyser_observations(service_account_id, seq)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_observations_owner_source_occurred
      ON analyser_observations(service_account_id, source, occurred_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_observations_expires_at
      ON analyser_observations(expires_at)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_derived_captures (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_id UUID NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary_markdown TEXT NOT NULL,
      evidence_refs JSONB NOT NULL DEFAULT '[]',
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dedupe_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, dedupe_key)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_derived_captures_owner_occurred
      ON analyser_derived_captures(service_account_id, occurred_at DESC, id DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_derived_captures_owner_machine
      ON analyser_derived_captures(service_account_id, machine_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_skill_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      skill_key TEXT NOT NULL,
      skill_version TEXT NULL,
      content_hash TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      source_ref TEXT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, skill_key)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_routines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      skill_key TEXT NOT NULL,
      skill_version TEXT NULL,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('interval','cron')),
      schedule_expr TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      next_run_at TIMESTAMPTZ NULL,
      committed_cursor BIGINT NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      backoff_minutes INTEGER NOT NULL DEFAULT 15,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, key)
    )`);
    await pool.query(`ALTER TABLE analyser_routines
      ADD COLUMN IF NOT EXISTS skill_missing BOOLEAN NOT NULL DEFAULT FALSE`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      routine_id UUID NOT NULL REFERENCES analyser_routines(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('claimed','processing','completed','failed')),
      holder TEXT NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      policy_snapshot JSONB NOT NULL DEFAULT '{}',
      pending_read_cursor BIGINT NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 1,
      error_summary TEXT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_runs_owner_routine_status
      ON analyser_runs(service_account_id, routine_id, status)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_analyser_runs_active
      ON analyser_runs(routine_id) WHERE status IN ('claimed','processing')`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_summaries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      metrics JSONB NULL,
      evidence_refs JSONB NOT NULL DEFAULT '[]',
      routine_key TEXT NULL,
      run_id UUID NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, kind, period_start, period_end)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_proposals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      evidence_refs JSONB NOT NULL DEFAULT '[]',
      proposed_action JSONB NULL,
      confidence_evidence JSONB NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','executed','superseded')),
      approved_by TEXT NULL,
      approved_at TIMESTAMPTZ NULL,
      approval_provenance TEXT NULL,
      routine_key TEXT NULL,
      run_id UUID NULL,
      dedupe_key TEXT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_analyser_proposals_owner_dedupe
      ON analyser_proposals(service_account_id, dedupe_key) WHERE dedupe_key IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_analyser_proposals_owner_status_updated
      ON analyser_proposals(service_account_id, status, updated_at DESC)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      operation_kind TEXT NOT NULL,
      approval_basis TEXT NOT NULL,
      proposal_id UUID NULL,
      before_refs JSONB NOT NULL DEFAULT '[]',
      after_refs JSONB NOT NULL DEFAULT '[]',
      result TEXT NOT NULL,
      detail JSONB NULL,
      run_id UUID NULL,
      agent_label TEXT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, idempotency_key)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS analyser_publications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('summary','proposal')),
      source_id UUID NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('note','artifact')),
      target_id TEXT NOT NULL,
      target_ref JSONB NULL,
      content_hash TEXT NOT NULL,
      provenance TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, source_kind, source_id, target_kind, content_hash)
    )`);
  });
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

export async function provisionServiceAccount(coreUserId: string, usernameSnapshot: string): Promise<void> {
  await ensureAnalyserSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const normalizedUsername = usernameSnapshot.trim().toLowerCase();
  if (!normalizedCoreUserId || !normalizedUsername) throw new Error("coreUserId and username are required");
  await pool.query(`INSERT INTO service_accounts (id, core_user_id, username_snapshot, username, password_hash)
    VALUES ($1, $2, $3, $3, $2) ON CONFLICT (core_user_id) DO UPDATE SET
    username_snapshot = EXCLUDED.username_snapshot, username = EXCLUDED.username, updated_at = NOW()`,
  [accountIdFromCoreUserId(normalizedCoreUserId), normalizedCoreUserId, normalizedUsername]);
}

export async function findServiceAccountByCoreUserId(coreUserId: string): Promise<ServiceAccount | undefined> {
  await ensureAnalyserSchema();
  const result = await pool.query<{ id: string; core_user_id: string; username_snapshot: string | null; username: string | null }>(
    `SELECT id, core_user_id, username_snapshot, username FROM service_accounts WHERE core_user_id = $1`,
    [coreUserId.trim()]
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    coreUserId: row.core_user_id,
    usernameSnapshot: (row.username_snapshot ?? row.username ?? "unknown").trim().toLowerCase()
  } : undefined;
}

export function getAnalyserPool(): Pool {
  return pool;
}
