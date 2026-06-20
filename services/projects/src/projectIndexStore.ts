import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { clampLimit, iso, parseCursor, projectExistsForOwner, toCursor } from "./projectStoreUtils.js";
import type {
  ProjectIndexAssociationKind,
  ProjectIndexEntry,
  ProjectIndexEntryInput,
  ProjectIndexListResult
} from "./types.js";

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
  metadata_json: unknown;
};

export type SearchProjectIndexOptions = {
  query?: string;
  sourceService?: string;
  resourceType?: string;
  associationKind?: ProjectIndexAssociationKind;
  limit?: number;
  cursor?: string;
};

export type TombstoneProjectIndexInput = {
  sourceService: string;
  resourceType: string;
  resourceId: string;
};

function toIndexEntry(row: IndexRow): ProjectIndexEntry {
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
    metadataJson: row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json as Record<string, unknown> : {}
  };
}

const INDEX_COLUMNS = `id, project_id, source_service, resource_type, resource_id, association_kind,
  association_id, path, title, summary_text, summary_source, source_version, content_hash,
  source_updated_at, indexed_at, metadata_json`;

export async function searchProjectIndex(
  projectId: string,
  ownerAccountId: string,
  options?: SearchProjectIndexOptions
): Promise<ProjectIndexListResult | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  const pageSize = clampLimit(options?.limit, 20, 100);
  const cursor = parseCursor(options?.cursor);
  const values: Array<string | number> = [projectId];
  let sql = `SELECT ${INDEX_COLUMNS} FROM project_index_entries WHERE project_id = $1 AND is_deleted = FALSE`;
  if (options?.sourceService) {
    values.push(options.sourceService);
    sql += ` AND source_service = $${values.length}`;
  }
  if (options?.resourceType) {
    values.push(options.resourceType);
    sql += ` AND resource_type = $${values.length}`;
  }
  if (options?.associationKind) {
    values.push(options.associationKind);
    sql += ` AND association_kind = $${values.length}`;
  }
  const query = options?.query?.trim();
  if (query) {
    values.push(`%${query}%`);
    sql += ` AND (path ILIKE $${values.length} OR title ILIKE $${values.length} OR summary_text ILIKE $${values.length})`;
  }
  if (cursor) {
    values.push(cursor.t, cursor.id);
    sql += ` AND (indexed_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }
  values.push(pageSize + 1);
  sql += ` ORDER BY indexed_at DESC, id DESC LIMIT $${values.length}`;
  const result = await getProjectsPool().query<IndexRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(toIndexEntry),
    nextCursor: result.rows.length > pageSize && last ? toCursor(last.indexed_at, last.id) : undefined
  };
}

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
