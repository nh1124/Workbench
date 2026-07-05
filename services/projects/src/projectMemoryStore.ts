import { randomUUID } from "node:crypto";
import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { clampLimit, iso, normalizeOwner, parseCursor, projectExistsForOwner, toCursor } from "./projectStoreUtils.js";
import type {
  ProjectMemoryAuthority,
  ProjectMemoryEntry,
  ProjectMemoryInput,
  ProjectMemoryKind,
  ProjectMemoryLifecycleState,
  ProjectMemoryListResult,
  ProjectMemoryReviewReason,
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
  lifecycle_state: ProjectMemoryLifecycleState;
  review_after: string | null;
  last_confirmed_at: string | null;
  review_reason: ProjectMemoryReviewReason | null;
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

export class ProjectMemoryStateConflictError extends Error {
  readonly status = 409;
  readonly code = "PROJECT_MEMORY_NOT_ACTIVE";

  constructor() {
    super("Project memory must be active");
    this.name = "ProjectMemoryStateConflictError";
  }
}

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
    lifecycleState: row.lifecycle_state,
    reviewAfter: row.review_after ? iso(row.review_after) : null,
    lastConfirmedAt: row.last_confirmed_at ? iso(row.last_confirmed_at) : null,
    reviewReason: row.review_reason,
    createdByKind: row.created_by_kind,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const MEMORY_SELECT = `
  SELECT m.id, m.project_id, m.kind, m.body_markdown, m.authority, m.source_service,
         m.source_resource_type, m.source_resource_id, m.confidence, m.status,
         m.supersedes_id, m.lifecycle_state, m.review_after, m.last_confirmed_at,
         m.review_reason, m.created_by_kind, m.created_at, m.updated_at
  FROM project_memory_entries m
`;

const MEMORY_RETURNING = `
  m.id, m.project_id, m.kind, m.body_markdown, m.authority, m.source_service,
  m.source_resource_type, m.source_resource_id, m.confidence, m.status,
  m.supersedes_id, m.lifecycle_state, m.review_after, m.last_confirmed_at,
  m.review_reason, m.created_by_kind, m.created_at, m.updated_at
`;

async function getMemoryForOwner(memoryId: string, ownerAccountId: string): Promise<ProjectMemoryEntry | undefined> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query<MemoryRow>(
    `
      ${MEMORY_SELECT}
      JOIN projects p ON p.id = m.project_id
      WHERE m.id = $1 AND p.owner_account_id = $2
      LIMIT 1
    `,
    [memoryId, normalizeOwner(ownerAccountId)]
  );
  return result.rows[0] ? toMemory(result.rows[0]) : undefined;
}

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
          source_resource_id, confidence, supersedes_id, lifecycle_state, review_after,
          review_reason, created_by_kind
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id, project_id, kind, body_markdown, authority, source_service,
                  source_resource_type, source_resource_id, confidence, status,
                  supersedes_id, lifecycle_state, review_after, last_confirmed_at,
                  review_reason, created_by_kind, created_at, updated_at
      `,
      [
        randomUUID(), projectId, input.kind, input.bodyMarkdown.trim(), input.authority,
        input.sourceService?.trim() || null, input.sourceResourceType?.trim() || null,
        input.sourceResourceId?.trim() || null, input.confidence ?? null,
        input.supersedesId ?? null, input.lifecycleState ?? "triaged",
        input.reviewAfter ?? null, input.reviewReason ?? null, input.createdByKind
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
  const values: Array<string | null> = [memoryId, normalizeOwner(ownerAccountId)];
  const setClauses = ["updated_at = NOW()"];
  const body = input.bodyMarkdown?.trim();
  if (body) {
    values.push(body);
    setClauses.push(`body_markdown = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    setClauses.push(`status = $${values.length}`);
  }
  if (input.authority !== undefined) {
    values.push(input.authority);
    setClauses.push(`authority = $${values.length}`);
  }
  if (input.lifecycleState !== undefined) {
    values.push(input.lifecycleState);
    setClauses.push(`lifecycle_state = $${values.length}`);
  }
  if (Object.hasOwn(input, "reviewAfter")) {
    values.push(input.reviewAfter ?? null);
    setClauses.push(`review_after = $${values.length}::timestamptz`);
  }
  if (Object.hasOwn(input, "reviewReason")) {
    values.push(input.reviewReason ?? null);
    setClauses.push(`review_reason = $${values.length}`);
  }

  const result = await getProjectsPool().query<MemoryRow>(
    `
      UPDATE project_memory_entries m
      SET ${setClauses.join(", ")}
      FROM projects p
      WHERE m.id = $1 AND m.project_id = p.id AND p.owner_account_id = $2
      RETURNING m.id, m.project_id, m.kind, m.body_markdown, m.authority, m.source_service,
                m.source_resource_type, m.source_resource_id, m.confidence, m.status,
                m.supersedes_id, m.lifecycle_state, m.review_after, m.last_confirmed_at,
                m.review_reason, m.created_by_kind, m.created_at, m.updated_at
    `,
    values
  );
  return result.rows[0] ? toMemory(result.rows[0]) : undefined;
}

export async function confirmProjectMemory(
  memoryId: string,
  input: { reviewAfter?: string | null },
  ownerAccountId: string
): Promise<ProjectMemoryEntry | undefined> {
  const existing = await getMemoryForOwner(memoryId, ownerAccountId);
  if (!existing) return undefined;
  if (existing.status !== "active") throw new ProjectMemoryStateConflictError();

  const result = await getProjectsPool().query<MemoryRow>(
    `
      UPDATE project_memory_entries m
      SET authority = 'user_confirmed',
          lifecycle_state = 'verified',
          last_confirmed_at = NOW(),
          review_reason = NULL,
          review_after = $2::timestamptz,
          updated_at = NOW()
      WHERE m.id = $1
        AND m.status = 'active'
      RETURNING ${MEMORY_RETURNING}
    `,
    [memoryId, input.reviewAfter ?? null]
  );
  if (result.rows[0]) return toMemory(result.rows[0]);

  const current = await getMemoryForOwner(memoryId, ownerAccountId);
  if (!current) return undefined;
  if (current.status !== "active") throw new ProjectMemoryStateConflictError();
  return undefined;
}

export async function snoozeProjectMemory(
  memoryId: string,
  until: string,
  ownerAccountId: string
): Promise<ProjectMemoryEntry | undefined> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query<MemoryRow>(
    `
      UPDATE project_memory_entries m
      SET review_after = $3::timestamptz,
          updated_at = NOW()
      FROM projects p
      WHERE m.id = $1 AND m.project_id = p.id AND p.owner_account_id = $2
      RETURNING ${MEMORY_RETURNING}
    `,
    [memoryId, normalizeOwner(ownerAccountId), until]
  );
  return result.rows[0] ? toMemory(result.rows[0]) : undefined;
}

export async function flagProjectMemory(
  memoryId: string,
  reason: ProjectMemoryReviewReason,
  ownerAccountId: string
): Promise<ProjectMemoryEntry | undefined> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query<MemoryRow>(
    `
      UPDATE project_memory_entries m
      SET review_reason = $3,
          updated_at = NOW()
      FROM projects p
      WHERE m.id = $1 AND m.project_id = p.id AND p.owner_account_id = $2
      RETURNING ${MEMORY_RETURNING}
    `,
    [memoryId, normalizeOwner(ownerAccountId), reason]
  );
  return result.rows[0] ? toMemory(result.rows[0]) : undefined;
}
