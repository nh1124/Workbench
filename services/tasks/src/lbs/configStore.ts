import type { LBSConfig } from "./types.js";
import { getLbsStoreDatabase, requireOwner, type LbsStoreDatabase } from "./storeUtils.js";

export const DEFAULT_LBS_CONFIG: Readonly<LBSConfig> = { ALPHA: 0.1, BETA: 1.2, SWITCH_COST: 0.5, CAP: 8.0 };
const CONFIG_KEYS = new Set<keyof LBSConfig>(["ALPHA", "BETA", "SWITCH_COST", "CAP"]);

function requireConfigKey(key: string): asserts key is keyof LBSConfig {
  if (!CONFIG_KEYS.has(key as keyof LBSConfig)) throw new Error(`Invalid LBS config key: ${key}`);
}

export async function getConfig(ownerCoreUserId: string, database?: LbsStoreDatabase): Promise<LBSConfig> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM lbs_user_config WHERE owner_username = $1`, [requireOwner(ownerCoreUserId)]
  );
  const config: LBSConfig = { ...DEFAULT_LBS_CONFIG };
  for (const row of result.rows) {
    if (!CONFIG_KEYS.has(row.key as keyof LBSConfig)) continue;
    const value = Number(row.value);
    if (Number.isFinite(value)) config[row.key as keyof LBSConfig] = value;
  }
  return config;
}

export async function setConfigKey(
  ownerCoreUserId: string,
  key: keyof LBSConfig,
  value: number,
  description?: string | null,
  database?: LbsStoreDatabase
): Promise<void> {
  requireConfigKey(key);
  if (!Number.isFinite(value)) throw new Error(`Invalid LBS config value for ${key}`);
  const db = await getLbsStoreDatabase(database);
  await db.query(
    `INSERT INTO lbs_user_config (owner_username, key, value, description)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_username, key) DO UPDATE SET
       value = EXCLUDED.value, description = EXCLUDED.description, updated_at = NOW()`,
    [requireOwner(ownerCoreUserId), key, String(value), description ?? null]
  );
}
