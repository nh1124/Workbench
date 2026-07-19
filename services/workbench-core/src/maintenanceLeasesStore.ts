import { ensureCoreSchema, getCorePool } from "./db.js";

export const DEFAULT_MAINTENANCE_LEASE_TTL_SECONDS = 1800;

export class MaintenanceLeaseInputError extends Error {
  status = 400;
  code = "MAINTENANCE_LEASE_INPUT_INVALID";
}

export class MaintenanceLeaseHeldError extends Error {
  status = 409;
  code = "MAINTENANCE_LEASE_HELD";
}

export class MaintenanceLeaseNotHeldError extends Error {
  status = 409;
  code = "MAINTENANCE_LEASE_NOT_HELD";
}

export type MaintenanceLease = {
  key: string;
  holder: string;
  expiresAt: string;
  acquiredAt: string;
  renewedAt?: string;
};

type MaintenanceLeaseInput = {
  key: unknown;
  holder: unknown;
  ttlSeconds?: unknown;
};

type MaintenanceLeaseReleaseInput = Pick<MaintenanceLeaseInput, "key" | "holder">;

type MaintenanceLeaseRow = {
  key: string;
  holder: string;
  expires_at: string | Date;
  acquired_at: string | Date;
  renewed_at: string | Date | null;
};

type MaintenanceLeaseQueryResult<Row> = {
  rows: Row[];
  rowCount?: number | null;
};

type MaintenanceLeaseQueryPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<MaintenanceLeaseQueryResult<Row>>;
};

function normalizeLeaseString(value: unknown, field: "key" | "holder"): string {
  if (typeof value !== "string") {
    throw new MaintenanceLeaseInputError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new MaintenanceLeaseInputError(`${field} must be a trimmed non-empty string of 1 to 100 characters`);
  }
  return normalized;
}

function normalizeTtlSeconds(value: unknown = DEFAULT_MAINTENANCE_LEASE_TTL_SECONDS): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 86400) {
    throw new MaintenanceLeaseInputError("ttlSeconds must be an integer from 1 to 86400");
  }
  return value as number;
}

function normalizeLeaseInput(input: MaintenanceLeaseInput): { key: string; holder: string; ttlSeconds: number } {
  return {
    key: normalizeLeaseString(input.key, "key"),
    holder: normalizeLeaseString(input.holder, "holder"),
    ttlSeconds: normalizeTtlSeconds(input.ttlSeconds)
  };
}

function normalizeReleaseInput(input: MaintenanceLeaseReleaseInput): { key: string; holder: string } {
  return {
    key: normalizeLeaseString(input.key, "key"),
    holder: normalizeLeaseString(input.holder, "holder")
  };
}

function toMaintenanceLease(row: MaintenanceLeaseRow): MaintenanceLease {
  return {
    key: row.key,
    holder: row.holder,
    expiresAt: new Date(row.expires_at).toISOString(),
    acquiredAt: new Date(row.acquired_at).toISOString(),
    ...(row.renewed_at ? { renewedAt: new Date(row.renewed_at).toISOString() } : {})
  };
}

export async function acquireMaintenanceLease(
  userId: string,
  input: MaintenanceLeaseInput
): Promise<MaintenanceLease> {
  await ensureCoreSchema();
  return acquireMaintenanceLeaseWithPool(getCorePool(), userId, input);
}

/** @internal Exported so atomic acquisition can be tested without a live database. */
export async function acquireMaintenanceLeaseWithPool(
  pool: MaintenanceLeaseQueryPool,
  userId: string,
  input: MaintenanceLeaseInput
): Promise<MaintenanceLease> {
  const { key, holder, ttlSeconds } = normalizeLeaseInput(input);
  const result = await pool.query<MaintenanceLeaseRow>(
    `
      INSERT INTO maintenance_leases (user_id, key, holder, expires_at, acquired_at, renewed_at)
      VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), NOW(), NULL)
      ON CONFLICT (user_id, key) DO UPDATE SET
        holder = EXCLUDED.holder,
        expires_at = EXCLUDED.expires_at,
        acquired_at = CASE WHEN maintenance_leases.holder = EXCLUDED.holder AND maintenance_leases.expires_at > NOW()
                           THEN maintenance_leases.acquired_at ELSE NOW() END,
        renewed_at = CASE WHEN maintenance_leases.holder = EXCLUDED.holder AND maintenance_leases.expires_at > NOW()
                          THEN NOW() ELSE NULL END
      WHERE maintenance_leases.holder = EXCLUDED.holder OR maintenance_leases.expires_at <= NOW()
      RETURNING key, holder, expires_at, acquired_at, renewed_at
    `,
    [userId, key, holder, ttlSeconds]
  );
  const row = result.rows[0];
  if (!row) {
    throw new MaintenanceLeaseHeldError("Maintenance lease is held by another holder");
  }
  return toMaintenanceLease(row);
}

export async function renewMaintenanceLease(
  userId: string,
  input: MaintenanceLeaseInput
): Promise<MaintenanceLease> {
  await ensureCoreSchema();
  return renewMaintenanceLeaseWithPool(getCorePool(), userId, input);
}

/** @internal Exported so holder and expiry guards can be tested without a live database. */
export async function renewMaintenanceLeaseWithPool(
  pool: MaintenanceLeaseQueryPool,
  userId: string,
  input: MaintenanceLeaseInput
): Promise<MaintenanceLease> {
  const { key, holder, ttlSeconds } = normalizeLeaseInput(input);
  const result = await pool.query<MaintenanceLeaseRow>(
    `
      UPDATE maintenance_leases
      SET expires_at = NOW() + make_interval(secs => $4), renewed_at = NOW()
      WHERE user_id = $1 AND key = $2 AND holder = $3 AND expires_at > NOW()
      RETURNING key, holder, expires_at, acquired_at, renewed_at
    `,
    [userId, key, holder, ttlSeconds]
  );
  const row = result.rows[0];
  if (!row) {
    throw new MaintenanceLeaseNotHeldError("Maintenance lease is not held by this holder or expired");
  }
  return toMaintenanceLease(row);
}

export async function releaseMaintenanceLease(
  userId: string,
  input: MaintenanceLeaseReleaseInput
): Promise<{ released: boolean }> {
  await ensureCoreSchema();
  return releaseMaintenanceLeaseWithPool(getCorePool(), userId, input);
}

/** @internal Exported so idempotent release can be tested without a live database. */
export async function releaseMaintenanceLeaseWithPool(
  pool: MaintenanceLeaseQueryPool,
  userId: string,
  input: MaintenanceLeaseReleaseInput
): Promise<{ released: boolean }> {
  const { key, holder } = normalizeReleaseInput(input);
  const result = await pool.query(
    `
      DELETE FROM maintenance_leases
      WHERE user_id = $1 AND key = $2 AND holder = $3
    `,
    [userId, key, holder]
  );
  return { released: (result.rowCount ?? 0) > 0 };
}
