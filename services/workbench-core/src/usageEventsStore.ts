import { ensureCoreSchema, getCorePool } from "./db.js";

export const USAGE_EVENT_TYPES = ["context_truncation", "index_search", "resource_read"] as const;
export type UsageEventType = (typeof USAGE_EVENT_TYPES)[number];

export type UsageEventInput = {
  userId: string;
  eventType: UsageEventType;
  projectId?: string | null;
  sourceService?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  queryText?: string | null;
  hitCount?: number | null;
  metadataJson?: Record<string, unknown>;
};

export type UsageSummary = {
  since: string;
  until: string;
  truncation: {
    count: number;
    bySection: Array<{ section: string; count: number }>;
  };
  zeroHitQueries: Array<{ queryText: string; count: number }>;
  topResources: Array<{
    sourceService: string;
    resourceType: string;
    resourceId: string;
    count: number;
  }>;
};

type Queryable = {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

type CountRow = { count: string | number };
type SectionCountRow = { section: string; count: string | number };
type QueryCountRow = { query_text: string; count: string | number };
type ResourceCountRow = {
  source_service: string;
  resource_type: string;
  resource_id: string;
  count: string | number;
};

const DEFAULT_USAGE_WINDOW_DAYS = 30;
const TOP_LIMIT = 20;

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeDate(value: string | Date | null | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid usage summary date");
  }
  return date;
}

function usageWindow(since?: string | Date, until?: string | Date): { since: Date; until: Date } {
  const normalizedUntil = normalizeDate(until) ?? new Date();
  const normalizedSince = normalizeDate(since) ?? new Date(normalizedUntil.getTime() - DEFAULT_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (normalizedSince.getTime() > normalizedUntil.getTime()) {
    throw new Error("Usage summary since must be before until");
  }
  return { since: normalizedSince, until: normalizedUntil };
}

function numberCount(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  await ensureCoreSchema();
  await getCorePool().query(
    `
      INSERT INTO usage_events (
        user_id, event_type, project_id, source_service, resource_type, resource_id,
        query_text, hit_count, metadata_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `,
    [
      input.userId,
      input.eventType,
      normalizeOptionalText(input.projectId ?? null),
      normalizeOptionalText(input.sourceService ?? null),
      normalizeOptionalText(input.resourceType ?? null),
      normalizeOptionalText(input.resourceId ?? null),
      normalizeOptionalText(input.queryText ?? null),
      Number.isFinite(input.hitCount) ? Math.max(0, Math.floor(Number(input.hitCount))) : null,
      JSON.stringify(input.metadataJson ?? {})
    ]
  );
}

export function recordUsageEventBestEffort(
  input: UsageEventInput,
  recorder: (event: UsageEventInput) => Promise<void> = recordUsageEvent
): void {
  void recorder(input).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[usage] failed to record event", { eventType: input.eventType, message });
  });
}

export async function summarizeUsageWithPool(
  pool: Queryable,
  userId: string,
  since?: string | Date,
  until?: string | Date
): Promise<UsageSummary> {
  const window = usageWindow(since, until);
  const values = [userId, window.since.toISOString(), window.until.toISOString(), TOP_LIMIT];
  const rangeWhere = "user_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz";

  const [truncationCount, sections, zeroHits, resources] = await Promise.all([
    pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count FROM usage_events WHERE ${rangeWhere} AND event_type = 'context_truncation'`,
      values.slice(0, 3)
    ),
    pool.query<SectionCountRow>(
      `
        SELECT section, COUNT(*)::text AS count
        FROM usage_events
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(metadata_json->'sections') = 'array'
            THEN metadata_json->'sections'
            ELSE '[]'::jsonb
          END
        ) AS sections(section)
        WHERE ${rangeWhere}
          AND event_type = 'context_truncation'
        GROUP BY section
        ORDER BY COUNT(*) DESC, section ASC
        LIMIT $4
      `,
      values
    ),
    pool.query<QueryCountRow>(
      `
        SELECT query_text, COUNT(*)::text AS count
        FROM usage_events
        WHERE ${rangeWhere}
          AND event_type = 'index_search'
          AND hit_count = 0
          AND query_text IS NOT NULL
          AND btrim(query_text) <> ''
        GROUP BY query_text
        ORDER BY COUNT(*) DESC, query_text ASC
        LIMIT $4
      `,
      values
    ),
    pool.query<ResourceCountRow>(
      `
        SELECT source_service, resource_type, resource_id, COUNT(*)::text AS count
        FROM usage_events
        WHERE ${rangeWhere}
          AND event_type = 'resource_read'
          AND source_service IS NOT NULL
          AND resource_type IS NOT NULL
          AND resource_id IS NOT NULL
        GROUP BY source_service, resource_type, resource_id
        ORDER BY COUNT(*) DESC, source_service ASC, resource_type ASC, resource_id ASC
        LIMIT $4
      `,
      values
    )
  ]);

  return {
    since: window.since.toISOString(),
    until: window.until.toISOString(),
    truncation: {
      count: numberCount(truncationCount.rows[0]?.count ?? 0),
      bySection: sections.rows.map((row) => ({ section: row.section, count: numberCount(row.count) }))
    },
    zeroHitQueries: zeroHits.rows.map((row) => ({ queryText: row.query_text, count: numberCount(row.count) })),
    topResources: resources.rows.map((row) => ({
      sourceService: row.source_service,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      count: numberCount(row.count)
    }))
  };
}

export async function summarizeUsage(userId: string, since?: string | Date, until?: string | Date): Promise<UsageSummary> {
  await ensureCoreSchema();
  return summarizeUsageWithPool(getCorePool(), userId, since, until);
}
