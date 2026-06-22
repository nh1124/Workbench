import { ProjectContextSyncError } from "./projectContextSync.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function canonicalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? undefined : value;
}

function invalidExport(): never {
  throw new ProjectContextSyncError(
    502,
    "PROJECT_CONTEXT_EXPORT_UNAVAILABLE",
    "Projects service returned an incomplete or invalid Project context export."
  );
}

function requireRecord(value: unknown): JsonRecord {
  const result = asRecord(value);
  if (Object.keys(result).length === 0) invalidExport();
  return result;
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) invalidExport();
  return value;
}

function requireTimestamp(record: JsonRecord, key: string): string {
  const value = canonicalIsoTimestamp(record[key]);
  if (!value) invalidExport();
  return value;
}

function validateProject(value: unknown, projectId: string): JsonRecord {
  const project = requireRecord(value);
  if (requireString(project, "id") !== projectId) invalidExport();
  requireString(project, "name");
  requireString(project, "status");
  requireTimestamp(project, "updatedAt");
  return project;
}

function validateBrief(value: unknown, projectId: string): JsonRecord {
  const brief = requireRecord(value);
  if (requireString(brief, "projectId") !== projectId) invalidExport();
  if (typeof brief.contentMarkdown !== "string" || nonNegativeInteger(brief.version) === undefined) invalidExport();
  requireTimestamp(brief, "updatedAt");
  return brief;
}

function validateMemories(value: unknown, projectId: string): JsonRecord[] {
  if (!Array.isArray(value)) invalidExport();
  return value.map((item) => {
    const memory = requireRecord(item);
    if (requireString(memory, "projectId") !== projectId) invalidExport();
    for (const key of ["id", "kind", "bodyMarkdown", "authority", "status"] as const) requireString(memory, key);
    requireTimestamp(memory, "createdAt");
    requireTimestamp(memory, "updatedAt");
    return memory;
  });
}

function validateRelations(value: unknown, projectId: string): JsonRecord[] {
  if (!Array.isArray(value)) invalidExport();
  return value.map((item) => {
    const relation = requireRecord(item);
    const sourceProjectId = requireString(relation, "sourceProjectId");
    const targetProjectId = requireString(relation, "targetProjectId");
    if (sourceProjectId !== projectId && targetProjectId !== projectId) invalidExport();
    requireString(relation, "id");
    requireString(relation, "relationType");
    if (typeof relation.version !== "number" || !Number.isSafeInteger(relation.version) || relation.version < 1) invalidExport();
    requireTimestamp(relation, "createdAt");
    requireTimestamp(relation, "updatedAt");
    return relation;
  });
}

function validateLinks(value: unknown, projectId: string): JsonRecord[] {
  if (!Array.isArray(value)) invalidExport();
  return value.map((item) => {
    const link = requireRecord(item);
    if (requireString(link, "projectId") !== projectId) invalidExport();
    for (const key of ["id", "targetService", "targetResourceType", "targetResourceId", "relationType"] as const) {
      requireString(link, key);
    }
    requireTimestamp(link, "linkedAt");
    return link;
  });
}

function validateIndexEntries(value: unknown, projectId: string): JsonRecord[] {
  if (!Array.isArray(value)) invalidExport();
  return value.map((item) => {
    const entry = requireRecord(item);
    if (requireString(entry, "projectId") !== projectId) invalidExport();
    for (const key of ["id", "sourceService", "resourceType", "resourceId", "associationKind", "title", "summarySource"] as const) {
      requireString(entry, key);
    }
    if (typeof entry.summaryText !== "string") invalidExport();
    if (entry.associationKind !== "primary" && entry.associationKind !== "secondary") invalidExport();
    if (entry.associationKind === "secondary" && typeof entry.associationId !== "string") invalidExport();
    if (entry.associationKind === "primary" && entry.associationId !== undefined) invalidExport();
    requireTimestamp(entry, "sourceUpdatedAt");
    requireTimestamp(entry, "indexedAt");
    return entry;
  });
}

function validateSummary(value: unknown, projectId: string): JsonRecord | null {
  if (value === null) return null;
  const summary = requireRecord(value);
  if (requireString(summary, "projectId") !== projectId) invalidExport();
  for (const key of ["id", "summaryText", "source"] as const) requireString(summary, key);
  requireTimestamp(summary, "updatedAt");
  return summary;
}

function redactOwnerIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOwnerIdentity);
  if (!value || typeof value !== "object") return value;
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (key === "ownerAccountId" || key === "owner_account_id") continue;
    result[key] = redactOwnerIdentity(child);
  }
  return result;
}

export function buildProjectContextExportResponse(value: unknown, expectedProjectId: string): JsonRecord {
  const snapshot = asRecord(value);
  const project = validateProject(snapshot.project, expectedProjectId);
  const brief = validateBrief(snapshot.brief, expectedProjectId);
  const counts = asRecord(snapshot.counts);
  const memories = validateMemories(snapshot.memories, expectedProjectId);
  const relations = validateRelations(snapshot.relations, expectedProjectId);
  const links = validateLinks(snapshot.links, expectedProjectId);
  const indexEntries = validateIndexEntries(snapshot.indexEntries, expectedProjectId);
  const generatedSummary = validateSummary(snapshot.generatedSummary, expectedProjectId);
  const memoryCount = nonNegativeInteger(counts.memories);
  const relationCount = nonNegativeInteger(counts.relations);
  const linkCount = nonNegativeInteger(counts.links);
  const indexCount = nonNegativeInteger(counts.indexEntries);

  if (
    snapshot.schemaVersion !== 1
    || snapshot.packageType !== "workbench.project-context-export"
    || snapshot.complete !== true
    || !canonicalIsoTimestamp(snapshot.generatedAt)
    || memoryCount === undefined
    || relationCount === undefined
    || linkCount === undefined
    || indexCount === undefined
    || memories.length !== memoryCount
    || relations.length !== relationCount
    || links.length !== linkCount
    || indexEntries.length !== indexCount
  ) {
    invalidExport();
  }

  return redactOwnerIdentity({
    schemaVersion: 1,
    packageType: "workbench.project-context-export",
    generatedAt: snapshot.generatedAt,
    complete: true,
    project,
    brief,
    memories,
    relations,
    links,
    indexEntries,
    generatedSummary,
    counts: {
      memories: memoryCount,
      relations: relationCount,
      links: linkCount,
      indexEntries: indexCount
    }
  }) as JsonRecord;
}
