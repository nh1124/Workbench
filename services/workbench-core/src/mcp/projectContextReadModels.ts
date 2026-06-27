type JsonRecord = Record<string, unknown>;

export class ProjectContextReadModelError extends Error {
  readonly code = "INVALID_PROJECT_CONTEXT_READ_RESPONSE";
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectContextReadModelError(`Projects service returned an invalid ${label}`);
  }
  return value as JsonRecord;
}

function requireFields(value: unknown, label: string, stringFields: readonly string[]): JsonRecord {
  const record = requireRecord(value, label);
  if (stringFields.some((field) => typeof record[field] !== "string" || !(record[field] as string).trim())) {
    throw new ProjectContextReadModelError(`Projects service returned an invalid ${label}`);
  }
  return record;
}

function select(value: unknown, fields: readonly string[]): JsonRecord {
  const source = asRecord(value);
  const result: JsonRecord = {};
  for (const field of fields) {
    if (source[field] !== undefined) result[field] = source[field];
  }
  return result;
}

function compactPage(value: unknown, itemProjection: (item: unknown) => JsonRecord): JsonRecord {
  const page = requireRecord(value, "list page");
  if (!Array.isArray(page.items)) {
    throw new ProjectContextReadModelError("Projects service returned an invalid list page");
  }
  if (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || !page.nextCursor.trim() || page.nextCursor.trim() !== page.nextCursor)) {
    throw new ProjectContextReadModelError("Projects service returned an invalid list cursor");
  }
  return {
    items: page.items.map(itemProjection),
    ...(typeof page.nextCursor === "string" && page.nextCursor ? { nextCursor: page.nextCursor } : {})
  };
}

const projectFields = [
  "id", "name", "description", "status", "isFallbackDefault", "isUserDefault", "createdAt", "updatedAt"
] as const;
const briefFields = ["projectId", "contentMarkdown", "version", "updatedByKind", "updatedAt"] as const;
const memoryFields = [
  "id", "projectId", "kind", "bodyMarkdown", "authority", "sourceService", "sourceResourceType",
  "sourceResourceId", "confidence", "status", "supersedesId", "createdByKind", "createdAt", "updatedAt"
] as const;
const indexFields = [
  "id", "projectId", "sourceService", "resourceType", "resourceId", "associationKind", "associationId",
  "path", "title", "summaryText", "summarySource", "sourceVersion", "sourceUpdatedAt", "indexedAt", "metadataJson"
] as const;
const relationFields = [
  "id", "sourceProjectId", "targetProjectId", "relationType", "directionality", "note", "origin", "strength",
  "createdByKind", "version", "createdAt", "updatedAt"
] as const;
const linkFields = [
  "id", "projectId", "targetService", "targetResourceType", "targetResourceId", "relationType", "titleSnapshot",
  "summarySnapshot", "targetResolution", "targetUpdatedAt", "linkedAt", "metadataJson"
] as const;
const summaryFields = ["id", "projectId", "summaryText", "source", "updatedAt"] as const;

export const projectMcpReadProjection = (value: unknown): JsonRecord =>
  select(requireFields(value, "Project", ["id", "name", "status", "updatedAt"]), projectFields);
export const briefMcpReadProjection = (value: unknown): JsonRecord => {
  const brief = requireFields(value, "Project brief", ["projectId", "updatedAt"]);
  if (typeof brief.contentMarkdown !== "string" || typeof brief.version !== "number") {
    throw new ProjectContextReadModelError("Projects service returned an invalid Project brief");
  }
  return select(brief, briefFields);
};
export const memoryMcpReadProjection = (value: unknown): JsonRecord =>
  select(requireFields(value, "Project memory", ["id", "projectId", "kind", "bodyMarkdown", "authority", "status", "createdByKind", "createdAt", "updatedAt"]), memoryFields);
export const indexMcpReadProjection = (value: unknown): JsonRecord => {
  const entry = requireFields(value, "Project index entry", ["id", "projectId", "sourceService", "resourceType", "resourceId", "associationKind", "title", "summarySource", "sourceUpdatedAt", "indexedAt"]);
  if (typeof entry.summaryText !== "string") {
    throw new ProjectContextReadModelError("Projects service returned invalid Project index entry summaryText");
  }
  return select(entry, indexFields);
};
export const relationMcpReadProjection = (value: unknown): JsonRecord => {
  const relation = requireFields(value, "Project relation", ["id", "sourceProjectId", "targetProjectId", "relationType", "directionality", "origin", "createdByKind", "createdAt", "updatedAt"]);
  if (typeof relation.version !== "number") {
    throw new ProjectContextReadModelError("Projects service returned an invalid Project relation");
  }
  return select(relation, relationFields);
};
export const linkMcpReadProjection = (value: unknown): JsonRecord =>
  select(requireFields(value, "Project link", ["id", "projectId", "targetService", "targetResourceType", "targetResourceId", "relationType"]), linkFields);
export const summaryMcpReadProjection = (value: unknown): JsonRecord =>
  select(requireFields(value, "Project summary", ["id", "projectId", "summaryText", "source", "updatedAt"]), summaryFields);

export function memoryListMcpReadProjection(value: unknown): JsonRecord {
  return compactPage(value, memoryMcpReadProjection);
}

export function indexListMcpReadProjection(value: unknown): JsonRecord {
  return compactPage(value, indexMcpReadProjection);
}

export function relationListMcpReadProjection(value: unknown): JsonRecord {
  return compactPage(value, relationMcpReadProjection);
}

export function linkListMcpReadProjection(value: unknown): JsonRecord {
  return compactPage(value, linkMcpReadProjection);
}

export function projectContextMcpReadProjection(value: unknown): JsonRecord {
  const source = requireRecord(value, "Project context");
  const truncation = requireRecord(source.truncation, "Project context truncation");
  if (typeof truncation.maxChars !== "number" || !Array.isArray(truncation.truncatedSections)) {
    throw new ProjectContextReadModelError("Projects service returned an invalid Project context truncation");
  }
  const result: JsonRecord = {
    project: projectMcpReadProjection(source.project),
    truncation: select(truncation, ["maxChars", "truncatedSections"])
  };
  if (source.brief !== undefined && source.brief !== null) result.brief = briefMcpReadProjection(source.brief);
  if (source.generatedSummary !== undefined && source.generatedSummary !== null) {
    result.generatedSummary = summaryMcpReadProjection(source.generatedSummary);
  }
  for (const section of ["memories", "indexEntries", "relations", "links"] as const) {
    if (source[section] !== undefined && !Array.isArray(source[section])) {
      throw new ProjectContextReadModelError(`Projects service returned an invalid Project context ${section} section`);
    }
  }
  if (Array.isArray(source.memories)) result.memories = source.memories.map(memoryMcpReadProjection);
  if (Array.isArray(source.indexEntries)) result.indexEntries = source.indexEntries.map(indexMcpReadProjection);
  if (Array.isArray(source.relations)) result.relations = source.relations.map(relationMcpReadProjection);
  if (Array.isArray(source.links)) result.links = source.links.map(linkMcpReadProjection);
  return result;
}

export function deletionImpactMcpReadProjection(value: unknown): JsonRecord {
  const source = requireFields(value, "Project deletion impact", ["projectId"]);
  if (
    typeof source.canDelete !== "boolean" ||
    typeof source.primaryArtifactCount !== "number" ||
    typeof source.secondaryArtifactCount !== "number" ||
    !Array.isArray(source.primaryArtifacts) ||
    !Array.isArray(source.secondaryMemberships)
  ) {
    throw new ProjectContextReadModelError("Projects service returned an invalid Project deletion impact");
  }
  return {
    ...select(source, ["projectId", "canDelete", "primaryArtifactCount", "secondaryArtifactCount"]),
    primaryArtifacts: source.primaryArtifacts.map((item) =>
      select(requireFields(item, "primary Artifact impact", ["id", "kind", "title", "path"]), ["id", "kind", "title", "path", "version"])
    ),
    secondaryMemberships: source.secondaryMemberships.map((item) =>
      select(requireFields(item, "secondary Artifact impact", ["linkId", "artifactItemId"]), ["linkId", "artifactItemId"])
    )
  };
}
