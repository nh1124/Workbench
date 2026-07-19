import { randomUUID } from "node:crypto";
import { ensureArtifactsSchema, getArtifactsPool } from "./db.js";

export const ARTIFACT_MAINTENANCE_REASONS = ["conflict", "manual"] as const;
export type ArtifactMaintenanceReason = (typeof ARTIFACT_MAINTENANCE_REASONS)[number];
export type ArtifactMaintenanceStatus = "open" | "resolved";

export type ArtifactMaintenanceInfo = {
  id: string;
  projectId: string;
  projectName: string | null;
  title: string;
  path: string;
  kind: string | null;
  version: number | null;
};

export type ArtifactMaintenanceFlag = {
  id: string;
  artifactItemId: string;
  projectId: string;
  reason: ArtifactMaintenanceReason;
  note: string | null;
  status: ArtifactMaintenanceStatus;
  flaggedBy: string;
  flaggedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  artifact: ArtifactMaintenanceInfo;
};

export type ArtifactMaintenanceQueueItem = {
  id: string;
  kind: "artifact";
  projectId: string;
  projectName: string;
  resourceId: string;
  title: string;
  excerpt: string;
  reasons: ArtifactMaintenanceReason[];
  updatedAt: string;
  suggestedActions: ["resolve"];
  path: string;
  artifactKind?: string;
  version?: number;
  flaggedBy: string;
  flaggedAt: string;
};

export type ArtifactMaintenanceQueueResult = {
  items: ArtifactMaintenanceQueueItem[];
  nextCursor?: string;
  totals: {
    byReason: Partial<Record<ArtifactMaintenanceReason, number>>;
  };
};

type QueryResult<Row> = { rows: Row[] };

export type ArtifactMaintenanceQueryPool = {
  query<Row = never>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

type ArtifactItemSnapshotRow = {
  id: string;
  project_id: string;
};

type JoinedFlagRow = {
  id: string;
  artifact_item_id: string;
  project_id: string;
  reason: ArtifactMaintenanceReason;
  note: string | null;
  status: ArtifactMaintenanceStatus;
  flagged_by: string;
  flagged_at: string | Date;
  resolved_by: string | null;
  resolved_at: string | Date | null;
  resolution_note: string | null;
  artifact_project_name: string | null;
  artifact_title: string | null;
  artifact_path: string | null;
  artifact_kind: string | null;
  artifact_version: number | null;
};

type QueueRow = {
  flag_id: string;
  artifact_item_id: string;
  project_id: string;
  reason: ArtifactMaintenanceReason;
  note: string | null;
  flagged_by: string;
  flagged_at: string | Date;
  project_name: string | null;
  title: string | null;
  path: string | null;
  artifact_kind: string | null;
  version: number | null;
};

type CountRow = {
  reason: ArtifactMaintenanceReason;
  count: string | number;
};

type QueueCursor = {
  t: string;
  id: string;
};

export class ArtifactMaintenanceNotFoundError extends Error {
  readonly status = 404;
  readonly code: "ARTIFACT_ITEM_NOT_FOUND" | "ARTIFACT_MAINTENANCE_FLAG_NOT_FOUND";

  constructor(code: "ARTIFACT_ITEM_NOT_FOUND" | "ARTIFACT_MAINTENANCE_FLAG_NOT_FOUND", message: string) {
    super(message);
    this.name = "ArtifactMaintenanceNotFoundError";
    this.code = code;
  }
}

export class InvalidArtifactMaintenanceQueueCursorError extends Error {
  readonly status = 400;
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("Invalid cursor");
    this.name = "InvalidArtifactMaintenanceQueueCursorError";
  }
}

function normalizeOwner(ownerUsername: string): string {
  const normalized = ownerUsername.trim().toLowerCase();
  if (!normalized) throw new Error("Owner username is required");
  return normalized;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) return 20;
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function parseCursor(cursor: string | undefined): QueueCursor | undefined {
  if (!cursor) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidArtifactMaintenanceQueueCursorError();
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new InvalidArtifactMaintenanceQueueCursorError();
    const parsed = JSON.parse(decoded.toString("utf8")) as Partial<QueueCursor> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidArtifactMaintenanceQueueCursorError();
    }
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string" || !parsed.id) {
      throw new InvalidArtifactMaintenanceQueueCursorError();
    }
    if (!Number.isFinite(Date.parse(parsed.t)) || new Date(parsed.t).toISOString() !== parsed.t) {
      throw new InvalidArtifactMaintenanceQueueCursorError();
    }
    return { t: parsed.t, id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidArtifactMaintenanceQueueCursorError) throw error;
    throw new InvalidArtifactMaintenanceQueueCursorError();
  }
}

function toCursor(timestamp: string | Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: iso(timestamp), id }), "utf8").toString("base64url");
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

function toJoinedFlag(row: JoinedFlagRow): ArtifactMaintenanceFlag {
  return {
    id: row.id,
    artifactItemId: row.artifact_item_id,
    projectId: row.project_id,
    reason: row.reason,
    note: row.note,
    status: row.status,
    flaggedBy: row.flagged_by,
    flaggedAt: iso(row.flagged_at),
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
    resolutionNote: row.resolution_note,
    artifact: {
      id: row.artifact_item_id,
      projectId: row.project_id,
      projectName: row.artifact_project_name,
      title: row.artifact_title ?? "(deleted artifact)",
      path: row.artifact_path ?? "",
      kind: row.artifact_kind,
      version: row.artifact_version
    }
  };
}

function toQueueItem(row: QueueRow): ArtifactMaintenanceQueueItem {
  const flaggedAt = iso(row.flagged_at);
  return {
    id: `artifact:${row.artifact_item_id}`,
    kind: "artifact",
    projectId: row.project_id,
    projectName: row.project_name ?? row.project_id,
    resourceId: row.artifact_item_id,
    title: row.title ?? "(deleted artifact)",
    excerpt: row.note ?? row.reason,
    reasons: [row.reason],
    updatedAt: flaggedAt,
    suggestedActions: ["resolve"],
    path: row.path ?? "",
    ...(row.artifact_kind ? { artifactKind: row.artifact_kind } : {}),
    ...(typeof row.version === "number" ? { version: row.version } : {}),
    flaggedBy: row.flagged_by,
    flaggedAt
  };
}

const JOINED_FLAG_SELECT = `
  SELECT
    f.id,
    f.artifact_item_id,
    f.project_id,
    f.reason,
    f.note,
    f.status,
    f.flagged_by,
    f.flagged_at,
    f.resolved_by,
    f.resolved_at,
    f.resolution_note,
    ai.project_name AS artifact_project_name,
    ai.title AS artifact_title,
    ai.path AS artifact_path,
    ai.kind AS artifact_kind,
    ai.version AS artifact_version
  FROM artifact_maintenance_flags f
  LEFT JOIN artifact_items ai
    ON ai.id = f.artifact_item_id
   AND ai.owner_username = f.owner_username
  WHERE f.id = $1 AND f.owner_username = $2
  LIMIT 1
`;

export function createArtifactMaintenanceFlagsStore(
  pool: ArtifactMaintenanceQueryPool,
  ensureSchema: () => Promise<void> = async () => undefined
) {
  async function readJoinedFlag(flagId: string, owner: string): Promise<ArtifactMaintenanceFlag> {
    const result = await pool.query<JoinedFlagRow>(JOINED_FLAG_SELECT, [flagId, owner]);
    const row = result.rows[0];
    if (!row) {
      throw new ArtifactMaintenanceNotFoundError(
        "ARTIFACT_MAINTENANCE_FLAG_NOT_FOUND",
        "No maintenance flag found"
      );
    }
    return toJoinedFlag(row);
  }

  return {
    async flagArtifactItem(
      ownerUsername: string,
      artifactItemId: string,
      input: { reason: ArtifactMaintenanceReason; note?: string; flaggedBy: string }
    ): Promise<ArtifactMaintenanceFlag> {
      await ensureSchema();
      const owner = normalizeOwner(ownerUsername);
      const itemResult = await pool.query<ArtifactItemSnapshotRow>(
        `
          SELECT id, project_id
          FROM artifact_items
          WHERE id = $1 AND owner_username = $2
          LIMIT 1
        `,
        [artifactItemId, owner]
      );
      const item = itemResult.rows[0];
      if (!item) {
        throw new ArtifactMaintenanceNotFoundError("ARTIFACT_ITEM_NOT_FOUND", "Artifact item not found");
      }

      let flagId: string | undefined;
      for (let attempt = 0; attempt < 3 && !flagId; attempt += 1) {
        const updated = await pool.query<{ id: string }>(
          `
            UPDATE artifact_maintenance_flags
            SET project_id = $3,
                reason = $4,
                note = $5,
                flagged_by = $6,
                flagged_at = NOW()
            WHERE owner_username = $2
              AND artifact_item_id = $1
              AND status = 'open'
            RETURNING id
          `,
          [artifactItemId, owner, item.project_id, input.reason, input.note ?? null, input.flaggedBy]
        );
        flagId = updated.rows[0]?.id;
        if (flagId) break;

        const candidateId = randomUUID();
        try {
          const inserted = await pool.query<{ id: string }>(
            `
              INSERT INTO artifact_maintenance_flags (
                id, owner_username, artifact_item_id, project_id, reason, note, status, flagged_by
              )
              VALUES ($1, $2, $3, $4, $5, $6, 'open', $7)
              RETURNING id
            `,
            [candidateId, owner, artifactItemId, item.project_id, input.reason, input.note ?? null, input.flaggedBy]
          );
          flagId = inserted.rows[0]?.id ?? candidateId;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }

      if (!flagId) {
        throw new Error("Failed to create or update the open Artifact maintenance flag");
      }
      return readJoinedFlag(flagId, owner);
    },

    async resolveArtifactFlag(
      ownerUsername: string,
      artifactItemId: string,
      input: { resolvedBy: string; note?: string }
    ): Promise<ArtifactMaintenanceFlag> {
      await ensureSchema();
      const owner = normalizeOwner(ownerUsername);
      const result = await pool.query<{ id: string }>(
        `
          UPDATE artifact_maintenance_flags
          SET status = 'resolved',
              resolved_by = $3,
              resolved_at = NOW(),
              resolution_note = $4
          WHERE owner_username = $2
            AND artifact_item_id = $1
            AND status = 'open'
          RETURNING id
        `,
        [artifactItemId, owner, input.resolvedBy, input.note ?? null]
      );
      const flagId = result.rows[0]?.id;
      if (!flagId) {
        throw new ArtifactMaintenanceNotFoundError(
          "ARTIFACT_MAINTENANCE_FLAG_NOT_FOUND",
          "No open maintenance flag"
        );
      }
      return readJoinedFlag(flagId, owner);
    },

    async listArtifactMaintenanceQueue(
      ownerUsername: string,
      options: {
        projectId?: string;
        reason?: ArtifactMaintenanceReason;
        cursor?: string;
        limit?: number;
      } = {}
    ): Promise<ArtifactMaintenanceQueueResult> {
      await ensureSchema();
      const owner = normalizeOwner(ownerUsername);
      const baseValues: unknown[] = [owner];
      let projectFilter = "";
      if (options.projectId) {
        baseValues.push(options.projectId);
        projectFilter = `AND f.project_id = $${baseValues.length}`;
      }

      const totalsResult = await pool.query<CountRow>(
        `
          SELECT f.reason, COUNT(*)::text AS count
          FROM artifact_maintenance_flags f
          WHERE f.owner_username = $1
            AND f.status = 'open'
            ${projectFilter}
          GROUP BY f.reason
          ORDER BY f.reason ASC
        `,
        baseValues
      );

      const values = [...baseValues];
      let reasonFilter = "";
      if (options.reason) {
        values.push(options.reason);
        reasonFilter = `AND f.reason = $${values.length}`;
      }

      const cursor = parseCursor(options.cursor);
      let cursorFilter = "";
      if (cursor) {
        values.push(cursor.t, cursor.id);
        cursorFilter = `AND (f.flagged_at, f.id) < ($${values.length - 1}::timestamptz, $${values.length})`;
      }

      const pageSize = normalizeLimit(options.limit);
      values.push(pageSize + 1);
      const itemsResult = await pool.query<QueueRow>(
        `
          SELECT
            f.id AS flag_id,
            f.artifact_item_id,
            f.project_id,
            f.reason,
            f.note,
            f.flagged_by,
            f.flagged_at,
            ai.project_name,
            ai.title,
            ai.path,
            ai.kind AS artifact_kind,
            ai.version
          FROM artifact_maintenance_flags f
          LEFT JOIN artifact_items ai
            ON ai.id = f.artifact_item_id
           AND ai.owner_username = f.owner_username
          WHERE f.owner_username = $1
            AND f.status = 'open'
            ${projectFilter}
            ${reasonFilter}
            ${cursorFilter}
          ORDER BY f.flagged_at DESC, f.id DESC
          LIMIT $${values.length}
        `,
        values
      );

      const rows = itemsResult.rows.slice(0, pageSize);
      const last = rows.at(-1);
      return {
        items: rows.map(toQueueItem),
        ...(itemsResult.rows.length > pageSize && last
          ? { nextCursor: toCursor(last.flagged_at, last.flag_id) }
          : {}),
        totals: {
          byReason: Object.fromEntries(
            totalsResult.rows.map((row) => [row.reason, Number(row.count)])
          ) as Partial<Record<ArtifactMaintenanceReason, number>>
        }
      };
    }
  };
}

const defaultStore = createArtifactMaintenanceFlagsStore(getArtifactsPool(), ensureArtifactsSchema);

export const flagArtifactItem = defaultStore.flagArtifactItem;
export const resolveArtifactFlag = defaultStore.resolveArtifactFlag;
export const listArtifactMaintenanceQueue = defaultStore.listArtifactMaintenanceQueue;

export const artifactMaintenanceFlagsStoreTestHooks = {
  parseCursor,
  toCursor
};
