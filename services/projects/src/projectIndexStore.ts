import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { clampLimit, iso, normalizeOwner, parseCursor, projectExistsForOwner, toCursor } from "./projectStoreUtils.js";
import type {
  ProjectIndexAssociationKind,
  ProjectIndexSearchMode,
  ProjectIndexEntry,
  ProjectIndexEntryInput,
  ProjectIndexListResult
} from "./types.js";
import { PROJECT_INDEX_SEARCH_FIELDS } from "./types.js";

type IndexRow = {
  id: string;
  project_id: string;
  source_service: string;
  resource_type: string;
  resource_id: string;
  association_kind: ProjectIndexAssociationKind;
  association_id: string | null;
  path: string | null;
  title: string;
  summary_text: string;
  summary_source: string;
  source_version: string | null;
  content_hash: string | null;
  source_updated_at: string;
  indexed_at: string;
  last_read_at: string | null;
  metadata_json: unknown;
  matched_tokens?: string | number | null;
};

export type SearchProjectIndexOptions = {
  query?: string;
  sourceService?: string;
  resourceType?: string;
  associationKind?: ProjectIndexAssociationKind;
  mode?: ProjectIndexSearchMode;
  limit?: number;
  cursor?: string;
};

export type TombstoneProjectIndexInput = {
  sourceService: string;
  resourceType: string;
  resourceId: string;
};

export type ProjectIndexReadMark = {
  sourceService: string;
  resourceId: string;
};

function toIndexEntry(row: IndexRow): ProjectIndexEntry {
  const matchedTokens = row.matched_tokens === undefined || row.matched_tokens === null
    ? undefined
    : Number(row.matched_tokens);
  return {
    id: row.id,
    projectId: row.project_id,
    sourceService: row.source_service,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    associationKind: row.association_kind,
    associationId: row.association_id ?? undefined,
    path: row.path ?? undefined,
    title: row.title,
    summaryText: row.summary_text,
    summarySource: row.summary_source,
    sourceVersion: row.source_version ?? undefined,
    contentHash: row.content_hash ?? undefined,
    sourceUpdatedAt: iso(row.source_updated_at),
    indexedAt: iso(row.indexed_at),
    lastReadAt: row.last_read_at ? iso(row.last_read_at) : undefined,
    metadataJson: row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json as Record<string, unknown> : {},
    ...(Number.isFinite(matchedTokens) ? { matchedTokens } : {})
  };
}

const INDEX_COLUMNS = `id, project_id, source_service, resource_type, resource_id, association_kind,
  association_id, path, title, summary_text, summary_source, source_version, content_hash,
  source_updated_at, indexed_at, last_read_at, metadata_json`;

function normalizeProjectIndexQuery(query: string | undefined): string[] {
  const normalized = query?.normalize("NFKC").trim();
  return normalized ? normalized.split(/\s+/).filter((token) => token.length > 0) : [];
}

function normalizeProjectIndexSearchMode(mode: ProjectIndexSearchMode | undefined): ProjectIndexSearchMode {
  return mode === "all" ? "all" : "any";
}

export async function searchProjectIndex(
  projectId: string,
  ownerAccountId: string,
  options?: SearchProjectIndexOptions
): Promise<ProjectIndexListResult | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  const pageSize = clampLimit(options?.limit, 20, 100);
  const cursor = parseCursor(options?.cursor);
  const mode = normalizeProjectIndexSearchMode(options?.mode);
  const tokens = normalizeProjectIndexQuery(options?.query);
  const values: Array<string | number> = [projectId];
  const where = ["project_id = $1", "is_deleted = FALSE"];
  const matchedTokenExpressions: string[] = [];
  if (options?.sourceService) {
    values.push(options.sourceService);
    where.push(`source_service = $${values.length}`);
  }
  if (options?.resourceType) {
    values.push(options.resourceType);
    where.push(`resource_type = $${values.length}`);
  }
  if (options?.associationKind) {
    values.push(options.associationKind);
    where.push(`association_kind = $${values.length}`);
  }
  if (tokens.length > 0) {
    const predicates: string[] = [];
    // Match tokens across path/title/summary/metadata. "all" keeps AND
    // behavior; "any" returns rows matching at least one token.
    // A single ILIKE on the whole query
    // string would return nothing for multi-word queries such as "豚こま 生姜焼き".
    // metadata_json is included so tags (e.g. "recipe") are searchable too.
    for (const term of tokens) {
      values.push(`%${term}%`);
      const placeholder = `$${values.length}`;
      const predicate = `(path ILIKE ${placeholder} OR title ILIKE ${placeholder} OR summary_text ILIKE ${placeholder} OR metadata_json::text ILIKE ${placeholder})`;
      predicates.push(predicate);
      matchedTokenExpressions.push(`CASE WHEN ${predicate} THEN 1 ELSE 0 END`);
    }
    where.push(mode === "all" ? predicates.join(" AND ") : `(${predicates.join(" OR ")})`);
  }
  if (cursor) {
    values.push(cursor.t, cursor.id);
    where.push(`(indexed_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  const selectColumns = mode === "any" && matchedTokenExpressions.length > 0
    ? `${INDEX_COLUMNS}, (${matchedTokenExpressions.join(" + ")})::int AS matched_tokens`
    : INDEX_COLUMNS;
  values.push(pageSize + 1);
  let sql = `SELECT ${selectColumns} FROM project_index_entries WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY indexed_at DESC, id DESC LIMIT $${values.length}`;
  const result = await getProjectsPool().query<IndexRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(toIndexEntry),
    nextCursor: result.rows.length > pageSize && last ? toCursor(last.indexed_at, last.id) : undefined,
    ...(tokens.length > 0
      ? { appliedQuery: { tokens, mode, fields: [...PROJECT_INDEX_SEARCH_FIELDS] } }
      : {})
  };
}

export const projectIndexStoreTestHooks = {
  normalizeProjectIndexQuery,
  normalizeProjectIndexSearchMode
};

async function upsertWithClient(client: PoolClient, projectId: string, input: ProjectIndexEntryInput): Promise<ProjectIndexEntry> {
  const result = await client.query<IndexRow>(
    `
      INSERT INTO project_index_entries (
        id, project_id, source_service, resource_type, resource_id, association_kind,
        association_id, path, title, summary_text, summary_source, source_version,
        content_hash, source_updated_at, metadata_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (project_id, source_service, resource_type, resource_id)
      WHERE is_deleted = FALSE
      DO UPDATE SET
        association_kind = EXCLUDED.association_kind,
        association_id = EXCLUDED.association_id,
        path = EXCLUDED.path,
        title = EXCLUDED.title,
        summary_text = EXCLUDED.summary_text,
        summary_source = EXCLUDED.summary_source,
        source_version = EXCLUDED.source_version,
        content_hash = EXCLUDED.content_hash,
        source_updated_at = EXCLUDED.source_updated_at,
        indexed_at = NOW(),
        metadata_json = EXCLUDED.metadata_json,
        is_deleted = FALSE
      RETURNING ${INDEX_COLUMNS}
    `,
    [
      randomUUID(), projectId, input.sourceService.trim(), input.resourceType.trim(), input.resourceId.trim(),
      input.associationKind, input.associationId?.trim() || null, input.path?.trim() || null,
      input.title.trim(), input.summaryText.trim(), input.summarySource?.trim() || "deterministic",
      input.sourceVersion?.trim() || null, input.contentHash?.trim() || null,
      input.sourceUpdatedAt, JSON.stringify(input.metadataJson ?? {})
    ]
  );
  return toIndexEntry(result.rows[0]);
}

export async function upsertProjectIndexEntry(
  projectId: string,
  input: ProjectIndexEntryInput,
  ownerAccountId: string
): Promise<ProjectIndexEntry | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  const client = await getProjectsPool().connect();
  try {
    return await upsertWithClient(client, projectId, input);
  } finally {
    client.release();
  }
}

export async function bulkUpsertProjectIndexEntries(
  projectId: string,
  entries: ProjectIndexEntryInput[],
  ownerAccountId: string
): Promise<ProjectIndexEntry[] | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  await ensureProjectsSchema();
  const client = await getProjectsPool().connect();
  try {
    await client.query("BEGIN");
    const items: ProjectIndexEntry[] = [];
    for (const entry of entries) items.push(await upsertWithClient(client, projectId, entry));
    await client.query("COMMIT");
    return items;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function tombstoneProjectIndexEntry(
  projectId: string,
  input: TombstoneProjectIndexInput,
  ownerAccountId: string
): Promise<boolean | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  const result = await getProjectsPool().query(
    `
      UPDATE project_index_entries
      SET is_deleted = TRUE, indexed_at = NOW()
      WHERE project_id = $1 AND source_service = $2 AND resource_type = $3
        AND resource_id = $4 AND is_deleted = FALSE
    `,
    [projectId, input.sourceService.trim(), input.resourceType.trim(), input.resourceId.trim()]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markProjectIndexEntriesRead(
  ownerAccountId: string,
  marks: ProjectIndexReadMark[],
  readAt: string
): Promise<{ updated: number }> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const normalizedMarks = marks.map((mark) => ({
    source_service: mark.sourceService.trim(),
    resource_id: mark.resourceId.trim()
  })).filter((mark) => mark.source_service && mark.resource_id);
  if (normalizedMarks.length === 0) return { updated: 0 };

  const result = await getProjectsPool().query(
    `
      WITH marks AS (
        SELECT DISTINCT source_service, resource_id
        FROM jsonb_to_recordset($2::jsonb) AS mark(source_service text, resource_id text)
      )
      UPDATE project_index_entries i
      SET last_read_at = GREATEST(COALESCE(i.last_read_at, $3::timestamptz), $3::timestamptz)
      FROM projects p, marks m
      WHERE p.id = i.project_id
        AND p.owner_account_id = $1
        AND i.is_deleted = FALSE
        AND i.source_service = m.source_service
        AND i.resource_id = m.resource_id
    `,
    [owner, JSON.stringify(normalizedMarks), readAt]
  );
  return { updated: result.rowCount ?? 0 };
}
