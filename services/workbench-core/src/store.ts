import { createHash } from "node:crypto";
import { ensureCoreSchema, getCorePool, hashPassword, verifyPassword } from "./db.js";

export interface WorkbenchUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface ServiceProvisioning {
  serviceId: string;
  status: "ok" | "error";
  message?: string;
  updatedAt: string;
}

export interface IntegrationConfig {
  integrationId: string;
  enabled: boolean;
  values: Record<string, string | number | boolean>;
  updatedAt: string;
}

function userIdFromUsername(username: string): string {
  return createHash("sha256").update(username).digest("hex").slice(0, 32);
}

export async function registerUser(username: string, password: string): Promise<WorkbenchUser> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const normalized = username.trim().toLowerCase();
  const id = userIdFromUsername(normalized);
  const passwordHash = hashPassword(password);

  const result = await pool.query<{ id: string; username: string; created_at: string }>(
    `
      INSERT INTO workbench_users (id, username, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, created_at
    `,
    [id, normalized, passwordHash]
  );

  return {
    id: result.rows[0].id,
    username: result.rows[0].username,
    createdAt: new Date(result.rows[0].created_at).toISOString()
  };
}

export async function loginUser(username: string, password: string): Promise<WorkbenchUser | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const normalized = username.trim().toLowerCase();
  const result = await pool.query<{ id: string; username: string; password_hash: string; created_at: string }>(
    `
      SELECT id, username, password_hash, created_at
      FROM workbench_users
      WHERE username = $1
      LIMIT 1
    `,
    [normalized]
  );

  const user = result.rows[0];
  if (!user) return undefined;
  if (!verifyPassword(password, user.password_hash)) return undefined;

  return {
    id: user.id,
    username: user.username,
    createdAt: new Date(user.created_at).toISOString()
  };
}

export async function findUserByUsername(username: string): Promise<WorkbenchUser | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const normalized = username.trim().toLowerCase();
  const result = await pool.query<{ id: string; username: string; created_at: string }>(
    `
      SELECT id, username, created_at
      FROM workbench_users
      WHERE username = $1
      LIMIT 1
    `,
    [normalized]
  );

  const user = result.rows[0];
  if (!user) return undefined;
  return {
    id: user.id,
    username: user.username,
    createdAt: new Date(user.created_at).toISOString()
  };
}

export async function findUserById(id: string): Promise<WorkbenchUser | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<{ id: string; username: string; created_at: string }>(
    `
      SELECT id, username, created_at
      FROM workbench_users
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  const user = result.rows[0];
  if (!user) return undefined;
  return {
    id: user.id,
    username: user.username,
    createdAt: new Date(user.created_at).toISOString()
  };
}

export async function upsertProvisioning(
  userId: string,
  serviceId: string,
  status: "ok" | "error",
  message?: string
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      INSERT INTO service_provisionings (user_id, service_id, status, message, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, service_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        message = EXCLUDED.message,
        updated_at = NOW()
    `,
    [userId, serviceId, status, message ?? null]
  );
}

export async function listProvisionings(userId: string): Promise<ServiceProvisioning[]> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<{ service_id: string; status: "ok" | "error"; message: string | null; updated_at: string }>(
    `
      SELECT service_id, status, message, updated_at
      FROM service_provisionings
      WHERE user_id = $1
      ORDER BY service_id ASC
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    serviceId: row.service_id,
    status: row.status,
    message: row.message ?? undefined,
    updatedAt: new Date(row.updated_at).toISOString()
  }));
}

export async function saveIntegrationConfig(
  userId: string,
  integrationId: string,
  enabled: boolean,
  values: Record<string, string | number | boolean>
): Promise<void> {
  await ensureCoreSchema();
  const pool = getCorePool();
  await pool.query(
    `
      INSERT INTO integration_configs (user_id, integration_id, enabled, values_json, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (user_id, integration_id)
      DO UPDATE SET
        enabled = EXCLUDED.enabled,
        values_json = EXCLUDED.values_json,
        updated_at = NOW()
    `,
    [userId, integrationId, enabled, JSON.stringify(values)]
  );
}

export async function listIntegrationConfigs(userId: string): Promise<IntegrationConfig[]> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<{
    integration_id: string;
    enabled: boolean;
    values_json: Record<string, string | number | boolean>;
    updated_at: string;
  }>(
    `
      SELECT integration_id, enabled, values_json, updated_at
      FROM integration_configs
      WHERE user_id = $1
      ORDER BY integration_id ASC
    `,
    [userId]
  );

  return result.rows.map((row) => ({
    integrationId: row.integration_id,
    enabled: row.enabled,
    values: row.values_json ?? {},
    updatedAt: new Date(row.updated_at).toISOString()
  }));
}

export async function getIntegrationConfig(userId: string, integrationId: string): Promise<IntegrationConfig | undefined> {
  await ensureCoreSchema();
  const pool = getCorePool();
  const result = await pool.query<{
    integration_id: string;
    enabled: boolean;
    values_json: Record<string, string | number | boolean>;
    updated_at: string;
  }>(
    `
      SELECT integration_id, enabled, values_json, updated_at
      FROM integration_configs
      WHERE user_id = $1 AND integration_id = $2
      LIMIT 1
    `,
    [userId, integrationId]
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    integrationId: row.integration_id,
    enabled: row.enabled,
    values: row.values_json ?? {},
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
