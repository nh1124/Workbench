import { randomUUID } from "node:crypto";
import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import type {
  DefaultProjectSelection,
  Project,
  ProjectContextSummary,
  ProjectInput,
  ProjectLink,
  ProjectLinkInput,
  ProjectLinkListResult,
  ProjectListResult,
  ProjectStatus
} from "./types.js";

export type ListProjectsOptions = {
  query?: string;
  status?: ProjectStatus;
  limit?: number;
  cursor?: string;
};

export type ListProjectLinksOptions = {
  targetService?: string;
  targetResourceType?: string;
  limit?: number;
  cursor?: string;
};

type CursorPayload = {
  t: string;
  id: string;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  is_fallback_default: boolean;
  owner_account_id: string;
  created_at: string;
  updated_at: string;
};

type ProjectPreferenceRow = {
  owner_account_id: string;
  default_project_id: string | null;
};

type ProjectLinkRow = {
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

type ProjectContextSummaryRow = {
  id: string;
  project_id: string;
  summary_text: string;
  source: string;
  updated_at: string;
};

type CountByServiceRow = {
  target_service: string;
  link_count: string;
};

type CountByRelationRow = {
  relation_type: string;
  link_count: string;
};

const SYSTEM_FALLBACK_PROJECT_NAME = "default";
const SYSTEM_FALLBACK_PROJECT_DESCRIPTION = "System fallback default project (immutable).";

function clampLimit(limit: number | undefined, defaultLimit = 20, maxLimit = 100): number {
  if (!Number.isFinite(limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.min(maxLimit, Math.floor(limit ?? defaultLimit)));
}

function normalizeOwner(ownerAccountId: string): string {
  const normalized = ownerAccountId.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Owner account id is required");
  }
  return normalized;
}

function parseCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as CursorPayload;
    if (!parsed?.t || !parsed?.id) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function toCursor(timestampIso: string, id: string): string {
  const payload: CursorPayload = { t: timestampIso, id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    status: row.status,
    ownerAccountId: row.owner_account_id,
    isFallbackDefault: row.is_fallback_default,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toProjectLink(row: ProjectLinkRow): ProjectLink {
  return {
    id: row.id,
    projectId: row.project_id,
    targetService: row.target_service,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    relationType: row.relation_type,
    titleSnapshot: row.title_snapshot ?? undefined,
    summarySnapshot: row.summary_snapshot ?? undefined,
    linkedAt: new Date(row.linked_at).toISOString(),
    metadataJson: row.metadata_json && typeof row.metadata_json === "object" ? (row.metadata_json as Record<string, unknown>) : {}
  };
}

function toProjectContextSummary(row: ProjectContextSummaryRow): ProjectContextSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    summaryText: row.summary_text,
    source: row.source,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

async function readFallbackDefaultProject(ownerAccountId: string): Promise<ProjectRow | undefined> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const result = await pool.query<ProjectRow>(
    `
      SELECT id, name, description, status, is_fallback_default, owner_account_id, created_at, updated_at
      FROM projects
      WHERE owner_account_id = $1
        AND is_fallback_default = TRUE
      LIMIT 1
    `,
    [ownerAccountId]
  );

  return result.rows[0];
}

async function ensureFallbackDefaultProject(ownerAccountId: string): Promise<ProjectRow> {
  const existing = await readFallbackDefaultProject(ownerAccountId);
  if (existing) {
    return existing;
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const id = randomUUID();
  try {
    await pool.query(
      `
        INSERT INTO projects (
          id,
          name,
          description,
          status,
          is_fallback_default,
          owner_account_id
        )
        VALUES ($1, $2, $3, 'active', TRUE, $4)
      `,
      [id, SYSTEM_FALLBACK_PROJECT_NAME, SYSTEM_FALLBACK_PROJECT_DESCRIPTION, ownerAccountId]
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "23505") {
      throw error;
    }
  }

  const resolved = await readFallbackDefaultProject(ownerAccountId);
  if (!resolved) {
    throw new Error("Unable to initialize fallback default project");
  }
  return resolved;
}

async function ensureProjectPreferencesRow(ownerAccountId: string): Promise<void> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  await pool.query(
    `
      INSERT INTO project_user_preferences (owner_account_id, default_project_id)
      VALUES ($1, NULL)
      ON CONFLICT (owner_account_id) DO NOTHING
    `,
    [ownerAccountId]
  );
}

async function readProjectPreferences(ownerAccountId: string): Promise<ProjectPreferenceRow | undefined> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const result = await pool.query<ProjectPreferenceRow>(
    `
      SELECT owner_account_id, default_project_id
      FROM project_user_preferences
      WHERE owner_account_id = $1
      LIMIT 1
    `,
    [ownerAccountId]
  );

  return result.rows[0];
}

async function readProjectRowById(projectId: string, ownerAccountId: string): Promise<ProjectRow | undefined> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const result = await pool.query<ProjectRow>(
    `
      SELECT id, name, description, status, is_fallback_default, owner_account_id, created_at, updated_at
      FROM projects
      WHERE id = $1 AND owner_account_id = $2
      LIMIT 1
    `,
    [projectId, ownerAccountId]
  );

  return result.rows[0];
}

function toDefaultSelection(row: ProjectRow, source: "user" | "fallback"): DefaultProjectSelection {
  const project = toProject(row);
  return {
    project: {
      ...project,
      isUserDefault: true
    },
    source
  };
}

export async function getDefaultProject(ownerAccountId: string): Promise<DefaultProjectSelection> {
  const owner = normalizeOwner(ownerAccountId);
  const fallback = await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);
  const preferences = await readProjectPreferences(owner);
  const selected = preferences?.default_project_id ? await readProjectRowById(preferences.default_project_id, owner) : undefined;

  if (selected) {
    return toDefaultSelection(selected, "user");
  }

  return toDefaultSelection(fallback, "fallback");
}

export async function setDefaultProject(ownerAccountId: string, projectId: string): Promise<DefaultProjectSelection | undefined> {
  const owner = normalizeOwner(ownerAccountId);
  await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);
  const nextProjectId = projectId.trim();
  if (!nextProjectId) {
    return undefined;
  }

  const target = await readProjectRowById(nextProjectId, owner);
  if (!target) {
    return undefined;
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();
  await pool.query(
    `
      UPDATE project_user_preferences
      SET default_project_id = $2, updated_at = NOW()
      WHERE owner_account_id = $1
    `,
    [owner, nextProjectId]
  );

  return getDefaultProject(owner);
}

async function projectExistsForOwner(projectId: string, ownerAccountId: string): Promise<boolean> {
  const owner = normalizeOwner(ownerAccountId);
  const project = await readProjectRowById(projectId, owner);
  return Boolean(project);
}

export async function listProjects(options: ListProjectsOptions | undefined, ownerAccountId: string): Promise<ProjectListResult> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const owner = normalizeOwner(ownerAccountId);
  await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);
  const parsedCursor = parseCursor(options?.cursor);
  const pageSize = clampLimit(options?.limit);
  const query = options?.query?.trim();
  const values: Array<string | number> = [owner];
  let sql = `
    SELECT id, name, description, status, is_fallback_default, owner_account_id, created_at, updated_at
    FROM projects
    WHERE owner_account_id = $1
  `;

  if (options?.status) {
    values.push(options.status);
    sql += ` AND status = $${values.length}`;
  }

  if (query) {
    values.push(`%${query}%`);
    sql += ` AND (name ILIKE $${values.length} OR description ILIKE $${values.length})`;
  }

  if (parsedCursor) {
    values.push(parsedCursor.t, parsedCursor.id);
    sql += ` AND (updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }

  values.push(pageSize + 1);
  sql += ` ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`;

  const result = await pool.query<ProjectRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const next = result.rows.length > pageSize ? result.rows[pageSize - 1] : undefined;
  const defaultSelection = await getDefaultProject(owner);
  const defaultProjectId = defaultSelection.project.id;

  return {
    items: rows.map((row) => {
      const project = toProject(row);
      return {
        ...project,
        isUserDefault: project.id === defaultProjectId
      };
    }),
    nextCursor: next ? toCursor(new Date(next.updated_at).toISOString(), next.id) : undefined
  };
}

export async function searchProjects(query: string, ownerAccountId: string, options?: Omit<ListProjectsOptions, "query">): Promise<ProjectListResult> {
  return listProjects(
    {
      ...options,
      query
    },
    ownerAccountId
  );
}

export async function getProject(id: string, ownerAccountId: string): Promise<Project | undefined> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const owner = normalizeOwner(ownerAccountId);
  await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);
  const result = await pool.query<ProjectRow>(
    `
      SELECT id, name, description, status, is_fallback_default, owner_account_id, created_at, updated_at
      FROM projects
      WHERE id = $1 AND owner_account_id = $2
      LIMIT 1
    `,
    [id, owner]
  );

  if (!result.rows[0]) {
    return undefined;
  }
  const defaultSelection = await getDefaultProject(owner);
  const project = toProject(result.rows[0]);
  return {
    ...project,
    isUserDefault: project.id === defaultSelection.project.id
  };
}

export async function createProject(input: ProjectInput, ownerAccountId: string): Promise<Project> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const owner = normalizeOwner(ownerAccountId);
  await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);
  const id = randomUUID();
  const status = input.status ?? "active";

  const result = await pool.query<ProjectRow>(
    `
      INSERT INTO projects (id, name, description, status, is_fallback_default, owner_account_id)
      VALUES ($1, $2, $3, $4, FALSE, $5)
      RETURNING id, name, description, status, is_fallback_default, owner_account_id, created_at, updated_at
    `,
    [id, input.name.trim(), input.description?.trim() ?? "", status, owner]
  );

  return toProject(result.rows[0]);
}

export async function updateProject(
  id: string,
  updates: Partial<ProjectInput>,
  ownerAccountId: string
): Promise<Project | undefined> {
  const owner = normalizeOwner(ownerAccountId);
  await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);
  const existingRow = await readProjectRowById(id, owner);
  if (!existingRow) {
    return undefined;
  }
  if (existingRow.is_fallback_default) {
    throw new Error("Fallback default project cannot be modified");
  }
  const existing = toProject(existingRow);

  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const result = await pool.query<ProjectRow>(
    `
      UPDATE projects
      SET
        name = $3,
        description = $4,
        status = $5,
        updated_at = NOW()
      WHERE id = $1 AND owner_account_id = $2
      RETURNING id, name, description, status, is_fallback_default, owner_account_id, created_at, updated_at
    `,
    [id, owner, updates.name?.trim() ?? existing.name, updates.description?.trim() ?? existing.description, updates.status ?? existing.status]
  );

  if (!result.rows[0]) {
    return undefined;
  }
  const defaultSelection = await getDefaultProject(owner);
  const project = toProject(result.rows[0]);
  return {
    ...project,
    isUserDefault: project.id === defaultSelection.project.id
  };
}

export async function deleteProject(id: string, ownerAccountId: string): Promise<boolean> {
  const owner = normalizeOwner(ownerAccountId);
  const fallback = await ensureFallbackDefaultProject(owner);
  await ensureProjectPreferencesRow(owner);

  const existingRow = await readProjectRowById(id, owner);
  if (!existingRow) {
    return false;
  }
  if (existingRow.is_fallback_default) {
    throw new Error("Fallback default project cannot be deleted");
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();

  await pool.query("BEGIN");
  try {
    const deleted = await pool.query(
      `
        DELETE FROM projects
        WHERE id = $1
          AND owner_account_id = $2
          AND is_fallback_default = FALSE
      `,
      [id, owner]
    );

    if ((deleted.rowCount ?? 0) === 0) {
      await pool.query("ROLLBACK");
      return false;
    }

    await pool.query(
      `
        UPDATE project_user_preferences
        SET
          default_project_id = CASE WHEN default_project_id = $2 THEN $3 ELSE default_project_id END,
          updated_at = NOW()
        WHERE owner_account_id = $1
      `,
      [owner, id, fallback.id]
    );

    await pool.query("COMMIT");
    return true;
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function listProjectLinks(
  projectId: string,
  ownerAccountId: string,
  options?: ListProjectLinksOptions
): Promise<ProjectLinkListResult | undefined> {
  const exists = await projectExistsForOwner(projectId, ownerAccountId);
  if (!exists) {
    return undefined;
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const parsedCursor = parseCursor(options?.cursor);
  const pageSize = clampLimit(options?.limit);
  const values: Array<string | number> = [projectId];
  let sql = `
    SELECT id, project_id, target_service, target_resource_type, target_resource_id, relation_type,
           title_snapshot, summary_snapshot, linked_at, metadata_json
    FROM project_links
    WHERE project_id = $1 AND is_deleted = FALSE
  `;

  if (options?.targetService) {
    values.push(options.targetService);
    sql += ` AND target_service = $${values.length}`;
  }

  if (options?.targetResourceType) {
    values.push(options.targetResourceType);
    sql += ` AND target_resource_type = $${values.length}`;
  }

  if (parsedCursor) {
    values.push(parsedCursor.t, parsedCursor.id);
    sql += ` AND (linked_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`;
  }

  values.push(pageSize + 1);
  sql += ` ORDER BY linked_at DESC, id DESC LIMIT $${values.length}`;

  const result = await pool.query<ProjectLinkRow>(sql, values);
  const rows = result.rows.slice(0, pageSize);
  const next = result.rows.length > pageSize ? result.rows[pageSize - 1] : undefined;

  return {
    items: rows.map(toProjectLink),
    nextCursor: next ? toCursor(new Date(next.linked_at).toISOString(), next.id) : undefined
  };
}

export async function linkResourceToProject(
  projectId: string,
  input: ProjectLinkInput,
  ownerAccountId: string
): Promise<ProjectLink | undefined> {
  const exists = await projectExistsForOwner(projectId, ownerAccountId);
  if (!exists) {
    return undefined;
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const linkId = randomUUID();
  const metadata = input.metadataJson ?? {};
  const relationType = (input.relationType ?? "reference").trim() || "reference";

  const result = await pool.query<ProjectLinkRow>(
    `
      INSERT INTO project_links (
        id,
        project_id,
        target_service,
        target_resource_type,
        target_resource_id,
        relation_type,
        title_snapshot,
        summary_snapshot,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (project_id, target_service, target_resource_type, target_resource_id, relation_type)
      WHERE is_deleted = FALSE
      DO UPDATE SET
        title_snapshot = EXCLUDED.title_snapshot,
        summary_snapshot = EXCLUDED.summary_snapshot,
        metadata_json = EXCLUDED.metadata_json,
        linked_at = NOW(),
        is_deleted = FALSE
      RETURNING id, project_id, target_service, target_resource_type, target_resource_id, relation_type,
                title_snapshot, summary_snapshot, linked_at, metadata_json
    `,
    [
      linkId,
      projectId,
      input.targetService.trim(),
      input.targetResourceType.trim(),
      input.targetResourceId.trim(),
      relationType,
      input.titleSnapshot?.trim() || null,
      input.summarySnapshot?.trim() || null,
      JSON.stringify(metadata)
    ]
  );

  return result.rows[0] ? toProjectLink(result.rows[0]) : undefined;
}

export async function unlinkResourceFromProject(linkId: string, ownerAccountId: string): Promise<boolean> {
  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const owner = normalizeOwner(ownerAccountId);
  const result = await pool.query(
    `
      UPDATE project_links
      SET is_deleted = TRUE
      WHERE id = $1
        AND is_deleted = FALSE
        AND project_id IN (
          SELECT id FROM projects WHERE owner_account_id = $2
        )
    `,
    [linkId, owner]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function getProjectContextSummary(projectId: string, ownerAccountId: string): Promise<ProjectContextSummary | undefined> {
  const exists = await projectExistsForOwner(projectId, ownerAccountId);
  if (!exists) {
    return undefined;
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();
  const result = await pool.query<ProjectContextSummaryRow>(
    `
      SELECT id, project_id, summary_text, source, updated_at
      FROM project_context_summaries
      WHERE project_id = $1
      LIMIT 1
    `,
    [projectId]
  );

  return result.rows[0] ? toProjectContextSummary(result.rows[0]) : undefined;
}

function summarizeByService(rows: CountByServiceRow[]): string {
  if (rows.length === 0) {
    return "none";
  }
  return rows.map((row) => `${row.target_service}:${Number(row.link_count)}`).join(", ");
}

function summarizeByRelation(rows: CountByRelationRow[]): string {
  if (rows.length === 0) {
    return "none";
  }
  return rows.map((row) => `${row.relation_type}:${Number(row.link_count)}`).join(", ");
}

export async function refreshProjectContextSummary(
  projectId: string,
  ownerAccountId: string,
  source = "rule-based"
): Promise<ProjectContextSummary | undefined> {
  const project = await getProject(projectId, ownerAccountId);
  if (!project) {
    return undefined;
  }

  await ensureProjectsSchema();
  const pool = getProjectsPool();

  const totalResult = await pool.query<{ total_links: string }>(
    `
      SELECT COUNT(*)::text AS total_links
      FROM project_links
      WHERE project_id = $1 AND is_deleted = FALSE
    `,
    [projectId]
  );

  const byServiceResult = await pool.query<CountByServiceRow>(
    `
      SELECT target_service, COUNT(*)::text AS link_count
      FROM project_links
      WHERE project_id = $1 AND is_deleted = FALSE
      GROUP BY target_service
      ORDER BY COUNT(*) DESC, target_service ASC
      LIMIT 10
    `,
    [projectId]
  );

  const byRelationResult = await pool.query<CountByRelationRow>(
    `
      SELECT relation_type, COUNT(*)::text AS link_count
      FROM project_links
      WHERE project_id = $1 AND is_deleted = FALSE
      GROUP BY relation_type
      ORDER BY COUNT(*) DESC, relation_type ASC
      LIMIT 10
    `,
    [projectId]
  );

  const latestLinksResult = await pool.query<ProjectLinkRow>(
    `
      SELECT id, project_id, target_service, target_resource_type, target_resource_id, relation_type,
             title_snapshot, summary_snapshot, linked_at, metadata_json
      FROM project_links
      WHERE project_id = $1 AND is_deleted = FALSE
      ORDER BY linked_at DESC
      LIMIT 5
    `,
    [projectId]
  );

  const totalLinks = Number(totalResult.rows[0]?.total_links ?? "0");
  const byService = summarizeByService(byServiceResult.rows);
  const byRelation = summarizeByRelation(byRelationResult.rows);
  const latestRefs =
    latestLinksResult.rows.length > 0
      ? latestLinksResult.rows
          .map((row) => row.title_snapshot || `${row.target_service}:${row.target_resource_type}:${row.target_resource_id}`)
          .join("; ")
      : "no linked resources yet";

  const summaryText = [
    `Project "${project.name}" is ${project.status}.`,
    `Total linked resources: ${totalLinks}.`,
    `Service distribution: ${byService}.`,
    `Relation distribution: ${byRelation}.`,
    `Recent links: ${latestRefs}.`
  ].join(" ");

  const id = randomUUID();
  const result = await pool.query<ProjectContextSummaryRow>(
    `
      INSERT INTO project_context_summaries (id, project_id, summary_text, source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (project_id)
      DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        source = EXCLUDED.source,
        updated_at = NOW()
      RETURNING id, project_id, summary_text, source, updated_at
    `,
    [id, projectId, summaryText, source]
  );

  return toProjectContextSummary(result.rows[0]);
}
