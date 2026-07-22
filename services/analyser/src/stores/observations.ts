import { getAnalyserPool } from "../db.js";
import { AnalyserServiceError } from "../serviceError.js";
import {
  observationInputSchema,
  type ActivityAggregate,
  type CollectionSettings,
  type ObservationInput,
  type ObservationRecord,
  type ObservationSource,
  type ResourceRef
} from "../types.js";
import { listKnownMachineIdsWithPool, type AnalyserQueryPool } from "./machines.js";
import { getEffectiveCollectionSettingsWithPool } from "./policies.js";

type ObservationRow = {
  seq: string | number;
  id: string;
  source: ObservationSource;
  action: string;
  actor_kind: ObservationRecord["actorKind"];
  machine_id: string | null;
  project_id: string | null;
  occurred_at: Date | string;
  received_at: Date | string;
  resource_refs: ResourceRef[] | null;
  metadata: Record<string, string | number | boolean | null> | null;
  source_event_id: string | null;
  dedupe_key: string;
  expires_at: Date | string;
};

export interface IngestObservationsResult {
  ingested: number;
  duplicates: number;
  rejected: Record<string, number>;
}

export interface RetentionLogger {
  info?(message: string, details?: unknown): void;
  error?(message: string, details?: unknown): void;
}

// Substring match (not exact) so variants like accessToken, apiKey, sessionCookie,
// x-api-key, privateKey, etc. are stripped too, not just the literal key names.
const SECRET_METADATA_KEY = /token|secret|password|passwd|authoriz|cookie|apikey|api_key|credential|privatekey|private_key/i;
const METADATA_KEY_LIMIT = 20;
const WINDOW_TITLE_METADATA_KEY = /^(windowtitle|window_title)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBSERVATION_METADATA_KEYS = {
  workbench_change: new Set(["domain", "action", "resourceType", "path", "previousPath", "version"]),
  mcp_access: new Set(["tool", "kind", "ok", "durationMs", "errorClass"]),
  ui_access: new Set(["route", "method", "kind", "status", "ok", "durationMs"]),
  pc_activity: new Set(["app", "idle", "intervalSeconds", "windowTitle"]),
  local_file: new Set(["eventType", "root", "relativePath", "mtime", "size"]),
  agent_session: new Set(["event", "milestone", "resourceCount"])
} satisfies Record<ObservationSource, ReadonlySet<string>>;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapObservation(row: ObservationRow): ObservationRecord {
  return {
    seq: String(row.seq),
    id: row.id,
    source: row.source,
    action: row.action,
    actorKind: row.actor_kind,
    ...(row.machine_id ? { machineId: row.machine_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    occurredAt: iso(row.occurred_at),
    resourceRefs: row.resource_refs ?? [],
    metadata: row.metadata ?? {},
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    dedupeKey: row.dedupe_key,
    receivedAt: iso(row.received_at),
    expiresAt: iso(row.expires_at)
  };
}

function isSourceEnabled(source: ObservationSource, settings: CollectionSettings): boolean {
  switch (source) {
    case "workbench_change": return settings.workbenchChanges !== "off";
    case "mcp_access": return settings.mcpAccess !== "off";
    case "ui_access": return settings.uiAccess !== "off";
    case "agent_session": return settings.agentSessionEvents !== "off";
    case "pc_activity": return settings.foregroundAppUpload === true;
    case "local_file": return settings.localFileEvents === "metadata" && settings.localFileUpload === true;
  }
}

function rejectedSource(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { source?: unknown }).source === "string") {
    return (input as { source: string }).source;
  }
  return "unknown";
}

function incrementRejected(rejected: Record<string, number>, source: string): void {
  rejected[source] = (rejected[source] ?? 0) + 1;
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

// True when `path` is `root` itself or lives under it, matching on a path-
// separator boundary so "C:/work" does not match "C:/workshop".
function isUnderRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeFsPath(path);
  const normalizedRoot = normalizeFsPath(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function passesFilters(input: ObservationInput, settings: CollectionSettings): boolean {
  if (input.source === "local_file") {
    const metadata = input.metadata ?? {};
    const root = String(metadata.root ?? "");
    const relativePath = String(metadata.relativePath ?? "");
    if (relativePath.split(/[\\/]/).includes("..")) return false;
    const fullPath = normalizeFsPath(`${root}/${relativePath}`);
    // Deny wins, evaluated against the full path so a denied subdirectory of an
    // allowed root is caught here too (defense in depth; the daemon also filters).
    if (settings.localRootDeny.some((deniedRoot) => isUnderRoot(fullPath, deniedRoot) || isUnderRoot(root, deniedRoot))) return false;
    if (settings.localRootAllow.length === 0
      || !settings.localRootAllow.some((allowedRoot) => isUnderRoot(root, allowedRoot))) return false;
    for (const pattern of settings.excludePatterns) {
      try {
        if (new RegExp(pattern, "i").test(relativePath)) return false;
      } catch {
        // Invalid exclusion patterns are ignored.
      }
    }
  }
  if (input.projectId && settings.projectDeny.includes(input.projectId)) return false;
  if (settings.projectAllow.length > 0 && (!input.projectId || !settings.projectAllow.includes(input.projectId))) return false;
  const resourceTypes = (input.resourceRefs ?? []).map((ref) => ref.resourceType);
  if (resourceTypes.some((resourceType) => settings.resourceTypeDeny.includes(resourceType))) return false;
  if (settings.resourceTypeAllow.length > 0 && resourceTypes.some((resourceType) => !settings.resourceTypeAllow.includes(resourceType))) return false;
  return true;
}

function sanitizeMetadata(
  metadata: ObservationInput["metadata"],
  source: ObservationSource,
  options: { stripWindowTitle: boolean }
): Record<string, string | number | boolean | null> {
  const sanitized: Record<string, string | number | boolean | null> = {};
  const allowedKeys = (OBSERVATION_METADATA_KEYS as Partial<Record<ObservationSource, ReadonlySet<string>>>)[source];
  if (!allowedKeys) return sanitized;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (Object.keys(sanitized).length >= METADATA_KEY_LIMIT) break;
    if (!allowedKeys.has(key)) continue;
    if (SECRET_METADATA_KEY.test(key)) continue;
    if (options.stripWindowTitle && WINDOW_TITLE_METADATA_KEY.test(key)) continue;
    sanitized[key] = typeof value === "string" ? value.slice(0, 2000) : value;
  }
  return sanitized;
}

function expiresAt(occurredAt: string, retentionDays: number): string {
  return new Date(new Date(occurredAt).getTime() + retentionDays * 86_400_000).toISOString();
}

export async function ingestObservations(
  owner: string,
  inputs: ObservationInput[],
  options: { machineId?: string } = {}
): Promise<IngestObservationsResult> {
  return ingestObservationsWithPool(getAnalyserPool(), owner, inputs, options);
}

export async function ingestObservationsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  inputs: ObservationInput[],
  options: { machineId?: string } = {}
): Promise<IngestObservationsResult> {
  const rawMachineIds = new Set<string>();
  if (options.machineId && UUID.test(options.machineId)) rawMachineIds.add(options.machineId);
  for (const rawInput of inputs as unknown[]) {
    if (!rawInput || typeof rawInput !== "object") continue;
    const machineId = (rawInput as { machineId?: unknown }).machineId;
    if (typeof machineId === "string" && UUID.test(machineId)) rawMachineIds.add(machineId);
  }
  const knownMachineIds = await listKnownMachineIdsWithPool(pool, owner, [...rawMachineIds]);
  if (options.machineId && !knownMachineIds.has(options.machineId)) {
    throw new AnalyserServiceError(409, "MACHINE_UNKNOWN", "Machine is not registered for this account");
  }

  const { settings } = await getEffectiveCollectionSettingsWithPool(pool, owner, options.machineId);
  const rejected: Record<string, number> = {};
  const accepted: Array<Record<string, unknown>> = [];

  for (const rawInput of inputs as unknown[]) {
    const parsed = observationInputSchema.safeParse(rawInput);
    const source = rejectedSource(rawInput);
    if (!parsed.success) {
      incrementRejected(rejected, source);
      continue;
    }
    const input: ObservationInput = parsed.data;
    if (!isSourceEnabled(input.source, settings) || !passesFilters(input, settings)) {
      incrementRejected(rejected, input.source);
      continue;
    }
    const effectiveMachineId = options.machineId ?? input.machineId ?? null;
    accepted.push({
      source: input.source,
      action: input.action,
      actorKind: input.actorKind,
      machineId: effectiveMachineId && knownMachineIds.has(effectiveMachineId) ? effectiveMachineId : null,
      projectId: input.projectId ?? null,
      occurredAt: input.occurredAt,
      resourceRefs: input.resourceRefs ?? [],
      metadata: sanitizeMetadata(input.metadata, input.source, {
        stripWindowTitle: input.source === "pc_activity" && settings.windowTitleUpload !== true
      }),
      sourceEventId: input.sourceEventId ?? null,
      dedupeKey: input.dedupeKey,
      expiresAt: expiresAt(input.occurredAt, settings.retentionDays[input.source])
    });
  }

  if (accepted.length === 0) return { ingested: 0, duplicates: 0, rejected };
  const result = await pool.query<{ id: string }>(`INSERT INTO analyser_observations
    (service_account_id, source, action, actor_kind, machine_id, project_id, occurred_at,
      resource_refs, metadata, source_event_id, dedupe_key, expires_at)
    SELECT $1, x.source, x.action, x."actorKind", x."machineId", x."projectId", x."occurredAt",
      x."resourceRefs", x.metadata, x."sourceEventId", x."dedupeKey", x."expiresAt"
    FROM jsonb_to_recordset($2::jsonb) AS x(
      source text, action text, "actorKind" text, "machineId" uuid, "projectId" text,
      "occurredAt" timestamptz, "resourceRefs" jsonb, metadata jsonb,
      "sourceEventId" text, "dedupeKey" text, "expiresAt" timestamptz)
    ON CONFLICT (service_account_id, dedupe_key) DO NOTHING
    RETURNING id`, [owner, JSON.stringify(accepted)]);
  const ingested = result.rowCount ?? result.rows.length;
  return { ingested, duplicates: accepted.length - ingested, rejected };
}

function encodeCursor(seq: string): string {
  return Buffer.from(seq, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const seq = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(seq) || encodeCursor(seq) !== cursor) throw new Error("invalid");
    return seq;
  } catch {
    throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid observation cursor");
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined ? fallback : Math.min(maximum, Math.max(1, Math.trunc(value)));
}

export async function listObservations(
  owner: string,
  options: { source?: ObservationSource; machineId?: string; projectId?: string; from?: string; to?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: ObservationRecord[]; nextCursor?: string }> {
  return listObservationsWithPool(getAnalyserPool(), owner, options);
}

export async function listObservationsWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { source?: ObservationSource; machineId?: string; projectId?: string; from?: string; to?: string; limit?: number; cursor?: string } = {}
): Promise<{ items: ObservationRecord[]; nextCursor?: string }> {
  const values: unknown[] = [owner];
  const where = ["service_account_id = $1", "expires_at > NOW()"];
  const add = (clause: string, value: unknown): void => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
  if (options.source) add("source = ?", options.source);
  if (options.machineId) add("machine_id = ?::uuid", options.machineId);
  if (options.projectId) add("project_id = ?", options.projectId);
  if (options.from) add("occurred_at >= ?::timestamptz", options.from);
  if (options.to) add("occurred_at <= ?::timestamptz", options.to);
  if (options.cursor) add("seq < ?::bigint", decodeCursor(options.cursor));
  const limit = boundedLimit(options.limit, 50, 200);
  values.push(limit + 1);
  const result = await pool.query<ObservationRow>(`SELECT seq, id, source, action, actor_kind, machine_id, project_id,
      occurred_at, received_at, resource_refs, metadata, source_event_id, dedupe_key, expires_at
    FROM analyser_observations
    WHERE ${where.join(" AND ")}
    ORDER BY seq DESC
    LIMIT $${values.length}`, values);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  return {
    items: rows.map(mapObservation),
    ...(hasMore && tail ? { nextCursor: encodeCursor(String(tail.seq)) } : {})
  };
}

export async function pullObservationsAfter(
  owner: string,
  afterSeq: string,
  limit?: number
): Promise<{ items: ObservationRecord[]; maxSeq: string }> {
  return pullObservationsAfterWithPool(getAnalyserPool(), owner, afterSeq, limit);
}

// Access observations produced by an agent (actorKind "agent") are the analyser
// poller's own reads while executing a routine (e.g. projects.list). They are
// still recorded for audit, but they must not feed the NEXT routine's analysis
// window, otherwise the maintenance loop analyses its own activity. We drop them
// from the returned items while still advancing the cursor past them (maxSeq is
// taken from the full scanned window), so they are skipped exactly once.
const AGENT_SELF_ACCESS_SOURCES: ReadonlySet<ObservationSource> = new Set(["mcp_access", "ui_access"]);

export async function pullObservationsAfterWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  afterSeq: string,
  limit?: number
): Promise<{ items: ObservationRecord[]; maxSeq: string }> {
  if (!/^\d+$/.test(afterSeq)) throw new AnalyserServiceError(400, "INVALID_CURSOR", "Invalid observation sequence");
  const bounded = boundedLimit(limit, 200, 500);
  const result = await pool.query<ObservationRow>(`SELECT seq, id, source, action, actor_kind, machine_id, project_id,
      occurred_at, received_at, resource_refs, metadata, source_event_id, dedupe_key, expires_at
    FROM analyser_observations
    WHERE service_account_id = $1 AND seq > $2::bigint AND expires_at > NOW()
    ORDER BY seq ASC
    LIMIT $3`, [owner, afterSeq, bounded]);
  const scanned = result.rows.map(mapObservation);
  const maxSeq = scanned.at(-1)?.seq ?? afterSeq;
  const items = scanned.filter(
    (observation) => !(observation.actorKind === "agent" && AGENT_SELF_ACCESS_SOURCES.has(observation.source))
  );
  return { items, maxSeq };
}

export async function aggregateActivity(
  owner: string,
  options: { from: string; to: string; machineId?: string; timezone?: string }
): Promise<ActivityAggregate> {
  return aggregateActivityWithPool(getAnalyserPool(), owner, options);
}

export async function aggregateActivityWithPool(
  pool: AnalyserQueryPool,
  owner: string,
  options: { from: string; to: string; machineId?: string; timezone?: string }
): Promise<ActivityAggregate> {
  const timezone = options.timezone ?? "UTC";
  const result = await pool.query<{ aggregate: ActivityAggregate }>(`WITH filtered AS (
      SELECT (occurred_at AT TIME ZONE $5)::date AS activity_date, machine_id,
        COALESCE(metadata->>'idle' = 'true', FALSE) AS idle,
        NULLIF(metadata->>'app', '') AS app
      FROM analyser_observations
      WHERE service_account_id = $1
        AND source = 'pc_activity'
        AND expires_at > NOW()
        AND occurred_at >= ($2::date::timestamp AT TIME ZONE $5)
        AND occurred_at < (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE $5)
        AND ($4::uuid IS NULL OR machine_id = $4::uuid)
    ), day_counts AS (
      SELECT activity_date, machine_id,
        COUNT(*)::integer AS sample_count,
        COUNT(*) FILTER (WHERE idle)::integer AS idle_count,
        COUNT(*) FILTER (WHERE NOT idle)::integer AS active_count
      FROM filtered GROUP BY activity_date, machine_id
    ), app_counts AS (
      SELECT activity_date, machine_id, app, COUNT(*)::integer AS app_count
      FROM filtered WHERE NOT idle AND app IS NOT NULL
      GROUP BY activity_date, machine_id, app
    ), day_apps AS (
      SELECT activity_date, machine_id, jsonb_object_agg(app, app_count ORDER BY app) AS apps
      FROM app_counts GROUP BY activity_date, machine_id
    ), total_app_counts AS (
      SELECT app, SUM(app_count)::integer AS app_count FROM app_counts GROUP BY app
    )
    SELECT jsonb_build_object(
      'days', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'date', day_counts.activity_date,
        'machineId', day_counts.machine_id,
        'sampleCount', day_counts.sample_count,
        'idleCount', day_counts.idle_count,
        'activeCount', day_counts.active_count,
        'apps', COALESCE(day_apps.apps, '{}'::jsonb)
      ) ORDER BY day_counts.activity_date, day_counts.machine_id NULLS LAST)
      FROM day_counts LEFT JOIN day_apps
        ON day_apps.activity_date = day_counts.activity_date
        AND day_apps.machine_id IS NOT DISTINCT FROM day_counts.machine_id), '[]'::jsonb),
      'totals', jsonb_build_object(
        'sampleCount', COALESCE((SELECT SUM(sample_count)::integer FROM day_counts), 0),
        'idleCount', COALESCE((SELECT SUM(idle_count)::integer FROM day_counts), 0),
        'activeCount', COALESCE((SELECT SUM(active_count)::integer FROM day_counts), 0),
        'apps', COALESCE((SELECT jsonb_object_agg(app, app_count ORDER BY app) FROM total_app_counts), '{}'::jsonb)
      )
    ) AS aggregate`, [owner, options.from, options.to, options.machineId ?? null, timezone]);
  return result.rows[0]?.aggregate ?? { days: [], totals: { sampleCount: 0, idleCount: 0, activeCount: 0, apps: {} } };
}

export async function deleteExpiredObservations(limitPerBatch = 5000): Promise<number> {
  return deleteExpiredObservationsWithPool(getAnalyserPool(), limitPerBatch);
}

export async function deleteExpiredObservationsWithPool(pool: AnalyserQueryPool, limitPerBatch = 5000): Promise<number> {
  const limit = Math.max(1, Math.trunc(limitPerBatch));
  const result = await pool.query<{ id: string }>(`WITH expired AS (
      SELECT ctid FROM analyser_observations
      WHERE expires_at <= NOW()
      LIMIT $1
    )
    DELETE FROM analyser_observations observation
    USING expired
    WHERE observation.ctid = expired.ctid
    RETURNING observation.id`, [limit]);
  return result.rowCount ?? result.rows.length;
}

export function startRetentionHousekeeping(
  intervalMs = 3_600_000,
  logger: RetentionLogger = console
): () => void {
  const timer = setInterval(() => {
    void deleteExpiredObservations().then((deleted) => {
      if (deleted > 0) logger.info?.("Deleted expired analyser observations", { deleted });
    }).catch((error: unknown) => {
      logger.error?.("Analyser retention housekeeping failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, Math.max(1, Math.trunc(intervalMs)));
  timer.unref?.();
  return () => clearInterval(timer);
}
