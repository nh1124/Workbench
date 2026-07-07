import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { clampLimit, iso, normalizeOwner, parseCursor, toCursor } from "./projectStoreUtils.js";
import type {
  MaintenanceQueueItem,
  MaintenanceQueueListResult,
  MaintenanceQueueReason,
  ProjectMemoryAuthority,
  ProjectMemoryLifecycleState
} from "./types.js";

type QueueOptions = {
  projectId?: string;
  reason?: MaintenanceQueueReason;
  limit?: number;
  cursor?: string;
};

type QueueRow = {
  resource_id: string;
  project_id: string;
  project_name: string;
  title_text: string | null;
  excerpt_text: string | null;
  authority: ProjectMemoryAuthority | null;
  lifecycle_state: ProjectMemoryLifecycleState | null;
  review_after: string | null;
  last_confirmed_at: string | null;
  updated_at: string;
  reasons: MaintenanceQueueReason[];
};

type CountRow = {
  reason: MaintenanceQueueReason;
  count: string;
};

const TITLE_MAX_CHARS = 100;
const EXCERPT_MAX_CHARS = 200;

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function truncateText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function firstLine(value: string | null): string {
  return value?.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function totalsByReason(rows: CountRow[]): Partial<Record<MaintenanceQueueReason, number>> {
  return Object.fromEntries(rows.map((row) => [row.reason, Number(row.count)])) as Partial<Record<MaintenanceQueueReason, number>>;
}

function memoryItem(row: QueueRow): MaintenanceQueueItem {
  const body = row.excerpt_text ?? "";
  return {
    id: `memory:${row.resource_id}`,
    kind: "memory",
    projectId: row.project_id,
    projectName: row.project_name,
    resourceId: row.resource_id,
    title: truncateText(firstLine(row.title_text) || "Untitled memory", TITLE_MAX_CHARS),
    excerpt: truncateText(body, EXCERPT_MAX_CHARS),
    reasons: row.reasons,
    authority: row.authority ?? undefined,
    lifecycleState: row.lifecycle_state ?? undefined,
    lastConfirmedAt: row.last_confirmed_at ? iso(row.last_confirmed_at) : null,
    reviewAfter: row.review_after ? iso(row.review_after) : null,
    updatedAt: iso(row.updated_at),
    suggestedActions: ["confirm", "supersede", "archive"]
  };
}

function briefItem(row: QueueRow): MaintenanceQueueItem {
  const suggestedActions = new Set<string>();
  if (row.reasons.includes("brief_unmaintained")) suggestedActions.add("update_brief");
  if (row.reasons.includes("brief_oversized")) suggestedActions.add("slim_brief");
  return {
    id: `brief:${row.resource_id}`,
    kind: "brief",
    projectId: row.project_id,
    projectName: row.project_name,
    resourceId: row.resource_id,
    title: truncateText(row.project_name, TITLE_MAX_CHARS),
    excerpt: truncateText(row.excerpt_text ?? "", EXCERPT_MAX_CHARS),
    reasons: row.reasons,
    updatedAt: iso(row.updated_at),
    suggestedActions: [...suggestedActions]
  };
}

function indexDriftItem(row: QueueRow): MaintenanceQueueItem {
  const suggestedActions = new Set<string>();
  if (row.reasons.includes("source_changed")) suggestedActions.add("rebuild_index");
  if (row.reasons.includes("unused")) suggestedActions.add("review_relevance");
  return {
    id: `index_drift:${row.resource_id}`,
    kind: "index_drift",
    projectId: row.project_id,
    projectName: row.project_name,
    resourceId: row.resource_id,
    title: truncateText(row.title_text || "Untitled index entry", TITLE_MAX_CHARS),
    excerpt: truncateText(row.excerpt_text ?? "", EXCERPT_MAX_CHARS),
    reasons: row.reasons,
    updatedAt: iso(row.updated_at),
    suggestedActions: [...suggestedActions]
  };
}

async function queryQueue(
  cteSql: string,
  baseValues: Array<string | number>,
  options: QueueOptions | undefined,
  toItem: (row: QueueRow) => MaintenanceQueueItem
): Promise<MaintenanceQueueListResult> {
  const pageSize = clampLimit(options?.limit, 20, 100);
  const cursor = parseCursor(options?.cursor);
  const totalsResult = await getProjectsPool().query<CountRow>(
    `
      ${cteSql}
      SELECT reason.reason, COUNT(*)::text AS count
      FROM filtered
      CROSS JOIN LATERAL unnest(reasons) AS reason(reason)
      GROUP BY reason.reason
      ORDER BY reason.reason ASC
    `,
    baseValues
  );

  const itemValues = [...baseValues];
  let cursorWhere = "";
  if (cursor) {
    itemValues.push(cursor.t, cursor.id);
    cursorWhere = `WHERE (updated_at, resource_id) < ($${itemValues.length - 1}::timestamptz, $${itemValues.length})`;
  }
  itemValues.push(pageSize + 1);
  const itemsResult = await getProjectsPool().query<QueueRow>(
    `
      ${cteSql}
      SELECT resource_id, project_id, project_name, title_text, excerpt_text, authority,
             lifecycle_state, review_after, last_confirmed_at, updated_at, reasons
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
    items: rows.map(toItem),
    nextCursor: itemsResult.rows.length > pageSize && last ? toCursor(last.updated_at, last.resource_id) : undefined,
    totals: { byReason: totalsByReason(totalsResult.rows) }
  };
}

export async function listMemoryMaintenanceQueue(
  ownerAccountId: string,
  options?: QueueOptions
): Promise<MaintenanceQueueListResult> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const unconfirmedDays = positiveEnvInt("WORKBENCH_MAINTENANCE_UNCONFIRMED_DAYS", 30);
  const values: Array<string | number> = [owner, unconfirmedDays];
  let projectFilter = "";
  if (options?.projectId) {
    values.push(options.projectId);
    projectFilter = `AND p.id = $${values.length}`;
  }
  let reasonFilter = "";
  if (options?.reason) {
    values.push(options.reason);
    reasonFilter = `AND $${values.length} = ANY(reasons)`;
  }
  const cteSql = `
    WITH queue AS (
      SELECT
        m.id AS resource_id,
        p.id AS project_id,
        p.name AS project_name,
        m.body_markdown AS title_text,
        m.body_markdown AS excerpt_text,
        m.authority,
        m.lifecycle_state,
        m.review_after,
        m.last_confirmed_at,
        m.updated_at,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN m.lifecycle_state = 'raw' THEN 'raw'::text END,
          CASE WHEN m.review_after IS NOT NULL AND m.review_after < NOW() THEN 'expired'::text END,
          CASE
            WHEN m.authority = 'agent_observed'
             AND m.last_confirmed_at IS NULL
             AND m.created_at < NOW() - ($2::int * INTERVAL '1 day')
            THEN 'unconfirmed'::text
          END,
          CASE WHEN m.review_reason = 'conflict' THEN 'conflict'::text END,
          CASE WHEN m.review_reason = 'manual' THEN 'manual'::text END
        ], NULL)::text[] AS reasons
      FROM project_memory_entries m
      JOIN projects p ON p.id = m.project_id
      WHERE p.owner_account_id = $1
        AND p.status = 'active'
        AND m.status = 'active'
        ${projectFilter}
    ),
    filtered AS (
      SELECT *
      FROM queue
      WHERE cardinality(reasons) > 0
        ${reasonFilter}
    )
  `;
  return queryQueue(cteSql, values, options, memoryItem);
}

export async function listBriefMaintenanceQueue(
  ownerAccountId: string,
  options?: QueueOptions
): Promise<MaintenanceQueueListResult> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const minChars = positiveEnvInt("WORKBENCH_MAINTENANCE_BRIEF_MIN_CHARS", 80);
  const maxChars = positiveEnvInt("WORKBENCH_MAINTENANCE_BRIEF_MAX_CHARS", 2000);
  const values: Array<string | number> = [owner, minChars, maxChars];
  let projectFilter = "";
  if (options?.projectId) {
    values.push(options.projectId);
    projectFilter = `AND p.id = $${values.length}`;
  }
  let reasonFilter = "";
  if (options?.reason) {
    values.push(options.reason);
    reasonFilter = `AND $${values.length} = ANY(reasons)`;
  }
  const cteSql = `
    WITH queue AS (
      SELECT
        p.id AS resource_id,
        p.id AS project_id,
        p.name AS project_name,
        p.name AS title_text,
        COALESCE(b.content_markdown, '') AS excerpt_text,
        NULL::text AS authority,
        NULL::text AS lifecycle_state,
        NULL::timestamptz AS review_after,
        NULL::timestamptz AS last_confirmed_at,
        COALESCE(b.updated_at, p.updated_at) AS updated_at,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN char_length(trim(COALESCE(b.content_markdown, ''))) < $2 THEN 'brief_unmaintained'::text END,
          CASE WHEN char_length(trim(COALESCE(b.content_markdown, ''))) > $3 THEN 'brief_oversized'::text END
        ], NULL)::text[] AS reasons
      FROM projects p
      LEFT JOIN project_briefs b ON b.project_id = p.id
      WHERE p.owner_account_id = $1
        AND p.status = 'active'
        ${projectFilter}
    ),
    filtered AS (
      SELECT *
      FROM queue
      WHERE cardinality(reasons) > 0
        ${reasonFilter}
    )
  `;
  return queryQueue(cteSql, values, options, briefItem);
}

export async function listIndexDriftMaintenanceQueue(
  ownerAccountId: string,
  options?: QueueOptions
): Promise<MaintenanceQueueListResult> {
  await ensureProjectsSchema();
  const owner = normalizeOwner(ownerAccountId);
  const unusedDays = positiveEnvInt("WORKBENCH_MAINTENANCE_UNUSED_DAYS", 90);
  const values: Array<string | number> = [owner, unusedDays];
  let projectFilter = "";
  if (options?.projectId) {
    values.push(options.projectId);
    projectFilter = `AND p.id = $${values.length}`;
  }
  let reasonFilter = "";
  if (options?.reason) {
    values.push(options.reason);
    reasonFilter = `AND $${values.length} = ANY(reasons)`;
  }
  const cteSql = `
    WITH queue AS (
      SELECT
        i.id AS resource_id,
        p.id AS project_id,
        p.name AS project_name,
        i.title AS title_text,
        i.summary_text AS excerpt_text,
        NULL::text AS authority,
        NULL::text AS lifecycle_state,
        NULL::timestamptz AS review_after,
        NULL::timestamptz AS last_confirmed_at,
        GREATEST(i.source_updated_at, i.indexed_at) AS updated_at,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN i.source_updated_at > i.indexed_at THEN 'source_changed'::text END,
          CASE
            WHEN i.indexed_at < NOW() - ($2::int * INTERVAL '1 day')
             AND (i.last_read_at IS NULL OR i.last_read_at < NOW() - ($2::int * INTERVAL '1 day'))
            THEN 'unused'::text
          END
        ], NULL)::text[] AS reasons
      FROM project_index_entries i
      JOIN projects p ON p.id = i.project_id
      WHERE p.owner_account_id = $1
        AND p.status = 'active'
        AND i.is_deleted = FALSE
        ${projectFilter}
    ),
    filtered AS (
      SELECT *
      FROM queue
      WHERE cardinality(reasons) > 0
        ${reasonFilter}
    )
  `;
  return queryQueue(cteSql, values, options, indexDriftItem);
}
