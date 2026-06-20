import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { iso, normalizeOwner, VersionConflictError } from "./projectStoreUtils.js";
import type { ProjectBrief, ProjectBriefUpdateInput } from "./types.js";

type BriefRow = {
  project_id: string;
  content_markdown: string | null;
  version: number | null;
  updated_by_kind: "user" | "agent" | null;
  updated_at: string;
};

function toBrief(row: BriefRow): ProjectBrief {
  return {
    projectId: row.project_id,
    contentMarkdown: row.content_markdown ?? "",
    version: row.version ?? 0,
    updatedByKind: row.updated_by_kind ?? "user",
    updatedAt: iso(row.updated_at)
  };
}

export async function getProjectBrief(projectId: string, ownerAccountId: string): Promise<ProjectBrief | undefined> {
  await ensureProjectsSchema();
  const result = await getProjectsPool().query<BriefRow>(
    `
      SELECT p.id AS project_id, b.content_markdown, b.version, b.updated_by_kind,
             COALESCE(b.updated_at, p.created_at) AS updated_at
      FROM projects p
      LEFT JOIN project_briefs b ON b.project_id = p.id
      WHERE p.id = $1 AND p.owner_account_id = $2
      LIMIT 1
    `,
    [projectId, normalizeOwner(ownerAccountId)]
  );
  return result.rows[0] ? toBrief(result.rows[0]) : undefined;
}

export async function updateProjectBrief(
  projectId: string,
  input: ProjectBriefUpdateInput,
  ownerAccountId: string
): Promise<ProjectBrief | undefined> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const pool = getProjectsPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query(`SELECT 1 FROM projects WHERE id = $1 AND owner_account_id = $2 FOR UPDATE`, [projectId, owner]);
    if ((project.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }

    const existing = await client.query<{ version: number }>(
      `SELECT version FROM project_briefs WHERE project_id = $1 FOR UPDATE`,
      [projectId]
    );
    const currentVersion = existing.rows[0]?.version ?? 0;
    if (currentVersion !== input.expectedVersion) {
      await client.query("ROLLBACK");
      throw new VersionConflictError(`Expected brief version ${input.expectedVersion}, current version is ${currentVersion}`);
    }

    const result = await client.query<BriefRow>(
      `
        INSERT INTO project_briefs (project_id, content_markdown, version, updated_by_kind)
        VALUES ($1, $2, 1, $3)
        ON CONFLICT (project_id)
        DO UPDATE SET
          content_markdown = EXCLUDED.content_markdown,
          version = project_briefs.version + 1,
          updated_by_kind = EXCLUDED.updated_by_kind,
          updated_at = NOW()
        RETURNING project_id, content_markdown, version, updated_by_kind, updated_at
      `,
      [projectId, input.contentMarkdown.trim(), input.updatedByKind]
    );
    await client.query("COMMIT");
    return toBrief(result.rows[0]);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}
