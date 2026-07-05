import { randomUUID } from "node:crypto";
import { ensureNotesSchema, getNotesPool } from "./db.js";
import type { Note, NoteInput, NoteLifecycleState, NoteProjectSummary, NoteReviewReason } from "./types.js";

export interface NoteListPage {
  items: Note[];
  nextCursor?: string;
}

type NoteRow = {
  id: string;
  owner_username: string;
  title: string;
  content: string;
  project_id: string;
  project_name: string | null;
  tags: unknown;
  lifecycle_state: NoteLifecycleState;
  review_after: string | null;
  last_confirmed_at: string | null;
  review_reason: NoteReviewReason | null;
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
    lifecycleState: row.lifecycle_state,
    reviewAfter: row.review_after ? new Date(row.review_after).toISOString() : null,
    lastConfirmedAt: row.last_confirmed_at ? new Date(row.last_confirmed_at).toISOString() : null,
    reviewReason: row.review_reason,
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

function encodeCursor(note: Note): string {
  return Buffer.from(JSON.stringify({ updatedAt: note.updatedAt, id: note.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!cursor?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<{
      updatedAt: unknown;
      id: unknown;
    }>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") {
      return undefined;
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 500);
}

const NOTE_RETURNING = `
  id, owner_username, title, content, project_id, project_name, tags,
  lifecycle_state, review_after, last_confirmed_at, review_reason, created_at, updated_at
`;

export async function listNotes(projectId: string | undefined, limit: number | undefined, ownerUsername: string): Promise<Note[]> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const values: Array<string | number> = [owner];
  let sql = `
    SELECT id, owner_username, title, content, project_id, project_name, tags,
           lifecycle_state, review_after, last_confirmed_at, review_reason, created_at, updated_at
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

export async function listNotesPage(
  projectId: string | undefined,
  limit: number | undefined,
  cursor: string | undefined,
  ownerUsername: string
): Promise<NoteListPage> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const pageSize = normalizeLimit(limit, 100);
  const values: Array<string | number> = [owner];
  let sql = `
    SELECT id, owner_username, title, content, project_id, project_name, tags,
           lifecycle_state, review_after, last_confirmed_at, review_reason, created_at, updated_at
    FROM notes
    WHERE owner_username = $1
  `;

  if (projectId) {
    values.push(projectId);
    sql += ` AND project_id = $${values.length}`;
  }

  const decodedCursor = decodeCursor(cursor);
  if (decodedCursor) {
    values.push(decodedCursor.updatedAt, decodedCursor.id);
    const updatedAtIndex = values.length - 1;
    const idIndex = values.length;
    sql += ` AND (updated_at < $${updatedAtIndex}::timestamptz OR (updated_at = $${updatedAtIndex}::timestamptz AND id::text < $${idIndex}))`;
  }

  values.push(pageSize + 1);
  sql += ` ORDER BY updated_at DESC, id::text DESC LIMIT $${values.length}`;

  const result = await pool.query<NoteRow>(sql, values);
  const notes = result.rows.map(toNote);
  const items = notes.slice(0, pageSize);
  const hasMore = notes.length > pageSize;
  return {
    items,
    nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : undefined
  };
}

export async function getNote(id: string, ownerUsername: string): Promise<Note | undefined> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<NoteRow>(
    `
      SELECT id, owner_username, title, content, project_id, project_name, tags,
             lifecycle_state, review_after, last_confirmed_at, review_reason, created_at, updated_at
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

export async function confirmNote(
  id: string,
  input: { lifecycleState?: Extract<NoteLifecycleState, "curated" | "verified">; reviewAfter?: string | null },
  ownerUsername: string
): Promise<Note | undefined> {
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
      SET lifecycle_state = $3,
          last_confirmed_at = NOW(),
          review_reason = NULL,
          review_after = $4::timestamptz,
          updated_at = NOW()
      WHERE id = $1 AND owner_username = $2
      RETURNING ${NOTE_RETURNING}
    `,
    [id, owner, input.lifecycleState ?? "curated", input.reviewAfter ?? null]
  );

  return result.rows[0] ? toNote(result.rows[0]) : undefined;
}

export async function snoozeNote(id: string, until: string, ownerUsername: string): Promise<Note | undefined> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<NoteRow>(
    `
      UPDATE notes
      SET review_after = $3::timestamptz,
          updated_at = NOW()
      WHERE id = $1 AND owner_username = $2
      RETURNING ${NOTE_RETURNING}
    `,
    [id, owner, until]
  );

  return result.rows[0] ? toNote(result.rows[0]) : undefined;
}

export async function flagNote(id: string, reason: NoteReviewReason, ownerUsername: string): Promise<Note | undefined> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const result = await pool.query<NoteRow>(
    `
      UPDATE notes
      SET review_reason = $3,
          updated_at = NOW()
      WHERE id = $1 AND owner_username = $2
      RETURNING ${NOTE_RETURNING}
    `,
    [id, owner, reason]
  );

  return result.rows[0] ? toNote(result.rows[0]) : undefined;
}

export async function createNote(input: NoteInput, ownerUsername: string): Promise<Note> {
  await ensureNotesSchema();
  const pool = getNotesPool();
  const owner = normalizeOwner(ownerUsername);
  const id = randomUUID();

  const result = await pool.query<NoteRow>(
    `
      INSERT INTO notes (
        id, owner_username, title, content, project_id, project_name, tags,
        lifecycle_state, review_after, review_reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamptz, $10)
      RETURNING id, owner_username, title, content, project_id, project_name, tags,
                lifecycle_state, review_after, last_confirmed_at, review_reason, created_at, updated_at
    `,
    [
      id,
      owner,
      input.title,
      input.content,
      input.projectId,
      input.projectName ?? null,
      JSON.stringify(input.tags ?? []),
      input.lifecycleState ?? "triaged",
      input.reviewAfter ?? null,
      input.reviewReason ?? null
    ]
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
        lifecycle_state = $8,
        review_after = $9::timestamptz,
        review_reason = $10,
        updated_at = NOW()
      WHERE id = $1 AND owner_username = $2
      RETURNING id, owner_username, title, content, project_id, project_name, tags,
                lifecycle_state, review_after, last_confirmed_at, review_reason, created_at, updated_at
    `,
    [
      id,
      owner,
      updates.title ?? existing.title,
      updates.content ?? existing.content,
      updates.projectId ?? existing.projectId,
      updates.projectName ?? existing.projectName ?? null,
      JSON.stringify(updates.tags ?? existing.tags),
      updates.lifecycleState ?? existing.lifecycleState ?? "triaged",
      Object.hasOwn(updates, "reviewAfter") ? updates.reviewAfter ?? null : existing.reviewAfter ?? null,
      Object.hasOwn(updates, "reviewReason") ? updates.reviewReason ?? null : existing.reviewReason ?? null
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
