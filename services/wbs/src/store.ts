import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getWbsPool } from "./db.js";
import { buildWbsExport } from "./exporters.js";
import {
  calculateItemRollups,
  calculatePlanRollup,
  orderWbsItems,
  recalculateWbsCodes,
  type WbsRollupNode
} from "./rollup.js";
import type {
  WbsArtifactExportInput,
  WbsArtifactExportRecord,
  WbsDependencyCreateInput,
  WbsDependencyRecord,
  WbsDependencyType,
  WbsExportContent,
  WbsExportFormat,
  WbsItemCreateInput,
  WbsItemMoveInput,
  WbsItemRecord,
  WbsItemStatus,
  WbsItemUpdateInput,
  WbsListResult,
  WbsPlanCreateInput,
  WbsPlanRecord,
  WbsPlanUpdateInput,
  WbsRollup
} from "./types.js";

export class WbsServiceError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type DbClient = Pool | PoolClient;

type PlanRow = {
  id: string;
  owner_core_user_id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  description: string;
  settings_json: Record<string, unknown> | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type ItemRow = {
  id: string;
  owner_core_user_id: string;
  plan_id: string;
  parent_id: string | null;
  code: string;
  title: string;
  description: string;
  sort_order: number;
  owner_label: string | null;
  start_date: string | null;
  due_date: string | null;
  effort_hours: string | number | null;
  status: string;
  progress: number | null;
  linked_task_id: string | null;
  metadata_json: Record<string, unknown> | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type DependencyRow = {
  id: string;
  owner_core_user_id: string;
  plan_id: string;
  from_item_id: string;
  to_item_id: string;
  dependency_type: string;
  lag_days: number;
  created_at: Date | string;
};

type ArtifactExportRow = {
  id: string;
  owner_core_user_id: string;
  plan_id: string;
  source_version: number;
  artifact_item_id: string;
  artifact_path: string | null;
  format: string;
  exported_at: Date | string;
};

const pool = getWbsPool();

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function jsonRecord(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  return value;
}

function numberFromDb(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeStatus(value: string | undefined): WbsItemStatus {
  if (value === "doing" || value === "blocked" || value === "done") return value;
  return "todo";
}

function normalizeDependencyType(value: string | undefined): WbsDependencyType {
  if (value === "start_to_start" || value === "finish_to_finish" || value === "start_to_finish") return value;
  return "finish_to_start";
}

function normalizeEffort(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new WbsServiceError(400, "INVALID_EFFORT", "Effort hours must be zero or greater");
  }
  return value;
}

function normalizeProgress(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new WbsServiceError(400, "INVALID_PROGRESS", "Progress must be between 0 and 100");
  }
  return Math.round(value);
}

function mapPlan(row: PlanRow, rollup?: WbsRollup): WbsPlanRecord {
  return {
    id: row.id,
    ownerCoreUserId: row.owner_core_user_id,
    projectId: row.project_id ?? undefined,
    projectName: row.project_name ?? undefined,
    title: row.title,
    description: row.description,
    settings: jsonRecord(row.settings_json),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(rollup ? { rollup } : {})
  };
}

function mapItem(row: ItemRow, rollup?: WbsRollup): WbsItemRecord {
  return {
    id: row.id,
    ownerCoreUserId: row.owner_core_user_id,
    planId: row.plan_id,
    parentId: row.parent_id ?? undefined,
    code: row.code,
    title: row.title,
    description: row.description,
    sortOrder: row.sort_order,
    ownerLabel: row.owner_label ?? undefined,
    startDate: row.start_date ?? undefined,
    dueDate: row.due_date ?? undefined,
    effortHours: numberFromDb(row.effort_hours),
    status: normalizeStatus(row.status),
    progress: row.progress ?? undefined,
    linkedTaskId: row.linked_task_id ?? undefined,
    metadata: jsonRecord(row.metadata_json),
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(rollup ? { rollup } : {})
  };
}

function mapDependency(row: DependencyRow): WbsDependencyRecord {
  return {
    id: row.id,
    ownerCoreUserId: row.owner_core_user_id,
    planId: row.plan_id,
    fromItemId: row.from_item_id,
    toItemId: row.to_item_id,
    dependencyType: normalizeDependencyType(row.dependency_type),
    lagDays: row.lag_days,
    createdAt: iso(row.created_at)
  };
}

function mapArtifactExport(row: ArtifactExportRow): WbsArtifactExportRecord {
  return {
    id: row.id,
    ownerCoreUserId: row.owner_core_user_id,
    planId: row.plan_id,
    sourceVersion: row.source_version,
    artifactItemId: row.artifact_item_id,
    artifactPath: row.artifact_path ?? undefined,
    format: row.format as WbsExportFormat,
    exportedAt: iso(row.exported_at)
  };
}

function rowToRollupNode(row: ItemRow): WbsRollupNode {
  return {
    id: row.id,
    parentId: row.parent_id ?? undefined,
    sortOrder: row.sort_order,
    effortHours: numberFromDb(row.effort_hours),
    progress: row.progress ?? undefined,
    status: normalizeStatus(row.status)
  };
}

async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readPlan(
  ownerCoreUserId: string,
  planId: string,
  db: DbClient = pool,
  lock = false
): Promise<WbsPlanRecord | undefined> {
  const result = await db.query<PlanRow>(
    `
      SELECT id, owner_core_user_id, project_id, project_name, title, description,
             settings_json, version, created_at, updated_at
      FROM wbs_plans
      WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [ownerCoreUserId, planId]
  );
  const row = result.rows[0];
  return row ? mapPlan(row) : undefined;
}

async function requirePlan(
  ownerCoreUserId: string,
  planId: string,
  db: DbClient = pool,
  lock = false
): Promise<WbsPlanRecord> {
  const plan = await readPlan(ownerCoreUserId, planId, db, lock);
  if (!plan) {
    throw new WbsServiceError(404, "WBS_PLAN_NOT_FOUND", "WBS plan not found");
  }
  return plan;
}

async function readItem(
  ownerCoreUserId: string,
  itemId: string,
  db: DbClient = pool,
  lock = false
): Promise<WbsItemRecord | undefined> {
  const result = await db.query<ItemRow>(
    `
      SELECT id, owner_core_user_id, plan_id, parent_id, code, title, description,
             sort_order, owner_label, start_date, due_date, effort_hours, status,
             progress, linked_task_id, metadata_json, version, created_at, updated_at
      FROM wbs_items
      WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}
    `,
    [ownerCoreUserId, itemId]
  );
  const row = result.rows[0];
  return row ? mapItem(row) : undefined;
}

async function requireItem(
  ownerCoreUserId: string,
  itemId: string,
  db: DbClient = pool,
  lock = false
): Promise<WbsItemRecord> {
  const item = await readItem(ownerCoreUserId, itemId, db, lock);
  if (!item) {
    throw new WbsServiceError(404, "WBS_ITEM_NOT_FOUND", "WBS item not found");
  }
  return item;
}

async function listItemRows(ownerCoreUserId: string, planId: string, db: DbClient = pool): Promise<ItemRow[]> {
  const result = await db.query<ItemRow>(
    `
      SELECT id, owner_core_user_id, plan_id, parent_id, code, title, description,
             sort_order, owner_label, start_date, due_date, effort_hours, status,
             progress, linked_task_id, metadata_json, version, created_at, updated_at
      FROM wbs_items
      WHERE owner_core_user_id = $1 AND plan_id = $2 AND deleted_at IS NULL
      ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC
    `,
    [ownerCoreUserId, planId]
  );
  return result.rows;
}

async function readPlanRollup(ownerCoreUserId: string, planId: string, db: DbClient = pool): Promise<WbsRollup> {
  const rows = await listItemRows(ownerCoreUserId, planId, db);
  return calculatePlanRollup(rows.map(rowToRollupNode));
}

async function withPlanRollup(plan: WbsPlanRecord, db: DbClient = pool): Promise<WbsPlanRecord> {
  return {
    ...plan,
    rollup: await readPlanRollup(plan.ownerCoreUserId, plan.id, db)
  };
}

async function readItemWithRollup(ownerCoreUserId: string, itemId: string, db: DbClient = pool): Promise<WbsItemRecord> {
  const item = await requireItem(ownerCoreUserId, itemId, db);
  const items = await listItems(ownerCoreUserId, item.planId, db);
  const withRollup = items.find((candidate) => candidate.id === item.id);
  return withRollup ?? item;
}

async function incrementPlanVersion(client: PoolClient, ownerCoreUserId: string, planId: string): Promise<void> {
  await client.query(
    `
      UPDATE wbs_plans
      SET version = version + 1,
          updated_at = NOW()
      WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL
    `,
    [ownerCoreUserId, planId]
  );
}

async function recalculatePlanCodes(client: PoolClient, ownerCoreUserId: string, planId: string): Promise<void> {
  const rows = await client.query<{
    id: string;
    parent_id: string | null;
    sort_order: number;
    code: string;
  }>(
    `
      SELECT id, parent_id, sort_order, code
      FROM wbs_items
      WHERE owner_core_user_id = $1 AND plan_id = $2 AND deleted_at IS NULL
      ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC
    `,
    [ownerCoreUserId, planId]
  );
  const codeById = new Map(recalculateWbsCodes(rows.rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id ?? undefined,
    sortOrder: row.sort_order
  }))).map((assignment) => [assignment.id, assignment.code]));

  for (const row of rows.rows) {
    const nextCode = codeById.get(row.id);
    if (nextCode && nextCode !== row.code) {
      await client.query(
        `
          UPDATE wbs_items
          SET code = $3,
              updated_at = NOW()
          WHERE owner_core_user_id = $1 AND id = $2
        `,
        [ownerCoreUserId, row.id, nextCode]
      );
    }
  }
}

function parseListCursor(value: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Malformed cursor");
    }
    const updatedAt = (decoded as { updatedAt?: unknown }).updatedAt;
    const id = (decoded as { id?: unknown }).id;
    if (typeof updatedAt !== "string" || typeof id !== "string" || !updatedAt || !id) {
      throw new Error("Malformed cursor");
    }
    return { updatedAt, id };
  } catch {
    throw new WbsServiceError(400, "INVALID_CURSOR", "Invalid WBS plan list cursor");
  }
}

function toListCursor(updatedAt: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt: iso(updatedAt), id }), "utf8").toString("base64url");
}

export async function listPlans(
  ownerCoreUserId: string,
  options: {
    projectId?: string;
    q?: string;
    limit?: number;
    cursor?: string;
  } = {}
): Promise<WbsListResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const params: unknown[] = [ownerCoreUserId];
  const filters = ["owner_core_user_id = $1", "deleted_at IS NULL"];

  if (options.projectId?.trim()) {
    params.push(options.projectId.trim());
    filters.push(`project_id = $${params.length}`);
  }
  if (options.q?.trim()) {
    params.push(`%${options.q.trim().toLowerCase()}%`);
    filters.push(
      `(LOWER(title) LIKE $${params.length} OR LOWER(description) LIKE $${params.length} OR LOWER(COALESCE(project_name, '')) LIKE $${params.length})`
    );
  }

  const cursor = parseListCursor(options.cursor);
  if (cursor) {
    params.push(cursor.updatedAt, cursor.id);
    filters.push(`(updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(limit + 1);

  const result = await pool.query<PlanRow>(
    `
      SELECT id, owner_core_user_id, project_id, project_name, title, description,
             settings_json, version, created_at, updated_at
      FROM wbs_plans
      WHERE ${filters.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  const items = await Promise.all(rows.map((row) => withPlanRollup(mapPlan(row))));

  return {
    items,
    nextCursor: result.rows.length > limit && last ? toListCursor(last.updated_at, last.id) : undefined
  };
}

export async function createPlan(ownerCoreUserId: string, input: WbsPlanCreateInput): Promise<WbsPlanRecord> {
  const title = input.title.trim();
  if (!title) {
    throw new WbsServiceError(400, "WBS_PLAN_TITLE_REQUIRED", "WBS plan title is required");
  }

  const result = await pool.query<PlanRow>(
    `
      INSERT INTO wbs_plans (
        id, owner_core_user_id, project_id, project_name, title, description, settings_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, owner_core_user_id, project_id, project_name, title, description,
                settings_json, version, created_at, updated_at
    `,
    [
      randomUUID(),
      ownerCoreUserId,
      optionalText(input.projectId) ?? null,
      optionalText(input.projectName) ?? null,
      title,
      input.description?.trim() ?? "",
      JSON.stringify(input.settings ?? {})
    ]
  );

  return withPlanRollup(mapPlan(result.rows[0]));
}

export async function getPlan(ownerCoreUserId: string, planId: string): Promise<WbsPlanRecord> {
  return withPlanRollup(await requirePlan(ownerCoreUserId, planId));
}

export async function getItem(ownerCoreUserId: string, itemId: string): Promise<WbsItemRecord> {
  return readItemWithRollup(ownerCoreUserId, itemId);
}

export async function updatePlan(
  ownerCoreUserId: string,
  planId: string,
  input: WbsPlanUpdateInput
): Promise<WbsPlanRecord> {
  return withTransaction(async (client) => {
    const existing = await requirePlan(ownerCoreUserId, planId, client, true);
    if (input.expectedVersion !== existing.version) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS plan was updated by another client");
    }

    const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
    if (!nextTitle) {
      throw new WbsServiceError(400, "WBS_PLAN_TITLE_REQUIRED", "WBS plan title is required");
    }

    const result = await client.query<PlanRow>(
      `
        UPDATE wbs_plans
        SET title = $3,
            description = $4,
            project_id = $5,
            project_name = $6,
            settings_json = $7::jsonb,
            version = version + 1,
            updated_at = NOW()
        WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL AND version = $8
        RETURNING id, owner_core_user_id, project_id, project_name, title, description,
                  settings_json, version, created_at, updated_at
      `,
      [
        ownerCoreUserId,
        planId,
        nextTitle,
        input.description !== undefined ? input.description.trim() : existing.description,
        input.projectId === null ? null : input.projectId !== undefined ? optionalText(input.projectId) ?? null : existing.projectId ?? null,
        input.projectName === null
          ? null
          : input.projectName !== undefined
            ? optionalText(input.projectName) ?? null
            : existing.projectName ?? null,
        JSON.stringify(input.settings ?? existing.settings),
        input.expectedVersion
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS plan was updated by another client");
    }
    return withPlanRollup(mapPlan(row), client);
  });
}

export async function deletePlan(ownerCoreUserId: string, planId: string, expectedVersion?: number): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await requirePlan(ownerCoreUserId, planId, client, true);
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS plan was updated by another client");
    }

    await client.query(
      `
        UPDATE wbs_plans
        SET deleted_at = NOW(),
            updated_at = NOW(),
            version = version + 1
        WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL
      `,
      [ownerCoreUserId, planId]
    );
    await client.query(
      `
        UPDATE wbs_items
        SET deleted_at = NOW(),
            updated_at = NOW(),
            version = version + 1
        WHERE owner_core_user_id = $1 AND plan_id = $2 AND deleted_at IS NULL
      `,
      [ownerCoreUserId, planId]
    );
    await client.query(
      `
        DELETE FROM wbs_dependencies
        WHERE owner_core_user_id = $1 AND plan_id = $2
      `,
      [ownerCoreUserId, planId]
    );
  });
}

export async function listItems(ownerCoreUserId: string, planId: string, db: DbClient = pool): Promise<WbsItemRecord[]> {
  await requirePlan(ownerCoreUserId, planId, db);
  const rows = await listItemRows(ownerCoreUserId, planId, db);
  const rollups = calculateItemRollups(rows.map(rowToRollupNode));
  return orderWbsItems(rows.map((row) => mapItem(row, rollups.get(row.id))));
}

export async function createItem(
  ownerCoreUserId: string,
  planId: string,
  input: WbsItemCreateInput
): Promise<WbsItemRecord> {
  return withTransaction(async (client) => {
    await requirePlan(ownerCoreUserId, planId, client, true);
    const title = input.title.trim();
    if (!title) {
      throw new WbsServiceError(400, "WBS_ITEM_TITLE_REQUIRED", "WBS item title is required");
    }

    const parentId = optionalText(input.parentId);
    if (parentId) {
      const parent = await requireItem(ownerCoreUserId, parentId, client);
      if (parent.planId !== planId) {
        throw new WbsServiceError(400, "INVALID_PARENT", "Parent item must belong to the same WBS plan");
      }
    }

    const sortResult = await client.query<{ max_sort_order: number | null }>(
      `
        SELECT MAX(sort_order) AS max_sort_order
        FROM wbs_items
        WHERE owner_core_user_id = $1
          AND plan_id = $2
          AND (($3::text IS NULL AND parent_id IS NULL) OR parent_id = $3)
          AND deleted_at IS NULL
      `,
      [ownerCoreUserId, planId, parentId ?? null]
    );
    const sortOrder = (sortResult.rows[0]?.max_sort_order ?? 0) + 1000;
    const itemId = randomUUID();

    await client.query(
      `
        INSERT INTO wbs_items (
          id, owner_core_user_id, plan_id, parent_id, code, title, description,
          sort_order, owner_label, start_date, due_date, effort_hours, status, progress
        )
        VALUES ($1, $2, $3, $4, '', $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        itemId,
        ownerCoreUserId,
        planId,
        parentId ?? null,
        title,
        input.description?.trim() ?? "",
        sortOrder,
        optionalText(input.ownerLabel) ?? null,
        optionalText(input.startDate) ?? null,
        optionalText(input.dueDate) ?? null,
        normalizeEffort(input.effortHours),
        input.status ?? "todo",
        normalizeProgress(input.progress)
      ]
    );

    await incrementPlanVersion(client, ownerCoreUserId, planId);
    await recalculatePlanCodes(client, ownerCoreUserId, planId);
    return readItemWithRollup(ownerCoreUserId, itemId, client);
  });
}

export async function updateItem(
  ownerCoreUserId: string,
  itemId: string,
  input: WbsItemUpdateInput
): Promise<WbsItemRecord> {
  return withTransaction(async (client) => {
    const existing = await requireItem(ownerCoreUserId, itemId, client, true);
    if (input.expectedVersion !== existing.version) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS item was updated by another client");
    }

    const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
    if (!nextTitle) {
      throw new WbsServiceError(400, "WBS_ITEM_TITLE_REQUIRED", "WBS item title is required");
    }

    const result = await client.query<ItemRow>(
      `
        UPDATE wbs_items
        SET title = $3,
            description = $4,
            owner_label = $5,
            start_date = $6,
            due_date = $7,
            effort_hours = $8,
            status = $9,
            progress = $10,
            linked_task_id = $11,
            version = version + 1,
            updated_at = NOW()
        WHERE owner_core_user_id = $1 AND id = $2 AND deleted_at IS NULL AND version = $12
        RETURNING id, owner_core_user_id, plan_id, parent_id, code, title, description,
                  sort_order, owner_label, start_date, due_date, effort_hours, status,
                  progress, linked_task_id, metadata_json, version, created_at, updated_at
      `,
      [
        ownerCoreUserId,
        itemId,
        nextTitle,
        input.description !== undefined ? input.description.trim() : existing.description,
        input.ownerLabel === null ? null : input.ownerLabel !== undefined ? optionalText(input.ownerLabel) ?? null : existing.ownerLabel ?? null,
        input.startDate === null ? null : input.startDate !== undefined ? optionalText(input.startDate) ?? null : existing.startDate ?? null,
        input.dueDate === null ? null : input.dueDate !== undefined ? optionalText(input.dueDate) ?? null : existing.dueDate ?? null,
        input.effortHours === null ? null : input.effortHours !== undefined ? normalizeEffort(input.effortHours) : existing.effortHours ?? null,
        input.status ?? existing.status,
        input.progress === null ? null : input.progress !== undefined ? normalizeProgress(input.progress) : existing.progress ?? null,
        input.linkedTaskId === null
          ? null
          : input.linkedTaskId !== undefined
            ? optionalText(input.linkedTaskId) ?? null
            : existing.linkedTaskId ?? null,
        input.expectedVersion
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS item was updated by another client");
    }

    await incrementPlanVersion(client, ownerCoreUserId, row.plan_id);
    return readItemWithRollup(ownerCoreUserId, itemId, client);
  });
}

async function descendantIds(client: PoolClient, ownerCoreUserId: string, planId: string, itemId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `
      WITH RECURSIVE descendants AS (
        SELECT id
        FROM wbs_items
        WHERE owner_core_user_id = $1 AND plan_id = $2 AND id = $3 AND deleted_at IS NULL
        UNION ALL
        SELECT child.id
        FROM wbs_items child
        INNER JOIN descendants parent ON child.parent_id = parent.id
        WHERE child.owner_core_user_id = $1 AND child.plan_id = $2 AND child.deleted_at IS NULL
      )
      SELECT id FROM descendants
    `,
    [ownerCoreUserId, planId, itemId]
  );
  return result.rows.map((row) => row.id);
}

export async function deleteItem(ownerCoreUserId: string, itemId: string, expectedVersion?: number): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await requireItem(ownerCoreUserId, itemId, client, true);
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS item was updated by another client");
    }

    const ids = await descendantIds(client, ownerCoreUserId, existing.planId, itemId);
    await client.query(
      `
        UPDATE wbs_items
        SET deleted_at = NOW(),
            updated_at = NOW(),
            version = version + 1
        WHERE owner_core_user_id = $1 AND plan_id = $2 AND id = ANY($3::text[]) AND deleted_at IS NULL
      `,
      [ownerCoreUserId, existing.planId, ids]
    );
    await client.query(
      `
        DELETE FROM wbs_dependencies
        WHERE owner_core_user_id = $1
          AND plan_id = $2
          AND (from_item_id = ANY($3::text[]) OR to_item_id = ANY($3::text[]))
      `,
      [ownerCoreUserId, existing.planId, ids]
    );
    await incrementPlanVersion(client, ownerCoreUserId, existing.planId);
    await recalculatePlanCodes(client, ownerCoreUserId, existing.planId);
  });
}

export async function moveItem(
  ownerCoreUserId: string,
  itemId: string,
  input: WbsItemMoveInput
): Promise<WbsItemRecord> {
  return withTransaction(async (client) => {
    const existing = await requireItem(ownerCoreUserId, itemId, client, true);
    if (input.expectedVersion !== existing.version) {
      throw new WbsServiceError(409, "VERSION_CONFLICT", "WBS item was updated by another client");
    }
    if (input.beforeItemId && input.afterItemId) {
      throw new WbsServiceError(400, "INVALID_MOVE", "Specify beforeItemId or afterItemId, not both");
    }

    await requirePlan(ownerCoreUserId, existing.planId, client, true);
    const nextParentId = input.parentId === null ? undefined : input.parentId !== undefined ? optionalText(input.parentId) : existing.parentId;
    if (nextParentId) {
      const parent = await requireItem(ownerCoreUserId, nextParentId, client);
      if (parent.planId !== existing.planId) {
        throw new WbsServiceError(400, "INVALID_PARENT", "Parent item must belong to the same WBS plan");
      }
      const descendants = await descendantIds(client, ownerCoreUserId, existing.planId, existing.id);
      if (descendants.includes(nextParentId)) {
        throw new WbsServiceError(400, "INVALID_MOVE", "Cannot move a WBS item under itself or its descendants");
      }
    }

    const siblingsResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM wbs_items
        WHERE owner_core_user_id = $1
          AND plan_id = $2
          AND (($3::text IS NULL AND parent_id IS NULL) OR parent_id = $3)
          AND id <> $4
          AND deleted_at IS NULL
        ORDER BY sort_order ASC, id ASC
      `,
      [ownerCoreUserId, existing.planId, nextParentId ?? null, existing.id]
    );
    const orderedIds = siblingsResult.rows.map((row) => row.id);

    let insertIndex = orderedIds.length;
    if (input.beforeItemId) {
      insertIndex = orderedIds.indexOf(input.beforeItemId);
      if (insertIndex < 0) {
        throw new WbsServiceError(400, "INVALID_MOVE", "beforeItemId must be a sibling in the target parent");
      }
    }
    if (input.afterItemId) {
      const afterIndex = orderedIds.indexOf(input.afterItemId);
      if (afterIndex < 0) {
        throw new WbsServiceError(400, "INVALID_MOVE", "afterItemId must be a sibling in the target parent");
      }
      insertIndex = afterIndex + 1;
    }
    orderedIds.splice(insertIndex, 0, existing.id);

    for (const [index, id] of orderedIds.entries()) {
      const sortOrder = (index + 1) * 1000;
      if (id === existing.id) {
        await client.query(
          `
            UPDATE wbs_items
            SET parent_id = $3,
                sort_order = $4,
                version = version + 1,
                updated_at = NOW()
            WHERE owner_core_user_id = $1 AND id = $2
          `,
          [ownerCoreUserId, id, nextParentId ?? null, sortOrder]
        );
      } else {
        await client.query(
          `
            UPDATE wbs_items
            SET sort_order = $3
            WHERE owner_core_user_id = $1 AND id = $2
          `,
          [ownerCoreUserId, id, sortOrder]
        );
      }
    }

    await incrementPlanVersion(client, ownerCoreUserId, existing.planId);
    await recalculatePlanCodes(client, ownerCoreUserId, existing.planId);
    return readItemWithRollup(ownerCoreUserId, existing.id, client);
  });
}

export async function listDependencies(ownerCoreUserId: string, planId: string): Promise<WbsDependencyRecord[]> {
  await requirePlan(ownerCoreUserId, planId);
  const result = await pool.query<DependencyRow>(
    `
      SELECT id, owner_core_user_id, plan_id, from_item_id, to_item_id, dependency_type,
             lag_days, created_at
      FROM wbs_dependencies
      WHERE owner_core_user_id = $1 AND plan_id = $2
      ORDER BY created_at DESC, id DESC
    `,
    [ownerCoreUserId, planId]
  );
  return result.rows.map(mapDependency);
}

export async function createDependency(
  ownerCoreUserId: string,
  planId: string,
  input: WbsDependencyCreateInput
): Promise<WbsDependencyRecord> {
  return withTransaction(async (client) => {
    await requirePlan(ownerCoreUserId, planId, client, true);
    if (input.fromItemId === input.toItemId) {
      throw new WbsServiceError(400, "INVALID_DEPENDENCY", "Dependency endpoints must be different WBS items");
    }

    const itemResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM wbs_items
        WHERE owner_core_user_id = $1
          AND plan_id = $2
          AND id = ANY($3::text[])
          AND deleted_at IS NULL
      `,
      [ownerCoreUserId, planId, [input.fromItemId, input.toItemId]]
    );
    if (itemResult.rows.length !== 2) {
      throw new WbsServiceError(400, "INVALID_DEPENDENCY", "Dependency endpoints must belong to the same WBS plan");
    }

    const result = await client.query<DependencyRow>(
      `
        INSERT INTO wbs_dependencies (
          id, owner_core_user_id, plan_id, from_item_id, to_item_id, dependency_type, lag_days
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, owner_core_user_id, plan_id, from_item_id, to_item_id,
                  dependency_type, lag_days, created_at
      `,
      [
        randomUUID(),
        ownerCoreUserId,
        planId,
        input.fromItemId,
        input.toItemId,
        input.dependencyType ?? "finish_to_start",
        input.lagDays ?? 0
      ]
    );
    await incrementPlanVersion(client, ownerCoreUserId, planId);
    return mapDependency(result.rows[0]);
  });
}

export async function deleteDependency(ownerCoreUserId: string, dependencyId: string): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ plan_id: string }>(
      `
        DELETE FROM wbs_dependencies
        WHERE owner_core_user_id = $1 AND id = $2
        RETURNING plan_id
      `,
      [ownerCoreUserId, dependencyId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new WbsServiceError(404, "WBS_DEPENDENCY_NOT_FOUND", "WBS dependency not found");
    }
    await incrementPlanVersion(client, ownerCoreUserId, row.plan_id);
  });
}

export async function exportPlan(
  ownerCoreUserId: string,
  planId: string,
  format: WbsExportFormat
): Promise<WbsExportContent> {
  const plan = await getPlan(ownerCoreUserId, planId);
  const items = await listItems(ownerCoreUserId, planId);
  const dependencies = await listDependencies(ownerCoreUserId, planId);
  return buildWbsExport(plan, items, dependencies, format);
}

export async function listArtifactExports(ownerCoreUserId: string, planId: string): Promise<WbsArtifactExportRecord[]> {
  await requirePlan(ownerCoreUserId, planId);
  const result = await pool.query<ArtifactExportRow>(
    `
      SELECT id, owner_core_user_id, plan_id, source_version, artifact_item_id,
             artifact_path, format, exported_at
      FROM wbs_artifact_exports
      WHERE owner_core_user_id = $1 AND plan_id = $2
      ORDER BY exported_at DESC, id DESC
    `,
    [ownerCoreUserId, planId]
  );
  return result.rows.map(mapArtifactExport);
}

export async function recordArtifactExport(
  ownerCoreUserId: string,
  planId: string,
  input: WbsArtifactExportInput
): Promise<WbsArtifactExportRecord> {
  await requirePlan(ownerCoreUserId, planId);
  const result = await pool.query<ArtifactExportRow>(
    `
      INSERT INTO wbs_artifact_exports (
        id, owner_core_user_id, plan_id, source_version, artifact_item_id, artifact_path, format
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, owner_core_user_id, plan_id, source_version, artifact_item_id,
                artifact_path, format, exported_at
    `,
    [
      randomUUID(),
      ownerCoreUserId,
      planId,
      input.sourceVersion,
      input.artifactItemId,
      optionalText(input.artifactPath) ?? null,
      input.format
    ]
  );
  return mapArtifactExport(result.rows[0]);
}
