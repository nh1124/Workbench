import { ensureNotesSchema, getNotesPool } from "./db.js";
import type {
  NoteLifecycleState,
  NoteMaintenanceQueueItem,
  NoteMaintenanceQueueListResult,
  NoteMaintenanceQueueReason
} from "./types.js";

type QueueOptions = {
  projectId?: string;
  reason?: NoteMaintenanceQueueReason;
  limit?: number;
  cursor?: string;
};

type QueueCursor = {
  t: string;
  id: string;
};

type QueueRow = {
  resource_id: string;
  project_id: string;
  project_name: string | null;
  title: string;
  content: string;
  lifecycle_state: NoteLifecycleState | null;
  review_after: string | null;
  last_confirmed_at: string | null;
  updated_at: string;
  reasons: NoteMaintenanceQueueReason[];
};

type CountRow = {
  reason: NoteMaintenanceQueueReason;
  count: string;
};

export class InvalidNoteQueueCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidNoteQueueCursorError";
  }
}

const TITLE_MAX_CHARS = 100;
const EXCERPT_MAX_CHARS = 200;

function normalizeOwner(ownerUsername: string): string {
  const normalized = ownerUsername.trim().toLowerCase();
  if (!normalized) throw new Error("Owner username is required");
  return normalized;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 100);
}

function parseCursor(cursor: string | undefined): QueueCursor | undefined {
  if (!cursor) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidNoteQueueCursorError();
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new InvalidNoteQueueCursorError();
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<QueueCursor> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidNoteQueueCursorError();
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") throw new InvalidNoteQueueCursorError();
    if (!Number.isFinite(Date.parse(parsed.t))) throw new InvalidNoteQueueCursorError();
    if (new Date(parsed.t).toISOString() !== parsed.t) throw new InvalidNoteQueueCursorError();
    return { t: parsed.t, id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidNoteQueueCursorError) throw error;
    throw new InvalidNoteQueueCursorError();
  }
}

function toCursor(timestamp: string | Date, id: string): string {
  const t = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
  return Buffer.from(JSON.stringify({ t, id }), "utf8").toString("base64url");
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function totalsByReason(rows: CountRow[]): Partial<Record<NoteMaintenanceQueueReason, number>> {
  return Object.fromEntries(rows.map((row) => [row.reason, Number(row.count)])) as Partial<Record<NoteMaintenanceQueueReason, number>>;
}

function toQueueItem(row: QueueRow): NoteMaintenanceQueueItem {
  return {
    id: `note:${row.resource_id}`,
    kind: "note",
    projectId: row.project_id,
    projectName: row.project_name ?? row.project_id,
    resourceId: row.resource_id,
    title: truncateText(row.title || "Untitled note", TITLE_MAX_CHARS),
    excerpt: truncateText(row.content, EXCERPT_MAX_CHARS),
    reasons: row.reasons,
    lifecycleState: row.lifecycle_state ?? undefined,
    lastConfirmedAt: row.last_confirmed_at ? iso(row.last_confirmed_at) : null,
    reviewAfter: row.review_after ? iso(row.review_after) : null,
    updatedAt: iso(row.updated_at),
    suggestedActions: ["confirm", "edit", "delete"]
  };
}

export async function listNoteMaintenanceQueue(
  ownerUsername: string,
  options?: QueueOptions
): Promise<NoteMaintenanceQueueListResult> {
  await ensureNotesSchema();
  const owner = normalizeOwner(ownerUsername);
  const values: Array<string | number> = [owner];
  let projectFilter = "";
  if (options?.projectId) {
    values.push(options.projectId);
    projectFilter = `AND project_id = $${values.length}`;
  }
  let reasonFilter = "";
  if (options?.reason) {
    values.push(options.reason);
    reasonFilter = `AND $${values.length} = ANY(reasons)`;
  }
  const cteSql = `
    WITH queue AS (
      SELECT
        id AS resource_id,
        project_id,
        project_name,
        title,
        content,
        lifecycle_state,
        review_after,
        last_confirmed_at,
        updated_at,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN lifecycle_state = 'raw' THEN 'raw'::text END,
          CASE WHEN review_after IS NOT NULL AND review_after < NOW() THEN 'expired'::text END,
          CASE WHEN review_reason = 'conflict' THEN 'conflict'::text END,
          CASE WHEN review_reason = 'manual' THEN 'manual'::text END
        ], NULL)::text[] AS reasons
      FROM notes
      WHERE owner_username = $1
        ${projectFilter}
    ),
    filtered AS (
      SELECT *
      FROM queue
      WHERE cardinality(reasons) > 0
        ${reasonFilter}
    )
  `;

  const totalsResult = await getNotesPool().query<CountRow>(
    `
      ${cteSql}
      SELECT reason.reason, COUNT(*)::text AS count
      FROM filtered
      CROSS JOIN LATERAL unnest(reasons) AS reason(reason)
      GROUP BY reason.reason
      ORDER BY reason.reason ASC
    `,
    values
  );

  const pageSize = normalizeLimit(options?.limit, 20);
  const cursor = parseCursor(options?.cursor);
  const itemValues = [...values];
  let cursorWhere = "";
  if (cursor) {
    itemValues.push(cursor.t, cursor.id);
    cursorWhere = `WHERE (updated_at, resource_id) < ($${itemValues.length - 1}::timestamptz, $${itemValues.length})`;
  }
  itemValues.push(pageSize + 1);
  const itemsResult = await getNotesPool().query<QueueRow>(
    `
      ${cteSql}
      SELECT resource_id, project_id, project_name, title, content, lifecycle_state,
             review_after, last_confirmed_at, updated_at, reasons
      FROM filtered
      ${cursorWhere}
      ORDER BY updated_at DESC, resource_id DESC
      LIMIT $${itemValues.length}
    `,
    itemValues
  );

  const rows = itemsResult.rows.slice(0, pageSize);
  const last = rows.at(-1);
  return {
    items: rows.map(toQueueItem),
    nextCursor: itemsResult.rows.length > pageSize && last ? toCursor(last.updated_at, last.resource_id) : undefined,
    totals: { byReason: totalsByReason(totalsResult.rows) }
  };
}
