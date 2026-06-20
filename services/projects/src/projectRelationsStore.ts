import { randomUUID } from "node:crypto";
import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import {
  clampLimit,
  DuplicateRelationError,
  InvalidRelationError,
  iso,
  normalizeOwner,
  parseCursor,
  projectExistsForOwner,
  toCursor,
  VersionConflictError
} from "./projectStoreUtils.js";
import type {
  ProjectRelation,
  ProjectRelationDirection,
  ProjectRelationInput,
  ProjectRelationListResult,
  ProjectRelationType,
  ProjectRelationUpdateInput
} from "./types.js";

type RelationRow = {
  id: string;
  source_project_id: string;
  target_project_id: string;
  relation_type: ProjectRelationType;
  directionality: ProjectRelationDirection;
  note: string;
  origin: "manual" | "inferred";
  strength: number | null;
  created_by_kind: "user" | "agent" | "system";
  version: number;
  created_at: string;
  updated_at: string;
};

export type ListProjectRelationsOptions = {
  relationType?: ProjectRelationType;
  directionality?: ProjectRelationDirection;
  limit?: number;
  cursor?: string;
};

const RELATION_COLUMNS = `r.id, r.source_project_id, r.target_project_id, r.relation_type,
  r.directionality, r.note, r.origin, r.strength, r.created_by_kind, r.version,
  r.created_at, r.updated_at`;

function toRelation(row: RelationRow): ProjectRelation {
  return {
    id: row.id,
    sourceProjectId: row.source_project_id,
    targetProjectId: row.target_project_id,
    relationType: row.relation_type,
    directionality: row.directionality,
    note: row.note,
    origin: row.origin,
    strength: row.strength ?? undefined,
    createdByKind: row.created_by_kind,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function rethrowDuplicate(error: unknown): never {
  if ((error as { code?: string }).code === "23505") throw new DuplicateRelationError();
  throw error;
}

export async function listProjectRelations(
  projectId: string,
  ownerAccountId: string,
  options?: ListProjectRelationsOptions
): Promise<ProjectRelationListResult | undefined> {
  if (!(await projectExistsForOwner(projectId, ownerAccountId))) return undefined;
  const pageSize = clampLimit(options?.limit, 10, 100);
  const cursor = parseCursor(options?.cursor);
  const values: Array<string | number> = [projectId];
  let sql = `SELECT ${RELATION_COLUMNS} FROM project_relations r
    WHERE (r.source_project_id = $1 OR r.target_project_id = $1) AND r.is_deleted = FALSE`;
  if (options?.relationType) {
    values.push(options.relationType);
    sql += ` AND r.relation_type = $${values.length}`;
  }
  if (options?.directionality) {
    values.push(options.directionality);
    sql += ` AND r.directionality = $${values.length}`;
  }
  if (cursor) {
    values.push(cursor.t, cursor.id);
    sql += ` AND (r.updated_at, r.id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }
  values.push(pageSize + 1);
  sql += ` ORDER BY r.updated_at DESC, r.id DESC LIMIT $${values.length}`;
  const result = await getProjectsPool().query<RelationRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(toRelation),
    nextCursor: result.rows.length > pageSize && last ? toCursor(last.updated_at, last.id) : undefined
  };
}

export async function createProjectRelation(
  sourceProjectId: string,
  input: ProjectRelationInput,
  ownerAccountId: string
): Promise<ProjectRelation | undefined> {
  if (sourceProjectId === input.targetProjectId) throw new InvalidRelationError("A project cannot relate to itself");
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const projects = await getProjectsPool().query<{ id: string }>(
    `SELECT id FROM projects WHERE id = ANY($1::text[]) AND owner_account_id = $2`,
    [[sourceProjectId, input.targetProjectId], owner]
  );
  if (projects.rows.length !== 2) return undefined;
  try {
    const result = await getProjectsPool().query<RelationRow>(
      `
        INSERT INTO project_relations (
          id, source_project_id, target_project_id, relation_type, directionality,
          note, origin, strength, created_by_kind
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING ${RELATION_COLUMNS.replaceAll("r.", "")}
      `,
      [randomUUID(), sourceProjectId, input.targetProjectId, input.relationType,
        input.directionality ?? "directed", input.note?.trim() ?? "", input.origin ?? "manual",
        input.strength ?? null, input.createdByKind]
    );
    return toRelation(result.rows[0]);
  } catch (error) {
    return rethrowDuplicate(error);
  }
}

export async function updateProjectRelation(
  relationId: string,
  input: ProjectRelationUpdateInput,
  ownerAccountId: string
): Promise<ProjectRelation | undefined> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const existing = await getProjectsPool().query<RelationRow>(
    `SELECT ${RELATION_COLUMNS} FROM project_relations r JOIN projects p ON p.id = r.source_project_id
     WHERE r.id = $1 AND p.owner_account_id = $2 AND r.is_deleted = FALSE LIMIT 1`,
    [relationId, owner]
  );
  const current = existing.rows[0];
  if (!current) return undefined;
  if (current.version !== input.expectedVersion) {
    throw new VersionConflictError(`Expected relation version ${input.expectedVersion}, current version is ${current.version}`);
  }
  try {
    const result = await getProjectsPool().query<RelationRow>(
      `
        UPDATE project_relations r SET
          relation_type = COALESCE($3, r.relation_type),
          directionality = COALESCE($4, r.directionality),
          note = COALESCE($5, r.note),
          origin = COALESCE($6, r.origin),
          strength = CASE WHEN $7::boolean THEN $8::double precision ELSE r.strength END,
          version = r.version + 1,
          updated_at = NOW()
        FROM projects p
        WHERE r.id = $1 AND r.source_project_id = p.id AND p.owner_account_id = $2
          AND r.is_deleted = FALSE AND r.version = $9
        RETURNING ${RELATION_COLUMNS}
      `,
      [relationId, owner, input.relationType ?? null, input.directionality ?? null,
        input.note === undefined ? null : input.note.trim(), input.origin ?? null,
        input.strength !== undefined, input.strength ?? null, input.expectedVersion]
    );
    if (!result.rows[0]) throw new VersionConflictError();
    return toRelation(result.rows[0]);
  } catch (error) {
    return rethrowDuplicate(error);
  }
}

export async function deleteProjectRelation(relationId: string, ownerAccountId: string): Promise<boolean> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query(
    `
      UPDATE project_relations r SET is_deleted = TRUE, updated_at = NOW(), version = version + 1
      FROM projects p
      WHERE r.id = $1 AND r.source_project_id = p.id AND p.owner_account_id = $2 AND r.is_deleted = FALSE
    `,
    [relationId, normalizeOwner(ownerAccountId)]
  );
  return (result.rowCount ?? 0) > 0;
}
