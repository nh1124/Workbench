import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { clampLimit, iso, normalizeOwner, parseCursor, toCursor } from "./projectStoreUtils.js";
import type { ProjectLink, ProjectLinkListResult } from "./types.js";

type LinkRow = {
  id: string;
  project_id: string;
  target_service: string;
  target_resource_type: string;
  target_resource_id: string;
  relation_type: string;
  title_snapshot: string | null;
  summary_snapshot: string | null;
  linked_at: string;
  metadata_json: unknown;
};

export type ReverseProjectLinksOptions = {
  targetService: string;
  targetResourceType: string;
  targetResourceId: string;
  relationType?: string;
  limit?: number;
  cursor?: string;
};

const LINK_COLUMNS = `l.id, l.project_id, l.target_service, l.target_resource_type, l.target_resource_id,
  l.relation_type, l.title_snapshot, l.summary_snapshot, l.linked_at, l.metadata_json`;

function toLink(row: LinkRow): ProjectLink {
  return {
    id: row.id,
    projectId: row.project_id,
    targetService: row.target_service,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    relationType: row.relation_type,
    titleSnapshot: row.title_snapshot ?? undefined,
    summarySnapshot: row.summary_snapshot ?? undefined,
    linkedAt: iso(row.linked_at),
    metadataJson: row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json as Record<string, unknown> : {}
  };
}

export async function getProjectLink(linkId: string, ownerAccountId: string): Promise<ProjectLink | undefined> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query<LinkRow>(
    `
      SELECT ${LINK_COLUMNS}
      FROM project_links l
      JOIN projects p ON p.id = l.project_id
      WHERE l.id = $1 AND p.owner_account_id = $2 AND l.is_deleted = FALSE
      LIMIT 1
    `,
    [linkId, normalizeOwner(ownerAccountId)]
  );
  return result.rows[0] ? toLink(result.rows[0]) : undefined;
}

export async function listProjectLinksByTarget(
  options: ReverseProjectLinksOptions,
  ownerAccountId: string
): Promise<ProjectLinkListResult> {
  await ensureProjectsSchema();
  const pageSize = clampLimit(options.limit, 20, 100);
  const cursor = parseCursor(options.cursor);
  const values: Array<string | number> = [
    normalizeOwner(ownerAccountId), options.targetService.trim(), options.targetResourceType.trim(), options.targetResourceId.trim()
  ];
  let sql = `
    SELECT ${LINK_COLUMNS}
    FROM project_links l
    JOIN projects p ON p.id = l.project_id
    WHERE p.owner_account_id = $1 AND l.target_service = $2 AND l.target_resource_type = $3
      AND l.target_resource_id = $4 AND l.is_deleted = FALSE
  `;
  if (options.relationType) {
    values.push(options.relationType.trim());
    sql += ` AND l.relation_type = $${values.length}`;
  }
  if (cursor) {
    values.push(cursor.t, cursor.id);
    sql += ` AND (l.linked_at, l.id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }
  values.push(pageSize + 1);
  sql += ` ORDER BY l.linked_at DESC, l.id DESC LIMIT $${values.length}`;
  const result = await getProjectsPool().query<LinkRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(toLink),
    nextCursor: result.rows.length > pageSize && last ? toCursor(last.linked_at, last.id) : undefined
  };
}
