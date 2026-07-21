import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import type { MachineRecord } from "../types.js";

type QueryResult<Row> = { rows: Row[]; rowCount?: number | null };
export type AnalyserQueryPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

type MachineRow = {
  id: string;
  machine_key: string;
  display_name: string | null;
  platform: string | null;
  registered_at: Date | string;
  last_seen_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapMachine(row: MachineRow): MachineRecord {
  return {
    id: row.id,
    machineKey: row.machine_key,
    displayName: row.display_name ?? undefined,
    platform: row.platform ?? undefined,
    registeredAt: iso(row.registered_at),
    lastSeenAt: iso(row.last_seen_at)
  };
}

export async function registerMachine(
  owner: string,
  input: { machineKey: string; displayName?: string; platform?: string }
): Promise<MachineRecord> {
  return registerMachineWithPool(getAnalyserPool(), owner, input);
}

export async function registerMachineWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  input: { machineKey: string; displayName?: string; platform?: string }
): Promise<MachineRecord> {
  const result = await pool.query<MachineRow>(`INSERT INTO analyser_machines
    (service_account_id, machine_key, display_name, platform)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (service_account_id, machine_key) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, analyser_machines.display_name),
      platform = COALESCE(EXCLUDED.platform, analyser_machines.platform),
      last_seen_at = NOW()
    RETURNING id, machine_key, display_name, platform, registered_at, last_seen_at`, [
    owner,
    input.machineKey,
    input.displayName ?? null,
    input.platform ?? null
  ]);
  return mapMachine(result.rows[0]);
}

export async function listMachines(owner: string): Promise<MachineRecord[]> {
  return listMachinesWithPool(getAnalyserPool(), owner);
}

export async function listMachinesWithPool(pool: AnalyserQueryPool, owner: string): Promise<MachineRecord[]> {
  const result = await pool.query<MachineRow>(`SELECT id, machine_key, display_name, platform, registered_at, last_seen_at
    FROM analyser_machines
    WHERE service_account_id = $1
    ORDER BY last_seen_at DESC, id`, [owner]);
  return result.rows.map(mapMachine);
}

export async function listKnownMachineIdsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await pool.query<{ id: string }>(`SELECT id
    FROM analyser_machines
    WHERE service_account_id = $1 AND id = ANY($2::uuid[])`, [owner, ids]);
  return new Set(result.rows.map((row) => row.id));
}

export async function touchMachine(owner: string, machineId: string): Promise<void> {
  return touchMachineWithPool(getAnalyserPool(), owner, machineId);
}

export async function touchMachineWithPool(pool: AnalyserQueryPool, owner: string, machineId: string): Promise<void> {
  const result = await pool.query<{ id: string }>(`UPDATE analyser_machines
    SET last_seen_at = NOW()
    WHERE service_account_id = $1 AND id = $2
    RETURNING id`, [owner, machineId]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "MACHINE_NOT_FOUND", "Machine not found");
}

export async function requireMachine(
  owner: string,
  machineId: string,
  client: AnalyserQueryPool = getAnalyserPool()
): Promise<void> {
  return requireMachineWithPool(client, owner, machineId);
}

export async function requireMachineWithPool(pool: AnalyserQueryPool, owner: string, machineId: string): Promise<void> {
  const result = await pool.query<{ exists: number }>(`SELECT 1 AS exists
    FROM analyser_machines
    WHERE service_account_id = $1 AND id = $2`, [owner, machineId]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "MACHINE_NOT_FOUND", "Machine not found");
}
