import { randomUUID } from "node:crypto";
import { ensureNotesSchema, getNotesPool } from "./db.js";
import type { Note, NoteInput, NoteProjectSummary } from "./types.js";

type NoteRow = {
  id: string;
  owner_username: string;
  title: string;
  content: string;
  project_id: string;
  project_name: string | null;
  tags: unknown;
  created_at: string;
  updated_at: string;
};

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
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

export async function listNotes(projectId: string | undefined, limit: number | undefined, ownerUsername: string): Promise<Note[]> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const values: Array<string | number> = [owner];
  let sql = `
    SELECT id, owner_username, title, content, project_id, project_name, tags, created_at, updated_at
    FROM notes
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

  const result = await pool.query<NoteRow>(sql, values);
  return result.rows.map(toNote);
}

export async function getNote(id: string, ownerUsername: string): Promise<Note | undefined> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<NoteRow>(
    `
      SELECT id, owner_username, title, content, project_id, project_name, tags, created_at, updated_at
      FROM notes
      WHERE id = $1 AND owner_username = $2
      LIMIT 1
    `,
    [id, owner]
  );

  if (!result.rows[0]) {
    return undefined;
  }

  return toNote(result.rows[0]);
}

export async function createNote(input: NoteInput, ownerUsername: string): Promise<Note> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const id = randomUUID();

  const result = await pool.query<NoteRow>(
    `
      INSERT INTO notes (id, owner_username, title, content, project_id, project_name, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, owner_username, title, content, project_id, project_name, tags, created_at, updated_at
    `,
    [id, owner, input.title, input.content, input.projectId, input.projectName ?? null, JSON.stringify(input.tags ?? [])]
  );

  return toNote(result.rows[0]);
}

export async function updateNote(id: string, updates: Partial<NoteInput>, ownerUsername: string): Promise<Note | undefined> {
  const existing = await getNote(id, ownerUsername);
  if (!existing) {
    return undefined;
  }

  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<NoteRow>(
    `
      UPDATE notes
      SET
        title = $3,
        content = $4,
        project_id = $5,
        project_name = $6,
        tags = $7::jsonb,
        updated_at = NOW()
      WHERE id = $1 AND owner_username = $2
      RETURNING id, owner_username, title, content, project_id, project_name, tags, created_at, updated_at
    `,
    [
      id,
      owner,
      updates.title ?? existing.title,
      updates.content ?? existing.content,
      updates.projectId ?? existing.projectId,
      updates.projectName ?? existing.projectName ?? null,
      JSON.stringify(updates.tags ?? existing.tags)
    ]
  );

  return result.rows[0] ? toNote(result.rows[0]) : undefined;
}

export async function deleteNote(id: string, ownerUsername: string): Promise<boolean> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query("DELETE FROM notes WHERE id = $1 AND owner_username = $2", [id, owner]);
  return (result.rowCount ?? 0) > 0;
}

type ProjectSummaryRow = {
  project_id: string;
  project_name: string | null;
  note_count: string;
  latest_updated_at: string;
};

export async function listNoteProjects(ownerUsername: string): Promise<NoteProjectSummary[]> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<ProjectSummaryRow>(
    `
      SELECT
        project_id,
        COALESCE(MAX(project_name), project_id) AS project_name,
        COUNT(*)::text AS note_count,
        MAX(updated_at) AS latest_updated_at
      FROM notes
      WHERE owner_username = $1
      GROUP BY project_id
      ORDER BY MAX(updated_at) DESC
    `,
    [owner]
  );

  return result.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name ?? undefined,
    noteCount: Number(row.note_count),
    latestUpdatedAt: new Date(row.latest_updated_at).toISOString()
  }));
}
