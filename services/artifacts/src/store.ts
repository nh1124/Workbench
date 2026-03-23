import { randomUUID } from "node:crypto";
import { ensureArtifactsSchema, getArtifactsPool } from "./db.js";
import type { Artifact, ArtifactInput, ArtifactProjectSummary } from "./types.js";

type ArtifactRow = {
  id: string;
  owner_username: string;
  name: string;
  type: string;
  description: string;
  project_id: string;
  project_name: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
};

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    url: row.url ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function normalizeOwner(ownerUsername: string): string {
  const normalized = ownerUsername.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Owner username is required");
  }
  return normalized;
}

export async function listArtifacts(projectId: string | undefined, limit: number | undefined, ownerUsername: string): Promise<Artifact[]> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const values: Array<string | number> = [owner];
  let sql = `
    SELECT id, owner_username, name, type, description, project_id, project_name, url, created_at, updated_at
    FROM artifacts
    WHERE owner_username = $1
  `;

  if (projectId) {
    values.push(projectId);
    sql += ` AND project_id = $${values.length}`;
  }

  sql += " ORDER BY updated_at DESC";

  if (typeof limit === "number" && limit > 0) {
    values.push(limit);
    sql += ` LIMIT $${values.length}`;
  }

  const result = await pool.query<ArtifactRow>(sql, values);
  return result.rows.map(toArtifact);
}

export async function getArtifact(id: string, ownerUsername: string): Promise<Artifact | undefined> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<ArtifactRow>(
    `
      SELECT id, owner_username, name, type, description, project_id, project_name, url, created_at, updated_at
      FROM artifacts
      WHERE id = $1 AND owner_username = $2
      LIMIT 1
    `,
    [id, owner]
  );

  return result.rows[0] ? toArtifact(result.rows[0]) : undefined;
}

export async function createArtifact(input: ArtifactInput, ownerUsername: string): Promise<Artifact> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const id = randomUUID();

  const result = await pool.query<ArtifactRow>(
    `
      INSERT INTO artifacts (id, owner_username, name, type, description, project_id, project_name, url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, owner_username, name, type, description, project_id, project_name, url, created_at, updated_at
    `,
    [id, owner, input.name, input.type, input.description, input.projectId, input.projectName ?? null, input.url ?? null]
  );

  return toArtifact(result.rows[0]);
}

export async function updateArtifact(
  id: string,
  updates: Partial<ArtifactInput>,
  ownerUsername: string
): Promise<Artifact | undefined> {
  const existing = await getArtifact(id, ownerUsername);
  if (!existing) return undefined;

  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<ArtifactRow>(
    `
      UPDATE artifacts
      SET
        name = $3,
        type = $4,
        description = $5,
        project_id = $6,
        project_name = $7,
        url = $8,
        updated_at = NOW()
      WHERE id = $1 AND owner_username = $2
      RETURNING id, owner_username, name, type, description, project_id, project_name, url, created_at, updated_at
    `,
    [
      id,
      owner,
      updates.name ?? existing.name,
      updates.type ?? existing.type,
      updates.description ?? existing.description,
      updates.projectId ?? existing.projectId,
      updates.projectName ?? existing.projectName ?? null,
      updates.url ?? existing.url ?? null
    ]
  );

  return result.rows[0] ? toArtifact(result.rows[0]) : undefined;
}

export async function deleteArtifact(id: string, ownerUsername: string): Promise<boolean> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query("DELETE FROM artifacts WHERE id = $1 AND owner_username = $2", [id, owner]);
  return (result.rowCount ?? 0) > 0;
}

type ProjectSummaryRow = {
  project_id: string;
  project_name: string | null;
  artifact_count: string;
  latest_updated_at: string;
};

export async function listArtifactProjects(ownerUsername: string): Promise<ArtifactProjectSummary[]> {
  await ensureArtifactsSchema();
  const pool = getArtifactsPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<ProjectSummaryRow>(
    `
      SELECT
        project_id,
        COALESCE(MAX(project_name), project_id) AS project_name,
        COUNT(*)::text AS artifact_count,
        MAX(updated_at) AS latest_updated_at
      FROM artifacts
      WHERE owner_username = $1
      GROUP BY project_id
      ORDER BY MAX(updated_at) DESC
    `,
    [owner]
  );

  return result.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    artifactCount: Number(row.artifact_count),
    latestUpdatedAt: new Date(row.latest_updated_at).toISOString()
  }));
}
