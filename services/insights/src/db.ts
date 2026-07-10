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
  host: requireEnv("INSIGHTS_DB_HOST"), port: Number(requireEnv("INSIGHTS_DB_PORT")),
  database: requireEnv("INSIGHTS_DB_NAME"), user: requireEnv("INSIGHTS_DB_USER"), password: requireEnv("INSIGHTS_DB_PASSWORD")
});
const DB_STARTUP_RETRY_ATTEMPTS = 20;
const DB_STARTUP_RETRY_DELAY_MS = 1000;
let schemaReady: Promise<void> | undefined;
export interface ServiceAccount { id: string; coreUserId: string; usernameSnapshot: string }

function isTransientStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const rawCode = (error as { code?: unknown }).code;
  if (typeof rawCode === "string" && ["57P03", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(rawCode)) return true;
  const message = error.message.toLowerCase();
  return message.includes("connection terminated unexpectedly") || message.includes("the database system is starting up");
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function runWithDbStartupRetry(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= DB_STARTUP_RETRY_ATTEMPTS; attempt += 1) {
    try { await operation(); return; } catch (error) {
      if (!isTransientStartupError(error) || attempt === DB_STARTUP_RETRY_ATTEMPTS) throw error;
      await sleep(DB_STARTUP_RETRY_DELAY_MS);
    }
  }
}

export async function ensureInsightsSchema(): Promise<void> {
  if (!schemaReady) schemaReady = runWithDbStartupRetry(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS service_accounts (
      id TEXT PRIMARY KEY, core_user_id TEXT UNIQUE, username_snapshot TEXT, username TEXT, password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_insights_service_accounts_core_user_id ON service_accounts(core_user_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS machines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_key TEXT NOT NULL, display_name TEXT, platform TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(service_account_id, machine_key), UNIQUE(service_account_id, id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_samples (
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_id UUID NOT NULL, sampled_at TIMESTAMPTZ NOT NULL, process_name TEXT NOT NULL,
      window_title TEXT NOT NULL, idle BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(machine_id, sampled_at),
      FOREIGN KEY(service_account_id, machine_id) REFERENCES machines(service_account_id, id) ON DELETE CASCADE)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_summaries (
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_id UUID NOT NULL, summary_date DATE NOT NULL, summary_markdown TEXT NOT NULL,
      metrics_json JSONB, sample_count INTEGER NOT NULL DEFAULT 0, generated_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(machine_id, summary_date),
      FOREIGN KEY(service_account_id, machine_id) REFERENCES machines(service_account_id, id) ON DELETE CASCADE)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_insights_summaries_owner_date ON activity_summaries(service_account_id, summary_date DESC, machine_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS derived_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      machine_id UUID REFERENCES machines(id) ON DELETE SET NULL, observed_date DATE NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, content_markdown TEXT NOT NULL, payload_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_insights_derived_owner_date ON derived_observations(service_account_id, observed_date DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_insights_derived_owner_created ON derived_observations(service_account_id, created_at DESC, id DESC)`);
  });
  try { await schemaReady; } catch (error) { schemaReady = undefined; throw error; }
}

function accountIdFromCoreUserId(coreUserId: string): string {
  return createHash("sha256").update(coreUserId).digest("hex").slice(0, 32);
}
export async function provisionServiceAccount(coreUserId: string, usernameSnapshot: string): Promise<void> {
  await ensureInsightsSchema();
  const normalizedCoreUserId = coreUserId.trim();
  const normalizedUsername = usernameSnapshot.trim().toLowerCase();
  if (!normalizedCoreUserId || !normalizedUsername) throw new Error("coreUserId and username are required");
  await pool.query(`INSERT INTO service_accounts (id, core_user_id, username_snapshot, username, password_hash)
    VALUES ($1, $2, $3, $3, $2) ON CONFLICT (core_user_id) DO UPDATE SET
    username_snapshot = EXCLUDED.username_snapshot, username = EXCLUDED.username, updated_at = NOW()`,
    [accountIdFromCoreUserId(normalizedCoreUserId), normalizedCoreUserId, normalizedUsername]);
}
export async function findServiceAccountByCoreUserId(coreUserId: string): Promise<ServiceAccount | undefined> {
  await ensureInsightsSchema();
  const result = await pool.query<{ id: string; core_user_id: string; username_snapshot: string | null; username: string | null }>(
    `SELECT id, core_user_id, username_snapshot, username FROM service_accounts WHERE core_user_id = $1`, [coreUserId.trim()]);
  const row = result.rows[0];
  return row ? { id: row.id, coreUserId: row.core_user_id,
    usernameSnapshot: (row.username_snapshot ?? row.username ?? "unknown").trim().toLowerCase() } : undefined;
}
export function getInsightsPool(): Pool { return pool; }
