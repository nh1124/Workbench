import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  automationPolicySchema,
  collectionSettingsSchema,
  DEFAULT_AUTOMATION_POLICY,
  DEFAULT_COLLECTION_SETTINGS,
  type AutomationPolicy,
  type CollectionSettings,
  type CollectionSettingsOverride
} from "../types.js";
import { requireMachineWithPool, type AnalyserQueryPool } from "./machines.js";

type TransactionClient = AnalyserQueryPool & { release(): void };
export type AnalyserTransactionPool = AnalyserQueryPool & { connect(): Promise<TransactionClient> };

type CollectionPolicyRow = {
  machine_id: string | null;
  settings_json: unknown;
  version: number;
  updated_by: string;
  updated_at: Date | string;
};

type AutomationPolicyRow = {
  policy_json: unknown;
  version: number;
  updated_by: string;
  updated_at: Date | string;
};

export interface CollectionPolicyRecord {
  machineId: string | null;
  settings: CollectionSettingsOverride;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AutomationPolicyRecord {
  policy: AutomationPolicy;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseCollectionSettings(value: unknown, code: "INVALID_SETTINGS" | "POLICY_CORRUPT"): CollectionSettingsOverride {
  const parsed = collectionSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AnalyserServiceError(
      code === "INVALID_SETTINGS" ? 400 : 500,
      code,
      code === "INVALID_SETTINGS" ? "Invalid collection settings" : "Stored collection policy is corrupt"
    );
  }
  return parsed.data;
}

function parseAutomationPolicy(value: unknown, corrupt: boolean): AutomationPolicy {
  const parsed = automationPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new AnalyserServiceError(
      corrupt ? 500 : 400,
      corrupt ? "POLICY_CORRUPT" : "INVALID_POLICY",
      corrupt ? "Stored automation policy is corrupt" : "Invalid automation policy"
    );
  }
  return parsed.data;
}

function mergeSettings(base: CollectionSettings, override: CollectionSettingsOverride): CollectionSettings {
  return {
    ...base,
    ...override,
    retentionDays: { ...base.retentionDays, ...(override.retentionDays ?? {}) },
    projectAllow: [...(override.projectAllow ?? base.projectAllow)],
    projectDeny: [...(override.projectDeny ?? base.projectDeny)],
    resourceTypeAllow: [...(override.resourceTypeAllow ?? base.resourceTypeAllow)],
    resourceTypeDeny: [...(override.resourceTypeDeny ?? base.resourceTypeDeny)],
    localRootAllow: [...(override.localRootAllow ?? base.localRootAllow)],
    localRootDeny: [...(override.localRootDeny ?? base.localRootDeny)],
    excludePatterns: [...(override.excludePatterns ?? base.excludePatterns)]
  };
}

function mapCollectionPolicy(row: CollectionPolicyRow): CollectionPolicyRecord {
  return {
    machineId: row.machine_id,
    settings: parseCollectionSettings(row.settings_json, "POLICY_CORRUPT"),
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at)
  };
}

function mapAutomationPolicy(row: AutomationPolicyRow): AutomationPolicyRecord {
  return {
    policy: parseAutomationPolicy(row.policy_json, true),
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at)
  };
}

export async function getEffectiveCollectionSettings(
  owner: string,
  machineId?: string
): Promise<{ settings: CollectionSettings; ownerVersion?: number; machineVersion?: number }> {
  return getEffectiveCollectionSettingsWithPool(getAnalyserPool(), owner, machineId);
}

export async function getEffectiveCollectionSettingsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  machineId?: string
): Promise<{ settings: CollectionSettings; ownerVersion?: number; machineVersion?: number }> {
  const result = await pool.query<Pick<CollectionPolicyRow, "machine_id" | "settings_json" | "version">>(
    machineId
      ? `SELECT machine_id, settings_json, version
          FROM analyser_collection_policies
          WHERE service_account_id = $1 AND (machine_id IS NULL OR machine_id = $2)
          ORDER BY machine_id NULLS FIRST`
      : `SELECT machine_id, settings_json, version
          FROM analyser_collection_policies
          WHERE service_account_id = $1 AND machine_id IS NULL`,
    machineId ? [owner, machineId] : [owner]
  );

  let settings = mergeSettings(DEFAULT_COLLECTION_SETTINGS, {});
  let ownerVersion: number | undefined;
  let machineVersion: number | undefined;
  for (const row of result.rows) {
    settings = mergeSettings(settings, parseCollectionSettings(row.settings_json, "POLICY_CORRUPT"));
    if (row.machine_id === null) ownerVersion = row.version;
    else machineVersion = row.version;
  }
  return {
    settings,
    ...(ownerVersion === undefined ? {} : { ownerVersion }),
    ...(machineVersion === undefined ? {} : { machineVersion })
  };
}

export async function getCollectionPolicyRows(owner: string): Promise<CollectionPolicyRecord[]> {
  return getCollectionPolicyRowsWithPool(getAnalyserPool(), owner);
}

export async function getCollectionPolicyRowsWithPool(
  pool: AnalyserQueryPool,
  owner: string
): Promise<CollectionPolicyRecord[]> {
  const result = await pool.query<CollectionPolicyRow>(`SELECT machine_id, settings_json, version, updated_by, updated_at
    FROM analyser_collection_policies
    WHERE service_account_id = $1
    ORDER BY machine_id NULLS FIRST`, [owner]);
  return result.rows.map(mapCollectionPolicy);
}

export async function upsertCollectionPolicy(
  owner: string,
  input: { machineId?: string | null; settings: unknown; expectedVersion?: number; updatedBy: string }
): Promise<CollectionPolicyRecord> {
  return upsertCollectionPolicyWithPool(getAnalyserPool(), owner, input);
}

export async function upsertCollectionPolicyWithPool(
  pool: AnalyserTransactionPool,
  owner: string,
  input: { machineId?: string | null; settings: unknown; expectedVersion?: number; updatedBy: string }
): Promise<CollectionPolicyRecord> {
  const settings = parseCollectionSettings(input.settings, "INVALID_SETTINGS");
  if (input.machineId) {
    await requireMachineWithPool(pool, owner, input.machineId);
    const result = await pool.query<CollectionPolicyRow>(`INSERT INTO analyser_collection_policies
      (service_account_id, machine_id, settings_json, updated_by)
      VALUES ($1, $2, $3::jsonb, $4)
      ON CONFLICT (service_account_id, machine_id) DO UPDATE SET
        settings_json = EXCLUDED.settings_json,
        updated_by = EXCLUDED.updated_by,
        version = analyser_collection_policies.version + 1,
        updated_at = NOW()
      WHERE ($5::integer IS NULL OR analyser_collection_policies.version = $5)
      RETURNING machine_id, settings_json, version, updated_by, updated_at`, [
      owner,
      input.machineId,
      JSON.stringify(settings),
      input.updatedBy,
      input.expectedVersion ?? null
    ]);
    if (!result.rows[0]) throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Collection policy version conflict");
    return mapCollectionPolicy(result.rows[0]);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM service_accounts WHERE id = $1 FOR UPDATE`, [owner]);
    const current = await client.query<CollectionPolicyRow>(`SELECT machine_id, settings_json, version, updated_by, updated_at
      FROM analyser_collection_policies
      WHERE service_account_id = $1 AND machine_id IS NULL
      FOR UPDATE`, [owner]);
    const existing = current.rows[0];
    if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Collection policy version conflict");
    }
    const result = existing
      ? await client.query<CollectionPolicyRow>(`UPDATE analyser_collection_policies SET
          settings_json = $2::jsonb, updated_by = $3, version = version + 1, updated_at = NOW()
          WHERE service_account_id = $1 AND machine_id IS NULL
          RETURNING machine_id, settings_json, version, updated_by, updated_at`, [owner, JSON.stringify(settings), input.updatedBy])
      : await client.query<CollectionPolicyRow>(`INSERT INTO analyser_collection_policies
          (service_account_id, machine_id, settings_json, updated_by)
          VALUES ($1, NULL, $2::jsonb, $3)
          RETURNING machine_id, settings_json, version, updated_by, updated_at`, [owner, JSON.stringify(settings), input.updatedBy]);
    await client.query("COMMIT");
    return mapCollectionPolicy(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getEffectiveAutomationPolicy(owner: string): Promise<AutomationPolicy> {
  return getEffectiveAutomationPolicyWithPool(getAnalyserPool(), owner);
}

export async function getEffectiveAutomationPolicyWithPool(pool: AnalyserQueryPool, owner: string): Promise<AutomationPolicy> {
  const result = await pool.query<Pick<AutomationPolicyRow, "policy_json">>(`SELECT policy_json
    FROM analyser_automation_policies
    WHERE service_account_id = $1`, [owner]);
  return result.rows[0] ? parseAutomationPolicy(result.rows[0].policy_json, true) : { ...DEFAULT_AUTOMATION_POLICY, allowedOperationKinds: [...DEFAULT_AUTOMATION_POLICY.allowedOperationKinds] };
}

export async function getAutomationPolicyRecord(owner: string): Promise<AutomationPolicyRecord | undefined> {
  return getAutomationPolicyRecordWithPool(getAnalyserPool(), owner);
}

export async function getAutomationPolicyRecordWithPool(
  pool: AnalyserQueryPool,
  owner: string
): Promise<AutomationPolicyRecord | undefined> {
  const result = await pool.query<AutomationPolicyRow>(`SELECT policy_json, version, updated_by, updated_at
    FROM analyser_automation_policies
    WHERE service_account_id = $1`, [owner]);
  return result.rows[0] ? mapAutomationPolicy(result.rows[0]) : undefined;
}

export async function upsertAutomationPolicy(
  owner: string,
  input: { policy: unknown; expectedVersion?: number; updatedBy: string }
): Promise<AutomationPolicyRecord> {
  return upsertAutomationPolicyWithPool(getAnalyserPool(), owner, input);
}

export async function upsertAutomationPolicyWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  input: { policy: unknown; expectedVersion?: number; updatedBy: string }
): Promise<AutomationPolicyRecord> {
  const policy = parseAutomationPolicy(input.policy, false);
  const result = await pool.query<AutomationPolicyRow>(`INSERT INTO analyser_automation_policies
    (service_account_id, policy_json, updated_by)
    VALUES ($1, $2::jsonb, $3)
    ON CONFLICT (service_account_id) DO UPDATE SET
      policy_json = EXCLUDED.policy_json,
      updated_by = EXCLUDED.updated_by,
      version = analyser_automation_policies.version + 1,
      updated_at = NOW()
    WHERE ($4::integer IS NULL OR analyser_automation_policies.version = $4)
    RETURNING policy_json, version, updated_by, updated_at`, [
    owner,
    JSON.stringify(policy),
    input.updatedBy,
    input.expectedVersion ?? null
  ]);
  if (!result.rows[0]) throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Automation policy version conflict");
  return mapAutomationPolicy(result.rows[0]);
}
