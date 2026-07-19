import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  publicationInputSchema,
  type PublicationInput,
  type PublicationRecord,
  type ResourceRef
} from "../types.js";
import type { AnalyserQueryPool } from "./machines.js";

type PublicationRow = {
  id: string;
  source_kind: "summary" | "proposal";
  source_id: string;
  target_kind: "note" | "artifact";
  target_id: string;
  target_ref: ResourceRef | null;
  content_hash: string;
  provenance: "ui" | "agent";
  created_at: Date | string;
};

const PUBLICATION_COLUMNS = `id, source_kind, source_id, target_kind, target_id,
  target_ref, content_hash, provenance, created_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPublication(row: PublicationRow): PublicationRecord {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    ...(row.target_ref === null ? {} : { targetRef: row.target_ref }),
    contentHash: row.content_hash,
    provenance: row.provenance,
    createdAt: iso(row.created_at)
  };
}

function parseInput(value: unknown): PublicationInput {
  const parsed = publicationInputSchema.safeParse(value);
  if (!parsed.success) throw new AnalyserServiceError(400, "INVALID_PUBLICATION", "Invalid publication input");
  return parsed.data;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (separator < 0 || Number.isNaN(new Date(createdAt).getTime()) || !id || encodeCursor(createdAt, id) !== cursor) throw new Error("invalid");
    return [createdAt, id];
  } catch {
    throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid publication cursor");
  }
}

function boundedLimit(value: number | undefined): number {
  return value === undefined ? 50 : Math.min(200, Math.max(1, Math.trunc(value)));
}

export async function recordPublication(owner: string, input: PublicationInput): Promise<{ publication: PublicationRecord; created: boolean }> {
  return recordPublicationWithPool(getAnalyserPool(), owner, input);
}

export async function recordPublicationWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  rawInput: PublicationInput
): Promise<{ publication: PublicationRecord; created: boolean }> {
  const input = parseInput(rawInput);
  const sourceTable = input.sourceKind === "summary" ? "analyser_summaries" : "analyser_proposals";
  const source = await pool.query<{ id: string }>(`SELECT id FROM ${sourceTable}
    WHERE service_account_id = $1 AND id = $2`, [owner, input.sourceId]);
  if (!source.rows[0]) throw new AnalyserServiceError(400, "SOURCE_NOT_FOUND", "Publication source not found");
  const inserted = await pool.query<PublicationRow>(`INSERT INTO analyser_publications
    (service_account_id, source_kind, source_id, target_kind, target_id, target_ref, content_hash, provenance)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    ON CONFLICT (service_account_id, source_kind, source_id, target_kind, content_hash) DO NOTHING
    RETURNING ${PUBLICATION_COLUMNS}`, [
    owner, input.sourceKind, input.sourceId, input.targetKind, input.targetId,
    input.targetRef === undefined ? null : JSON.stringify(input.targetRef), input.contentHash, input.provenance
  ]);
  if (inserted.rows[0]) return { publication: mapPublication(inserted.rows[0]), created: true };
  const existing = await findPublicationWithPool(pool, owner, input);
  if (!existing) throw new AnalyserServiceError(500, "PUBLICATION_RECORD_FAILED", "Publication dedupe record not found");
  return { publication: existing, created: false };
}

export async function findPublication(
  owner: string,
  input: Pick<PublicationInput, "sourceKind" | "sourceId" | "targetKind" | "contentHash">
): Promise<PublicationRecord | undefined> {
  return findPublicationWithPool(getAnalyserPool(), owner, input);
}

export async function findPublicationWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  input: Pick<PublicationInput, "sourceKind" | "sourceId" | "targetKind" | "contentHash">
): Promise<PublicationRecord | undefined> {
  const result = await pool.query<PublicationRow>(`SELECT ${PUBLICATION_COLUMNS}
    FROM analyser_publications
    WHERE service_account_id = $1 AND source_kind = $2 AND source_id = $3
      AND target_kind = $4 AND content_hash = $5`, [owner, input.sourceKind, input.sourceId, input.targetKind, input.contentHash]);
  return result.rows[0] ? mapPublication(result.rows[0]) : undefined;
}

export async function listPublications(
  owner: string,
  options: { sourceKind?: PublicationRecord["sourceKind"]; sourceId?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: PublicationRecord[]; nextCursor?: string }> {
  return listPublicationsWithPool(getAnalyserPool(), owner, options);
}

export async function listPublicationsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { sourceKind?: PublicationRecord["sourceKind"]; sourceId?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: PublicationRecord[]; nextCursor?: string }> {
  const values: unknown[] = [owner];
  const where = ["service_account_id = $1"];
  const add = (clause: string, value: unknown): void => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (options.sourceKind) add("source_kind = ?", options.sourceKind);
  if (options.sourceId) add("source_id = ?", options.sourceId);
  if (options.cursor) {
    const [createdAt, id] = decodeCursor(options.cursor);
    values.push(createdAt, id);
    where.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  const limit = boundedLimit(options.limit);
  values.push(limit + 1);
  const result = await pool.query<PublicationRow>(`SELECT ${PUBLICATION_COLUMNS}
    FROM analyser_publications WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT $${values.length}`, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  return { items: rows.map(mapPublication), ...(hasMore && tail ? { nextCursor: encodeCursor(iso(tail.created_at), tail.id) } : {}) };
}
