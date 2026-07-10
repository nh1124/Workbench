import type { PoolClient } from "pg";
import { getInsightsPool } from "./db.js";
import { activityAggregateSql, decodeDerivedCursor, decodeSummaryCursor, encodeCursor } from "./queries.js";
import type { ActivityAggregate, ActivitySampleInput, ActivitySummaryInput, DerivedObservationRecord, MachineRecord, SummaryMetadataRecord, SummaryRecord } from "./types.js";

const pool = getInsightsPool();
export class InsightsServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function dateOnly(value: Date | string): string { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
function limitValue(value: number | undefined): number { return value === undefined ? 50 : Math.min(200, Math.max(1, Math.trunc(value))); }
async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await operation(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function requireMachine(owner: string, machineId: string, client: Pick<PoolClient, "query"> = pool): Promise<void> {
  const result = await client.query(`SELECT 1 FROM machines WHERE service_account_id = $1 AND id = $2`, [owner, machineId]);
  if (!result.rows[0]) throw new InsightsServiceError(404, "MACHINE_NOT_FOUND", "Machine not found");
}

type MachineRow = { id: string; machine_key: string; display_name: string | null; platform: string | null; registered_at: Date | string; last_seen_at: Date | string };
function mapMachine(row: MachineRow): MachineRecord {
  return { id: row.id, machineKey: row.machine_key, displayName: row.display_name ?? undefined,
    platform: row.platform ?? undefined, registeredAt: iso(row.registered_at), lastSeenAt: iso(row.last_seen_at) };
}
export async function registerMachine(owner: string, input: { machineKey: string; displayName?: string; platform?: string }): Promise<MachineRecord> {
  const result = await pool.query<MachineRow>(`INSERT INTO machines (service_account_id, machine_key, display_name, platform)
    VALUES ($1, $2, $3, $4) ON CONFLICT (service_account_id, machine_key) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, machines.display_name), platform = COALESCE(EXCLUDED.platform, machines.platform),
    last_seen_at = NOW() RETURNING id, machine_key, display_name, platform, registered_at, last_seen_at`,
    [owner, input.machineKey, input.displayName ?? null, input.platform ?? null]);
  return mapMachine(result.rows[0]);
}
export async function listMachines(owner: string): Promise<MachineRecord[]> {
  const result = await pool.query<MachineRow>(`SELECT id, machine_key, display_name, platform, registered_at, last_seen_at
    FROM machines WHERE service_account_id = $1 ORDER BY last_seen_at DESC, id`, [owner]);
  return result.rows.map(mapMachine);
}

export async function ingestSamples(owner: string, machineId: string, samples: ActivitySampleInput[]): Promise<number> {
  const deduped = [...new Map(samples.map((item) => [item.sampledAt, item])).values()];
  return transaction(async (client) => {
    await requireMachine(owner, machineId, client);
    if (deduped.length) await client.query(`INSERT INTO activity_samples
      (service_account_id, machine_id, sampled_at, process_name, window_title, idle)
      SELECT $1, $2, x."sampledAt", x."processName", x."windowTitle", COALESCE(x.idle, FALSE)
      FROM jsonb_to_recordset($3::jsonb) AS x("sampledAt" timestamptz, "processName" text, "windowTitle" text, idle boolean)
      ON CONFLICT (machine_id, sampled_at) DO UPDATE SET process_name = EXCLUDED.process_name,
      window_title = EXCLUDED.window_title, idle = EXCLUDED.idle`, [owner, machineId, JSON.stringify(deduped)]);
    await client.query(`UPDATE machines SET last_seen_at = NOW() WHERE service_account_id = $1 AND id = $2`, [owner, machineId]);
    return deduped.length;
  });
}
export async function ingestSummaries(owner: string, machineId: string, summaries: ActivitySummaryInput[]): Promise<number> {
  const deduped = [...new Map(summaries.map((item) => [item.summaryDate, item])).values()];
  return transaction(async (client) => {
    await requireMachine(owner, machineId, client);
    if (deduped.length) await client.query(`INSERT INTO activity_summaries
      (service_account_id, machine_id, summary_date, summary_markdown, metrics_json, sample_count, generated_at)
      SELECT $1, $2, x."summaryDate", x."summaryMarkdown", x."metricsJson", COALESCE(x."sampleCount", 0), x."generatedAt"
      FROM jsonb_to_recordset($3::jsonb) AS x("summaryDate" date, "summaryMarkdown" text,
      "metricsJson" jsonb, "sampleCount" integer, "generatedAt" timestamptz)
      ON CONFLICT (machine_id, summary_date) DO UPDATE SET summary_markdown = EXCLUDED.summary_markdown,
      metrics_json = EXCLUDED.metrics_json, sample_count = EXCLUDED.sample_count,
      generated_at = EXCLUDED.generated_at, updated_at = NOW()`, [owner, machineId, JSON.stringify(deduped)]);
    await client.query(`UPDATE machines SET last_seen_at = NOW() WHERE service_account_id = $1 AND id = $2`, [owner, machineId]);
    return deduped.length;
  });
}

type SummaryRow = { machine_id: string; summary_date: Date | string; summary_markdown?: string; metrics_json: Record<string, unknown> | null; sample_count: number; generated_at: Date | string; updated_at: Date | string };
function mapSummary(row: SummaryRow): SummaryRecord {
  return { machineId: row.machine_id, summaryDate: dateOnly(row.summary_date), summaryMarkdown: row.summary_markdown ?? "",
    metricsJson: row.metrics_json ?? undefined, sampleCount: row.sample_count, generatedAt: iso(row.generated_at), updatedAt: iso(row.updated_at) };
}
export async function listSummaries(owner: string, options: { machineId?: string; from?: string; to?: string; limit?: number; cursor?: string }): Promise<{ items: SummaryMetadataRecord[]; nextCursor?: string }> {
  if (options.machineId) await requireMachine(owner, options.machineId);
  const params: unknown[] = [owner]; const where = ["s.service_account_id = $1"];
  if (options.machineId) { params.push(options.machineId); where.push(`s.machine_id = $${params.length}`); }
  if (options.from) { params.push(options.from); where.push(`s.summary_date >= $${params.length}::date`); }
  if (options.to) { params.push(options.to); where.push(`s.summary_date <= $${params.length}::date`); }
  if (options.cursor) {
    let cursor; try { cursor = decodeSummaryCursor(options.cursor); } catch { throw new InsightsServiceError(400, "INVALID_CURSOR", "Invalid summary cursor"); }
    params.push(cursor.summaryDate, cursor.machineId);
    where.push(`(s.summary_date, s.machine_id) < ($${params.length - 1}::date, $${params.length}::uuid)`);
  }
  const limit = limitValue(options.limit); params.push(limit + 1);
  const result = await pool.query<SummaryRow>(`SELECT s.machine_id, s.summary_date, s.metrics_json, s.sample_count, s.generated_at, s.updated_at
    FROM activity_summaries s WHERE ${where.join(" AND ")} ORDER BY s.summary_date DESC, s.machine_id DESC LIMIT $${params.length}`, params);
  const hasMore = result.rows.length > limit; const rows = result.rows.slice(0, limit);
  const items = rows.map(mapSummary).map(({ summaryMarkdown: _body, ...item }) => item); const tail = rows.at(-1);
  return { items, ...(hasMore && tail ? { nextCursor: encodeCursor({ summaryDate: dateOnly(tail.summary_date), machineId: tail.machine_id }) } : {}) };
}
export async function getSummary(owner: string, machineId: string, date: string): Promise<SummaryRecord> {
  await requireMachine(owner, machineId);
  const result = await pool.query<SummaryRow>(`SELECT machine_id, summary_date, summary_markdown, metrics_json, sample_count, generated_at, updated_at
    FROM activity_summaries WHERE service_account_id = $1 AND machine_id = $2 AND summary_date = $3::date`, [owner, machineId, date]);
  if (!result.rows[0]) throw new InsightsServiceError(404, "SUMMARY_NOT_FOUND", "Activity summary not found");
  return mapSummary(result.rows[0]);
}
export async function queryActivity(owner: string, options: { from: string; to: string; machineId?: string }): Promise<ActivityAggregate> {
  if (options.machineId) await requireMachine(owner, options.machineId);
  const result = await pool.query<{ aggregate: ActivityAggregate }>(activityAggregateSql, [owner, options.from, options.to, options.machineId ?? null]);
  return result.rows[0].aggregate;
}

type DerivedRow = { id: string; machine_id: string | null; observed_date: Date | string; kind: string; title: string; content_markdown: string; payload_json: Record<string, unknown> | null; created_at: Date | string };
function mapDerived(row: DerivedRow): DerivedObservationRecord {
  return { id: row.id, machineId: row.machine_id ?? undefined, observedDate: dateOnly(row.observed_date), kind: row.kind,
    title: row.title, contentMarkdown: row.content_markdown, payloadJson: row.payload_json ?? undefined, createdAt: iso(row.created_at) };
}
export async function createDerived(owner: string, input: { machineId?: string; observedDate: string; kind: string; title: string; contentMarkdown: string; payloadJson?: Record<string, unknown> }): Promise<DerivedObservationRecord> {
  if (input.machineId) await requireMachine(owner, input.machineId);
  const result = await pool.query<DerivedRow>(`INSERT INTO derived_observations
    (service_account_id, machine_id, observed_date, kind, title, content_markdown, payload_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, machine_id, observed_date, kind, title, content_markdown, payload_json, created_at`,
    [owner, input.machineId ?? null, input.observedDate, input.kind, input.title, input.contentMarkdown, input.payloadJson ?? null]);
  return mapDerived(result.rows[0]);
}
export async function listDerived(owner: string, options: { from?: string; to?: string; kind?: string; limit?: number; cursor?: string }): Promise<{ items: DerivedObservationRecord[]; nextCursor?: string }> {
  const params: unknown[] = [owner]; const where = ["service_account_id = $1"];
  if (options.from) { params.push(options.from); where.push(`observed_date >= $${params.length}::date`); }
  if (options.to) { params.push(options.to); where.push(`observed_date <= $${params.length}::date`); }
  if (options.kind) { params.push(options.kind); where.push(`kind = $${params.length}`); }
  if (options.cursor) {
    let cursor; try { cursor = decodeDerivedCursor(options.cursor); } catch { throw new InsightsServiceError(400, "INVALID_CURSOR", "Invalid derived cursor"); }
    params.push(cursor.createdAt, cursor.id); where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const limit = limitValue(options.limit); params.push(limit + 1);
  const result = await pool.query<DerivedRow>(`SELECT id, machine_id, observed_date, kind, title, content_markdown, payload_json, created_at
    FROM derived_observations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
  const hasMore = result.rows.length > limit; const rows = result.rows.slice(0, limit); const tail = rows.at(-1);
  return { items: rows.map(mapDerived), ...(hasMore && tail ? { nextCursor: encodeCursor({ createdAt: iso(tail.created_at), id: tail.id }) } : {}) };
}
