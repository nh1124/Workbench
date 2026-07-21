import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  derivedCaptureInputSchema,
  type DerivedCaptureInput,
  type DerivedCaptureRecord,
  type ResourceRef
} from "../types.js";
import { requireMachineWithPool, type AnalyserQueryPool } from "./machines.js";

type DerivedCaptureRow = {
  id: string;
  machine_id: string | null;
  kind: string;
  title: string;
  summary_markdown: string;
  evidence_refs: ResourceRef[] | null;
  occurred_at: Date | string;
  received_at: Date | string;
  created_at: Date | string;
};

const DERIVED_CAPTURE_COLUMNS = `id, machine_id, kind, title, summary_markdown, evidence_refs,
  occurred_at, received_at, created_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseInput(input: unknown): DerivedCaptureInput {
  const parsed = derivedCaptureInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AnalyserServiceError(400, "INVALID_DERIVED_CAPTURE", "Invalid derived capture input");
  }
  return parsed.data;
}

function mapDerivedCapture(row: DerivedCaptureRow): DerivedCaptureRecord {
  return {
    id: row.id,
    ...(row.machine_id === null ? {} : { machineId: row.machine_id }),
    kind: row.kind,
    title: row.title,
    summaryMarkdown: row.summary_markdown,
    evidenceRefs: row.evidence_refs ?? [],
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    createdAt: iso(row.created_at)
  };
}

function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const occurredAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator < 0 || Number.isNaN(new Date(occurredAt).getTime()) || !id
      || encodeCursor(occurredAt, id) !== cursor) throw new Error("invalid");
    return [occurredAt, id];
  } catch {
    throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid derived capture cursor");
  }
}

function boundedLimit(value: number | undefined): number {
  return value === undefined ? 50 : Math.min(200, Math.max(1, Math.trunc(value)));
}

export async function ingestDerivedCapture(
  owner: string,
  input: DerivedCaptureInput
): Promise<{ capture: DerivedCaptureRecord; created: boolean }> {
  return ingestDerivedCaptureWithPool(getAnalyserPool(), owner, input);
}

export async function ingestDerivedCaptureWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  rawInput: DerivedCaptureInput
): Promise<{ capture: DerivedCaptureRecord; created: boolean }> {
  const input = parseInput(rawInput);
  if (input.machineId) await requireMachineWithPool(pool, owner, input.machineId);
  const records = [{
    machineId: input.machineId ?? null,
    kind: input.kind,
    title: input.title,
    summaryMarkdown: input.summaryMarkdown,
    evidenceRefs: input.evidenceRefs ?? [],
    occurredAt: input.occurredAt,
    dedupeKey: input.dedupeKey
  }];
  const result = await pool.query<DerivedCaptureRow>(`INSERT INTO analyser_derived_captures
    (service_account_id, machine_id, kind, title, summary_markdown, evidence_refs, occurred_at, dedupe_key)
    SELECT $1, x."machineId", x.kind, x.title, x."summaryMarkdown", x."evidenceRefs", x."occurredAt", x."dedupeKey"
    FROM jsonb_to_recordset($2::jsonb) AS x(
      "machineId" uuid, kind text, title text, "summaryMarkdown" text,
      "evidenceRefs" jsonb, "occurredAt" timestamptz, "dedupeKey" text)
    ON CONFLICT (service_account_id, dedupe_key) DO NOTHING
    RETURNING ${DERIVED_CAPTURE_COLUMNS}`, [owner, JSON.stringify(records)]);
  if (result.rows[0]) return { capture: mapDerivedCapture(result.rows[0]), created: true };

  const existing = await pool.query<DerivedCaptureRow>(`SELECT ${DERIVED_CAPTURE_COLUMNS}
    FROM analyser_derived_captures
    WHERE service_account_id = $1 AND dedupe_key = $2`, [owner, input.dedupeKey]);
  if (!existing.rows[0]) {
    throw new AnalyserServiceError(500, "DERIVED_CAPTURE_CREATE_FAILED", "Derived capture dedupe record not found");
  }
  return { capture: mapDerivedCapture(existing.rows[0]), created: false };
}

export async function listDerivedCaptures(
  owner: string,
  options: { kind?: string; machineId?: string; from?: string; to?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: DerivedCaptureRecord[]; nextCursor?: string }> {
  return listDerivedCapturesWithPool(getAnalyserPool(), owner, options);
}

export async function listDerivedCapturesWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { kind?: string; machineId?: string; from?: string; to?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: DerivedCaptureRecord[]; nextCursor?: string }> {
  const values: unknown[] = [owner];
  const where = ["service_account_id = $1"];
  const add = (clause: string, value: unknown): void => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };
  if (options.kind) add("kind = ?", options.kind);
  if (options.machineId) add("machine_id = ?::uuid", options.machineId);
  if (options.from) add("occurred_at >= ?::timestamptz", options.from);
  if (options.to) add("occurred_at <= ?::timestamptz", options.to);
  if (options.cursor) {
    const [occurredAt, id] = decodeCursor(options.cursor);
    values.push(occurredAt, id);
    where.push(`(date_trunc('milliseconds', occurred_at), id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  const limit = boundedLimit(options.limit);
  values.push(limit + 1);
  const result = await pool.query<DerivedCaptureRow>(`SELECT ${DERIVED_CAPTURE_COLUMNS}
    FROM analyser_derived_captures
    WHERE ${where.join(" AND ")}
    ORDER BY date_trunc('milliseconds', occurred_at) DESC, id DESC
    LIMIT $${values.length}`, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  return {
    items: rows.map(mapDerivedCapture),
    ...(hasMore && tail ? { nextCursor: encodeCursor(iso(tail.occurred_at), tail.id) } : {})
  };
}

export async function getDerivedCapture(owner: string, id: string): Promise<DerivedCaptureRecord> {
  return getDerivedCaptureWithPool(getAnalyserPool(), owner, id);
}

export async function getDerivedCaptureWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  id: string
): Promise<DerivedCaptureRecord> {
  const result = await pool.query<DerivedCaptureRow>(`SELECT ${DERIVED_CAPTURE_COLUMNS}
    FROM analyser_derived_captures
    WHERE service_account_id = $1 AND id = $2`, [owner, id]);
  if (!result.rows[0]) {
    throw new AnalyserServiceError(404, "DERIVED_CAPTURE_NOT_FOUND", "Derived capture not found");
  }
  return mapDerivedCapture(result.rows[0]);
}
