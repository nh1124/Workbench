import { ensureProjectsSchema, getProjectsPool } from "./db.js";
import { iso, normalizeOwner } from "./projectStoreUtils.js";
import type {
  Project,
  ProjectBrief,
  ProjectContextExportSnapshot,
  ProjectContextSummary,
  ProjectIndexAssociationKind,
  ProjectIndexEntry,
  ProjectLink,
  ProjectMemoryAuthority,
  ProjectMemoryEntry,
  ProjectMemoryKind,
  ProjectMemoryLifecycleState,
  ProjectMemoryReviewReason,
  ProjectMemoryStatus,
  ProjectRelation,
  ProjectRelationDirection,
  ProjectRelationType,
  ProjectStatus,
  ProjectSyncContextSnapshot
} from "./types.js";

export const PROJECT_SYNC_CONTEXT_LIMITS = {
  memories: 5_000,
  relations: 5_000,
  rowBytes: 1 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024
} as const;

export const PROJECT_CONTEXT_EXPORT_LIMITS = {
  memories: 10_000,
  relations: 10_000,
  links: 50_000,
  indexEntries: 100_000,
  rowBytes: 1 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024
} as const;

type SnapshotLimits = {
  memories: number;
  relations: number;
  rowBytes: number;
  totalBytes: number;
};

type ExportLimits = SnapshotLimits & {
  links: number;
  indexEntries: number;
};

type QueryResult<Row> = {
  rows: Row[];
};

export type SnapshotTransactionClient = {
  query<Row = never>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
  release(): void;
};

export type SnapshotTransactionPool = {
  connect(): Promise<SnapshotTransactionClient>;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  owner_account_id: string;
  is_fallback_default: boolean;
  is_user_default: boolean;
  created_at: string;
  updated_at: string;
};

type BriefRow = {
  project_id: string;
  content_markdown: string;
  version: number;
  updated_by_kind: "user" | "agent";
  updated_at: string;
};

type MemoryRow = {
  id: string;
  project_id: string;
  kind: ProjectMemoryKind;
  body_markdown: string;
  authority: ProjectMemoryAuthority;
  source_service: string | null;
  source_resource_type: string | null;
  source_resource_id: string | null;
  confidence: number | null;
  status: ProjectMemoryStatus;
  supersedes_id: string | null;
  lifecycle_state?: ProjectMemoryLifecycleState;
  review_after?: string | null;
  last_confirmed_at?: string | null;
  review_reason?: ProjectMemoryReviewReason | null;
  created_by_kind: "user" | "agent" | "system";
  created_at: string;
  updated_at: string;
};

type RelationRow = {
  id: string;
  source_project_id: string;
  target_project_id: string;
  relation_type: ProjectRelationType;
  directionality: ProjectRelationDirection;
  note: string;
  origin: "manual" | "inferred";
  strength: number | null;
  created_by_kind: "user" | "agent" | "system";
  version: number;
  created_at: string;
  updated_at: string;
};

type LinkRow = {
  id: string;
  project_id: string;
  target_service: string;
  target_resource_type: string;
  target_resource_id: string;
  relation_type: string;
  title_snapshot: string | null;
  summary_snapshot: string | null;
  linked_at: string;
  metadata_json: unknown;
};

type IndexRow = {
  id: string;
  project_id: string;
  source_service: string;
  resource_type: string;
  resource_id: string;
  association_kind: ProjectIndexAssociationKind;
  association_id: string | null;
  path: string | null;
  title: string;
  summary_text: string;
  summary_source: string;
  source_version: string | null;
  content_hash: string | null;
  source_updated_at: string;
  indexed_at: string;
  metadata_json: unknown;
};

type SummaryRow = {
  id: string;
  project_id: string;
  summary_text: string;
  source: string;
  updated_at: string;
};

type CountRow = { count: string | number };

export class ProjectContextSnapshotLimitError extends Error {
  readonly status = 413;

  constructor(readonly code: "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED" | "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED") {
    super(code === "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED"
      ? "Project context sync snapshot exceeds a configured hard limit."
      : "Project context export snapshot exceeds a configured hard limit.");
    this.name = "ProjectContextSnapshotLimitError";
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    status: row.status,
    ownerAccountId: row.owner_account_id,
    isFallbackDefault: row.is_fallback_default,
    isUserDefault: row.is_user_default,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toBrief(row: BriefRow | undefined, project: Project): ProjectBrief {
  return row ? {
    projectId: row.project_id,
    contentMarkdown: row.content_markdown,
    version: Number(row.version),
    updatedByKind: row.updated_by_kind,
    updatedAt: iso(row.updated_at)
  } : {
    projectId: project.id,
    contentMarkdown: "",
    version: 0,
    updatedByKind: "user",
    updatedAt: project.createdAt
  };
}

function toMemory(row: MemoryRow): ProjectMemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    bodyMarkdown: row.body_markdown,
    authority: row.authority,
    sourceService: row.source_service ?? undefined,
    sourceResourceType: row.source_resource_type ?? undefined,
    sourceResourceId: row.source_resource_id ?? undefined,
    confidence: row.confidence ?? undefined,
    status: row.status,
    supersedesId: row.supersedes_id ?? undefined,
    lifecycleState: row.lifecycle_state ?? "triaged",
    reviewAfter: row.review_after ? iso(row.review_after) : null,
    lastConfirmedAt: row.last_confirmed_at ? iso(row.last_confirmed_at) : null,
    reviewReason: row.review_reason ?? null,
    createdByKind: row.created_by_kind,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toRelation(row: RelationRow): ProjectRelation {
  return {
    id: row.id,
    sourceProjectId: row.source_project_id,
    targetProjectId: row.target_project_id,
    relationType: row.relation_type,
    directionality: row.directionality,
    note: row.note,
    origin: row.origin,
    strength: row.strength ?? undefined,
    createdByKind: row.created_by_kind,
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toLink(row: LinkRow): ProjectLink {
  return {
    id: row.id,
    projectId: row.project_id,
    targetService: row.target_service,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    relationType: row.relation_type,
    titleSnapshot: row.title_snapshot ?? undefined,
    summarySnapshot: row.summary_snapshot ?? undefined,
    linkedAt: iso(row.linked_at),
    metadataJson: jsonRecord(row.metadata_json)
  };
}

function toIndexEntry(row: IndexRow): ProjectIndexEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceService: row.source_service,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    associationKind: row.association_kind,
    associationId: row.association_id ?? undefined,
    path: row.path ?? undefined,
    title: row.title,
    summaryText: row.summary_text,
    summarySource: row.summary_source,
    sourceVersion: row.source_version ?? undefined,
    contentHash: row.content_hash ?? undefined,
    sourceUpdatedAt: iso(row.source_updated_at),
    indexedAt: iso(row.indexed_at),
    metadataJson: jsonRecord(row.metadata_json)
  };
}

function toSummary(row: SummaryRow | undefined): ProjectContextSummary | null {
  return row ? {
    id: row.id,
    projectId: row.project_id,
    summaryText: row.summary_text,
    source: row.source,
    updatedAt: iso(row.updated_at)
  } : null;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalPath(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareOrdinal(left, right);
}

function canonicalMemories(items: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return items.sort((a, b) => compareOrdinal(a.createdAt, b.createdAt) || compareOrdinal(a.id, b.id));
}

function canonicalRelations(items: ProjectRelation[]): ProjectRelation[] {
  return items.sort((a, b) => compareOrdinal(a.sourceProjectId, b.sourceProjectId)
    || compareOrdinal(a.targetProjectId, b.targetProjectId)
    || compareOrdinal(a.relationType, b.relationType)
    || compareOrdinal(a.id, b.id));
}

function canonicalLinks(items: ProjectLink[]): ProjectLink[] {
  return items.sort((a, b) => compareOrdinal(a.linkedAt, b.linkedAt) || compareOrdinal(a.id, b.id));
}

function canonicalIndex(items: ProjectIndexEntry[]): ProjectIndexEntry[] {
  return items.sort((a, b) => compareOrdinal(a.sourceService, b.sourceService)
    || compareOrdinal(a.resourceType, b.resourceType)
    || compareOptionalPath(a.path, b.path)
    || compareOrdinal(a.resourceId, b.resourceId)
    || compareOrdinal(a.associationKind, b.associationKind)
    || compareOrdinal(a.id, b.id));
}

function count(row: CountRow | undefined): number {
  return Number(row?.count ?? 0);
}

function assertCounts(
  counts: Record<string, number>,
  limits: Record<string, number>,
  code: ProjectContextSnapshotLimitError["code"]
): void {
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > (limits[name] ?? Number.MAX_SAFE_INTEGER)) {
      throw new ProjectContextSnapshotLimitError(code);
    }
  }
}

function assertSerializedLimits(
  records: unknown[],
  snapshot: unknown,
  rowBytes: number,
  totalBytes: number,
  code: ProjectContextSnapshotLimitError["code"]
): void {
  if (records.some((record) => Buffer.byteLength(JSON.stringify(record), "utf8") > rowBytes)
    || Buffer.byteLength(JSON.stringify(snapshot), "utf8") > totalBytes) {
    throw new ProjectContextSnapshotLimitError(code);
  }
}

async function withReadSnapshot<T>(pool: SnapshotTransactionPool, operation: (client: SnapshotTransactionClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the read/snapshot error when rollback also fails.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readProject(client: SnapshotTransactionClient, projectId: string, owner: string): Promise<Project | undefined> {
  const result = await client.query<ProjectRow>(`
    /* project_context_snapshot:project */
    SELECT p.id, p.name, p.description, p.status, p.owner_account_id, p.is_fallback_default,
           COALESCE(prefs.default_project_id = p.id, FALSE) AS is_user_default, p.created_at, p.updated_at
    FROM projects p
    LEFT JOIN project_user_preferences prefs ON prefs.owner_account_id = p.owner_account_id
    WHERE p.id = $1 AND p.owner_account_id = $2
    LIMIT 1
  `, [projectId, owner]);
  return result.rows[0] ? toProject(result.rows[0]) : undefined;
}

async function readBrief(client: SnapshotTransactionClient, project: Project): Promise<ProjectBrief> {
  const result = await client.query<BriefRow>(`
    /* project_context_snapshot:brief */
    SELECT project_id, content_markdown, version, updated_by_kind, updated_at
    FROM project_briefs
    WHERE project_id = $1
    LIMIT 1
  `, [project.id]);
  return toBrief(result.rows[0], project);
}

async function readCount(
  client: SnapshotTransactionClient,
  tag: string,
  sql: string,
  values: unknown[]
): Promise<number> {
  const result = await client.query<CountRow>(`/* project_context_snapshot:${tag}_count */ ${sql}`, values);
  return count(result.rows[0]);
}

async function readMemories(client: SnapshotTransactionClient, projectId: string, activeOnly: boolean): Promise<ProjectMemoryEntry[]> {
  const result = await client.query<MemoryRow>(`
    /* project_context_snapshot:memories */
    SELECT id, project_id, kind, body_markdown, authority, source_service, source_resource_type,
           source_resource_id, confidence, status, supersedes_id, lifecycle_state, review_after,
           last_confirmed_at, review_reason, created_by_kind, created_at, updated_at
    FROM project_memory_entries
    WHERE project_id = $1 ${activeOnly ? "AND status = 'active'" : ""}
    ORDER BY created_at ASC, id ASC
  `, [projectId]);
  return canonicalMemories(result.rows.map(toMemory));
}

async function readRelations(client: SnapshotTransactionClient, projectId: string, owner: string): Promise<ProjectRelation[]> {
  const result = await client.query<RelationRow>(`
    /* project_context_snapshot:relations */
    SELECT r.id, r.source_project_id, r.target_project_id, r.relation_type, r.directionality, r.note, r.origin,
           r.strength, r.created_by_kind, r.version, r.created_at, r.updated_at
    FROM project_relations r
    JOIN projects source_project ON source_project.id = r.source_project_id
    JOIN projects target_project ON target_project.id = r.target_project_id
    WHERE (r.source_project_id = $1 OR r.target_project_id = $1)
      AND source_project.owner_account_id = $2
      AND target_project.owner_account_id = $2
      AND r.is_deleted = FALSE
    ORDER BY r.source_project_id ASC, r.target_project_id ASC, r.relation_type ASC, r.id ASC
  `, [projectId, owner]);
  return canonicalRelations(result.rows.map(toRelation));
}

export async function getProjectSyncContextSnapshotWithPool(
  pool: SnapshotTransactionPool,
  projectId: string,
  ownerAccountId: string,
  limits: SnapshotLimits = PROJECT_SYNC_CONTEXT_LIMITS
): Promise<ProjectSyncContextSnapshot | undefined> {
  const owner = normalizeOwner(ownerAccountId);
  return withReadSnapshot(pool, async (client) => {
    const project = await readProject(client, projectId, owner);
    if (!project) return undefined;
    const [memoryCount, relationCount] = await Promise.all([
      readCount(client, "memories", "SELECT COUNT(*) AS count FROM project_memory_entries WHERE project_id = $1 AND status = 'active'", [projectId]),
      readCount(client, "relations", `
        SELECT COUNT(*) AS count
        FROM project_relations r
        JOIN projects source_project ON source_project.id = r.source_project_id
        JOIN projects target_project ON target_project.id = r.target_project_id
        WHERE (r.source_project_id = $1 OR r.target_project_id = $1)
          AND source_project.owner_account_id = $2
          AND target_project.owner_account_id = $2
          AND r.is_deleted = FALSE
      `, [projectId, owner])
    ]);
    assertCounts({ memories: memoryCount, relations: relationCount }, limits, "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED");
    const [brief, memories, relations] = await Promise.all([
      readBrief(client, project),
      readMemories(client, projectId, true),
      readRelations(client, projectId, owner)
    ]);
    if (memories.length !== memoryCount || relations.length !== relationCount) {
      throw new Error("Project context sync snapshot count mismatch.");
    }
    const snapshot: ProjectSyncContextSnapshot = {
      projectId,
      complete: true,
      counts: { memories: memoryCount, relations: relationCount },
      project,
      brief,
      memories,
      relations
    };
    assertSerializedLimits([project, brief, ...memories, ...relations], snapshot, limits.rowBytes, limits.totalBytes, "PROJECT_CONTEXT_SYNC_LIMIT_EXCEEDED");
    return snapshot;
  });
}

export async function getProjectSyncContextSnapshot(
  projectId: string,
  ownerAccountId: string
): Promise<ProjectSyncContextSnapshot | undefined> {
  await ensureProjectsSchema();
  return getProjectSyncContextSnapshotWithPool(getProjectsPool(), projectId, ownerAccountId);
}

async function readLinks(client: SnapshotTransactionClient, projectId: string): Promise<ProjectLink[]> {
  const result = await client.query<LinkRow>(`
    /* project_context_snapshot:links */
    SELECT id, project_id, target_service, target_resource_type, target_resource_id, relation_type,
           title_snapshot, summary_snapshot, linked_at, metadata_json
    FROM project_links
    WHERE project_id = $1 AND is_deleted = FALSE
    ORDER BY linked_at ASC, id ASC
  `, [projectId]);
  return canonicalLinks(result.rows.map(toLink));
}

async function readIndex(client: SnapshotTransactionClient, projectId: string): Promise<ProjectIndexEntry[]> {
  const result = await client.query<IndexRow>(`
    /* project_context_snapshot:index */
    SELECT id, project_id, source_service, resource_type, resource_id, association_kind, association_id,
           path, title, summary_text, summary_source, source_version, content_hash, source_updated_at,
           indexed_at, metadata_json
    FROM project_index_entries
    WHERE project_id = $1 AND is_deleted = FALSE
    ORDER BY source_service ASC, resource_type ASC, path ASC NULLS FIRST, resource_id ASC, association_kind ASC, id ASC
  `, [projectId]);
  return canonicalIndex(result.rows.map(toIndexEntry));
}

async function readSummary(client: SnapshotTransactionClient, projectId: string): Promise<ProjectContextSummary | null> {
  const result = await client.query<SummaryRow>(`
    /* project_context_snapshot:summary */
    SELECT id, project_id, summary_text, source, updated_at
    FROM project_context_summaries
    WHERE project_id = $1
    LIMIT 1
  `, [projectId]);
  return toSummary(result.rows[0]);
}

export async function getProjectContextExportSnapshotWithPool(
  pool: SnapshotTransactionPool,
  projectId: string,
  ownerAccountId: string,
  limits: ExportLimits = PROJECT_CONTEXT_EXPORT_LIMITS
): Promise<ProjectContextExportSnapshot | undefined> {
  const owner = normalizeOwner(ownerAccountId);
  return withReadSnapshot(pool, async (client) => {
    const project = await readProject(client, projectId, owner);
    if (!project) return undefined;
    const [memoryCount, relationCount, linkCount, indexCount] = await Promise.all([
      readCount(client, "memories_export", "SELECT COUNT(*) AS count FROM project_memory_entries WHERE project_id = $1", [projectId]),
      readCount(client, "relations_export", `
        SELECT COUNT(*) AS count
        FROM project_relations r
        JOIN projects source_project ON source_project.id = r.source_project_id
        JOIN projects target_project ON target_project.id = r.target_project_id
        WHERE (r.source_project_id = $1 OR r.target_project_id = $1)
          AND source_project.owner_account_id = $2
          AND target_project.owner_account_id = $2
          AND r.is_deleted = FALSE
      `, [projectId, owner]),
      readCount(client, "links_export", "SELECT COUNT(*) AS count FROM project_links WHERE project_id = $1 AND is_deleted = FALSE", [projectId]),
      readCount(client, "index_export", "SELECT COUNT(*) AS count FROM project_index_entries WHERE project_id = $1 AND is_deleted = FALSE", [projectId])
    ]);
    const counts = { memories: memoryCount, relations: relationCount, links: linkCount, indexEntries: indexCount };
    assertCounts(counts, limits, "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED");
    const [brief, memories, relations, links, indexEntries, generatedSummary] = await Promise.all([
      readBrief(client, project),
      readMemories(client, projectId, false),
      readRelations(client, projectId, owner),
      readLinks(client, projectId),
      readIndex(client, projectId),
      readSummary(client, projectId)
    ]);
    if (memories.length !== memoryCount || relations.length !== relationCount
      || links.length !== linkCount || indexEntries.length !== indexCount) {
      throw new Error("Project context export snapshot count mismatch.");
    }
    const snapshot: ProjectContextExportSnapshot = {
      schemaVersion: 1,
      packageType: "workbench.project-context-export",
      generatedAt: new Date().toISOString(),
      complete: true,
      project,
      brief,
      memories,
      relations,
      links,
      indexEntries,
      generatedSummary,
      counts
    };
    assertSerializedLimits(
      [project, brief, ...memories, ...relations, ...links, ...indexEntries, ...(generatedSummary ? [generatedSummary] : [])],
      snapshot,
      limits.rowBytes,
      limits.totalBytes,
      "PROJECT_CONTEXT_EXPORT_LIMIT_EXCEEDED"
    );
    return snapshot;
  });
}

export async function getProjectContextExportSnapshot(
  projectId: string,
  ownerAccountId: string
): Promise<ProjectContextExportSnapshot | undefined> {
  await ensureProjectsSchema();
  return getProjectContextExportSnapshotWithPool(getProjectsPool(), projectId, ownerAccountId);
}
