import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  summaryInputSchema,
  type ResourceRef,
  type SummaryInput,
  type SummaryListItem,
  type SummaryRecord
} from "../types.js";
import type { AnalyserQueryPool } from "./machines.js";

type SummaryRow = {
  id: string;
  kind: string;
  period_start: Date | string;
  period_end: Date | string;
  title: string;
  body_markdown: string;
  metrics: Record<string, unknown> | null;
  evidence_refs: ResourceRef[] | null;
  routine_key: string | null;
  run_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type SummaryListRow = Omit<SummaryRow, "body_markdown"> & { body_chars: string | number };

const SUMMARY_COLUMNS = `id, kind, period_start, period_end, title, body_markdown, metrics,
  evidence_refs, routine_key, run_id, version, created_at, updated_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function date(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function parseInput(input: unknown): SummaryInput {
  const parsed = summaryInputSchema.safeParse(input);
  if (!parsed.success) throw new AnalyserServiceError(400, "INVALID_SUMMARY", "Invalid summary input");
  return parsed.data;
}

function mapSummary(row: SummaryRow): SummaryRecord {
  return {
    id: row.id,
    kind: row.kind,
    periodStart: date(row.period_start),
    periodEnd: date(row.period_end),
    title: row.title,
    bodyMarkdown: row.body_markdown,
    ...(row.metrics === null ? {} : { metrics: row.metrics }),
    evidenceRefs: row.evidence_refs ?? [],
    ...(row.routine_key === null ? {} : { routineKey: row.routine_key }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapSummaryListItem(row: SummaryListRow): SummaryListItem {
  return {
    id: row.id,
    kind: row.kind,
    periodStart: date(row.period_start),
    periodEnd: date(row.period_end),
    title: row.title,
    ...(row.metrics === null ? {} : { metrics: row.metrics }),
    evidenceRefs: row.evidence_refs ?? [],
    ...(row.routine_key === null ? {} : { routineKey: row.routine_key }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    bodyChars: Number(row.body_chars)
  };
}

function encodeCursor(periodEnd: string, id: string): string {
  return Buffer.from(`${periodEnd}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.indexOf("|");
    const periodEnd = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || !id || encodeCursor(periodEnd, id) !== cursor) throw new Error("invalid");
    return [periodEnd, id];
  } catch {
    throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid summary cursor");
  }
}

function boundedLimit(value: number | undefined): number {
  return value === undefined ? 50 : Math.min(200, Math.max(1, Math.trunc(value)));
}

export async function upsertSummary(owner: string, input: SummaryInput): Promise<SummaryRecord> {
  return upsertSummaryWithPool(getAnalyserPool(), owner, input);
}

export async function upsertSummaryWithPool(pool: AnalyserQueryPool, owner: string, rawInput: SummaryInput): Promise<SummaryRecord> {
  const input = parseInput(rawInput);
  const result = await pool.query<SummaryRow>(`INSERT INTO analyser_summaries
    (service_account_id, kind, period_start, period_end, title, body_markdown, metrics,
      evidence_refs, routine_key, run_id)
    VALUES ($1, $2, $3::date, $4::date, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
    ON CONFLICT (service_account_id, kind, period_start, period_end) DO UPDATE SET
      title = EXCLUDED.title,
      body_markdown = EXCLUDED.body_markdown,
      metrics = EXCLUDED.metrics,
      evidence_refs = EXCLUDED.evidence_refs,
      routine_key = EXCLUDED.routine_key,
      run_id = EXCLUDED.run_id,
      version = analyser_summaries.version + 1,
      updated_at = NOW()
    WHERE ($11::integer IS NULL OR analyser_summaries.version = $11)
    RETURNING ${SUMMARY_COLUMNS}`, [
    owner,
    input.kind,
    input.periodStart,
    input.periodEnd,
    input.title,
    input.bodyMarkdown,
    input.metrics === undefined ? null : JSON.stringify(input.metrics),
    JSON.stringify(input.evidenceRefs ?? []),
    input.routineKey ?? null,
    input.runId ?? null,
    input.expectedVersion ?? null
  ]);
  if (!result.rows[0]) throw new AnalyserServiceError(409, "VERSION_CONFLICT", "Summary version conflict");
  return mapSummary(result.rows[0]);
}

export async function getSummary(owner: string, id: string): Promise<SummaryRecord> {
  return getSummaryWithPool(getAnalyserPool(), owner, id);
}

export async function getSummaryWithPool(pool: AnalyserQueryPool, owner: string, id: string): Promise<SummaryRecord> {
  const result = await pool.query<SummaryRow>(`SELECT ${SUMMARY_COLUMNS}
    FROM analyser_summaries
    WHERE service_account_id = $1 AND id = $2`, [owner, id]);
  if (!result.rows[0]) throw new AnalyserServiceError(404, "SUMMARY_NOT_FOUND", "Summary not found");
  return mapSummary(result.rows[0]);
}

export async function listSummaries(
  owner: string,
  options: { kind?: string; from?: string; to?: string; routineKey?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: SummaryListItem[]; nextCursor?: string }> {
  return listSummariesWithPool(getAnalyserPool(), owner, options);
}

export async function listSummariesWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { kind?: string; from?: string; to?: string; routineKey?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: SummaryListItem[]; nextCursor?: string }> {
  const values: unknown[] = [owner];
  const where = ["service_account_id = $1"];
  const add = (clause: string, value: unknown): void => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (options.kind) add("kind = ?", options.kind);
  if (options.from) add("period_end >= ?::date", options.from);
  if (options.to) add("period_start <= ?::date", options.to);
  if (options.routineKey) add("routine_key = ?", options.routineKey);
  if (options.cursor) {
    const [periodEnd, id] = decodeCursor(options.cursor);
    values.push(periodEnd, id);
    where.push(`(period_end, id) < ($${values.length - 1}::date, $${values.length}::uuid)`);
  }
  const limit = boundedLimit(options.limit);
  values.push(limit + 1);
  const result = await pool.query<SummaryListRow>(`SELECT id, kind, period_start, period_end, title, metrics,
      evidence_refs, routine_key, run_id, version, created_at, updated_at,
      LENGTH(body_markdown)::integer AS body_chars
    FROM analyser_summaries
    WHERE ${where.join(" AND ")}
    ORDER BY period_end DESC, id DESC
    LIMIT $${values.length}`, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  return {
    items: rows.map(mapSummaryListItem),
    ...(hasMore && tail ? { nextCursor: encodeCursor(date(tail.period_end), tail.id) } : {})
  };
}
