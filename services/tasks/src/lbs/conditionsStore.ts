import type { DailyCondition } from "./types.js";
import { getLbsStoreDatabase, isoTimestamp, requireOwner, type LbsStoreDatabase } from "./storeUtils.js";

type ConditionRow = Omit<DailyCondition, "user_id" | "updated_at"> & { owner_username: string; updated_at: string | Date };
const COLUMNS = `owner_username, target_date, cognitive_fatigue, physical_fatigue, note, updated_at`;

export function clampFatigue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(value)));
}

function toCondition(row: ConditionRow): DailyCondition {
  const { owner_username, updated_at, ...condition } = row;
  return { ...condition, user_id: owner_username, updated_at: isoTimestamp(updated_at) };
}

export async function upsertCondition(
  ownerCoreUserId: string,
  targetDate: string,
  input: { cognitiveFatigue: number; physicalFatigue?: number; note?: string | null },
  database?: LbsStoreDatabase
): Promise<DailyCondition> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ConditionRow>(
    `INSERT INTO daily_conditions (owner_username, target_date, cognitive_fatigue, physical_fatigue, note)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (owner_username, target_date) DO UPDATE SET
       cognitive_fatigue = EXCLUDED.cognitive_fatigue,
       physical_fatigue = EXCLUDED.physical_fatigue,
       note = EXCLUDED.note, updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [requireOwner(ownerCoreUserId), targetDate, clampFatigue(input.cognitiveFatigue),
      clampFatigue(input.physicalFatigue ?? 0), input.note ?? null]
  );
  return toCondition(result.rows[0]);
}

export async function getCondition(ownerCoreUserId: string, targetDate: string, database?: LbsStoreDatabase): Promise<DailyCondition | undefined> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query<ConditionRow>(
    `SELECT ${COLUMNS} FROM daily_conditions WHERE owner_username = $1 AND target_date = $2`,
    [requireOwner(ownerCoreUserId), targetDate]
  );
  return result.rows[0] ? toCondition(result.rows[0]) : undefined;
}

export async function deleteCondition(ownerCoreUserId: string, targetDate: string, database?: LbsStoreDatabase): Promise<boolean> {
  const db = await getLbsStoreDatabase(database);
  const result = await db.query(`DELETE FROM daily_conditions WHERE owner_username = $1 AND target_date = $2`, [requireOwner(ownerCoreUserId), targetDate]);
  return (result.rowCount ?? 0) > 0;
}
