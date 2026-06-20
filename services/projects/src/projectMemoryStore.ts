import { randomUUID } from "node:crypto";
import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { clampLimit, iso, normalizeOwner, parseCursor, projectExistsForOwner, toCursor } from "./projectStoreUtils.js";
import type {
  ProjectMemoryAuthority,
  ProjectMemoryEntry,
  ProjectMemoryInput,
  ProjectMemoryKind,
  ProjectMemoryListResult,
  ProjectMemoryStatus,
  ProjectMemoryUpdateInput
} from "./types.js";

type MemoryRow = {
  id: string;
  project_id: string;
  kind: ProjectMemoryKind;
  body_markdown: string;
  authority: ProjectMemoryAuthority;
  source_service: string | null;
  source_resource_type: string | null;
  source_resource_id: string | null;
  confidence: number | null;
  status: ProjectMemoryStatus;
  supersedes_id: string | null;
  created_by_kind: "user" | "agent" | "system";
  created_at: string;
  updated_at: string;
};

export type ListProjectMemoriesOptions = {
  query?: string;
  kind?: ProjectMemoryKind;
  authority?: ProjectMemoryAuthority;
  status?: ProjectMemoryStatus;
  limit?: number;
  cursor?: string;
};

function toMemory(row: MemoryRow): ProjectMemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    bodyMarkdown: row.body_markdown,
    authority: row.authority,
    sourceService: row.source_service ?? undefined,
    sourceResourceType: row.source_resource_type ?? undefined,
    sourceResourceId: row.source_resource_id ?? undefined,
    confidence: row.confidence ?? undefined,
    status: row.status,
    supersedesId: row.supersedes_id ?? undefined,
    createdByKind: row.created_by_kind,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const MEMORY_SELECT = `
  SELECT m.id, m.project_id, m.kind, m.body_markdown, m.authority, m.source_service,
         m.source_resource_type, m.source_resource_id, m.confidence, m.status,
         m.supersedes_id, m.created_by_kind, m.created_at, m.updated_at
  FROM project_memory_entries m
`;

export async function listProjectMemories(
  projectId: string,
  ownerAccountId: string,
  options?: ListProjectMemoriesOptions
): Promise<ProjectMemoryListResult | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  const pageSize = clampLimit(options?.limit, 10, 100);
  const cursor = parseCursor(options?.cursor);
  const values: Array<string | number> = [projectId];
  let sql = `${MEMORY_SELECT} WHERE m.project_id = $1`;
  values.push(options?.status ?? "active");
  sql += ` AND m.status = $${values.length}`;
  if (options?.kind) {
    values.push(options.kind);
    sql += ` AND m.kind = $${values.length}`;
  }
  if (options?.authority) {
    values.push(options.authority);
    sql += ` AND m.authority = $${values.length}`;
  }
  const query = options?.query?.trim();
  if (query) {
    values.push(`%${query}%`);
    sql += ` AND m.body_markdown ILIKE $${values.length}`;
  }
  if (cursor) {
    values.push(cursor.t, cursor.id);
    sql += ` AND (m.updated_at, m.id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }
  values.push(pageSize + 1);
  sql += ` ORDER BY m.updated_at DESC, m.id DESC LIMIT $${values.length}`;
  const result = await getProjectsPool().query<MemoryRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(toMemory),
    nextCursor: result.rows.length > pageSize && last ? toCursor(last.updated_at, last.id) : undefined
  };
}

export async function appendProjectMemory(
  projectId: string,
  input: ProjectMemoryInput,
  ownerAccountId: string
): Promise<ProjectMemoryEntry | undefined> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const client = await getProjectsPool().connect();
  try {
    await client.query("BEGIN");
    const project = await client.query(`SELECT 1 FROM projects WHERE id = $1 AND owner_account_id = $2 FOR UPDATE`, [projectId, owner]);
    if ((project.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }
    if (input.supersedesId) {
      const superseded = await client.query(
        `
          UPDATE project_memory_entries
          SET status = 'superseded', updated_at = NOW()
          WHERE id = $1 AND project_id = $2 AND status = 'active'
        `,
        [input.supersedesId, projectId]
      );
      if ((superseded.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return undefined;
      }
    }
    const result = await client.query<MemoryRow>(
      `
        INSERT INTO project_memory_entries (
          id, project_id, kind, body_markdown, authority, source_service, source_resource_type,
          source_resource_id, confidence, supersedes_id, created_by_kind
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id, project_id, kind, body_markdown, authority, source_service,
                  source_resource_type, source_resource_id, confidence, status,
                  supersedes_id, created_by_kind, created_at, updated_at
      `,
      [
        randomUUID(), projectId, input.kind, input.bodyMarkdown.trim(), input.authority,
        input.sourceService?.trim() || null, input.sourceResourceType?.trim() || null,
        input.sourceResourceId?.trim() || null, input.confidence ?? null,
        input.supersedesId ?? null, input.createdByKind
      ]
    );
    await client.query("COMMIT");
    return toMemory(result.rows[0]);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateProjectMemory(
  memoryId: string,
  input: ProjectMemoryUpdateInput,
  ownerAccountId: string
): Promise<ProjectMemoryEntry | undefined> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query<MemoryRow>(
    `
      UPDATE project_memory_entries m
      SET body_markdown = COALESCE($3, m.body_markdown),
          status = COALESCE($4, m.status),
          authority = COALESCE($5, m.authority),
          updated_at = NOW()
      FROM projects p
      WHERE m.id = $1 AND m.project_id = p.id AND p.owner_account_id = $2
      RETURNING m.id, m.project_id, m.kind, m.body_markdown, m.authority, m.source_service,
                m.source_resource_type, m.source_resource_id, m.confidence, m.status,
                m.supersedes_id, m.created_by_kind, m.created_at, m.updated_at
    `,
    [memoryId, normalizeOwner(ownerAccountId), input.bodyMarkdown?.trim() || null, input.status ?? null, input.authority ?? null]
  );
  return result.rows[0] ? toMemory(result.rows[0]) : undefined;
}
