import {
  getMeta,
  getRemoteResource,
  listAllRemoteResourcesForDomain,
  removeRemoteResource,
  upsertRemoteResource,
  type ManifestStore,
  type RemoteResource
} from "./manifestStore.js";

export const PROJECT_CONTEXT_DOMAIN = "project_context" as const;
export const PROJECT_CONTEXT_SCHEMA_VERSION = 1;
export const PROJECT_CONTEXT_SNAPSHOT_COMPLETE_META_KEY = "projectContextSnapshotComplete";
export const PROJECT_CONTEXT_SUPPORTED_META_KEY = "projectContextSupported";
export const PROJECT_CONTEXT_BASELINE_CURSOR_META_KEY = "projectContextBaselineCursor";

type JsonRecord = Record<string, unknown>;

export type ProjectContextSnapshot = {
  schemaVersion: 1;
  projectId: string;
  fetchedAt: string;
  baselineCursor: string;
  complete: true;
  counts: {
    memories: number;
    relations: number;
  };
  context: {
    project: JsonRecord;
    brief?: JsonRecord;
    memories: JsonRecord[];
    relations: JsonRecord[];
  };
};

export type LocalProjectContextFreshness = {
  source: "local-daemon";
  snapshotComplete: true;
  fetchedAt: string;
  lastSyncedAt?: string;
  baselineCursor?: string;
  availableSections: Array<"brief" | "memory" | "relations">;
  unavailableSections: Array<"summary" | "index" | "links">;
};

export class LocalProjectContextError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function canonicalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString() === value ? value : undefined;
}

function recordArray(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: JsonRecord[] = [];
  for (const item of value) {
    const parsed = record(item);
    if (!parsed) return undefined;
    items.push(parsed);
  }
  return items;
}

export function parseProjectContextSnapshot(value: unknown): ProjectContextSnapshot | undefined {
  const envelope = record(value);
  const context = record(envelope?.context);
  const project = record(context?.project);
  const briefValue = context?.brief;
  const brief = briefValue === undefined || briefValue === null ? undefined : record(briefValue);
  const memories = recordArray(context?.memories);
  const relations = recordArray(context?.relations);
  const counts = record(envelope?.counts);
  const projectId = nonEmptyString(envelope?.projectId);
  const fetchedAt = canonicalIsoTimestamp(envelope?.fetchedAt);
  const baselineCursor = typeof envelope?.baselineCursor === "string" && envelope.baselineCursor.length > 0
    ? envelope.baselineCursor
    : undefined;
  const memoryCount = finiteInteger(counts?.memories);
  const relationCount = finiteInteger(counts?.relations);

  if (
    envelope?.schemaVersion !== PROJECT_CONTEXT_SCHEMA_VERSION
    || envelope.complete !== true
    || !projectId
    || !fetchedAt
    || !baselineCursor
    || !/^\d+$/.test(baselineCursor)
    || !project
    || nonEmptyString(project.id) !== projectId
    || (brief !== undefined && nonEmptyString(brief.projectId) !== projectId)
    || memories === undefined
    || relations === undefined
    || memoryCount === undefined
    || relationCount === undefined
    || memoryCount !== memories.length
    || relationCount !== relations.length
    || memories.some((memory) => (
      !nonEmptyString(memory.id)
      || nonEmptyString(memory.projectId) !== projectId
      || memory.status !== "active"
      || !canonicalIsoTimestamp(memory.updatedAt)
    ))
    || relations.some((relation) => (
      !nonEmptyString(relation.id)
      || !canonicalIsoTimestamp(relation.updatedAt)
      || (nonEmptyString(relation.sourceProjectId) !== projectId
        && nonEmptyString(relation.targetProjectId) !== projectId)
    ))
  ) {
    return undefined;
  }

  return {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    projectId,
    fetchedAt,
    baselineCursor,
    complete: true,
    counts: { memories: memoryCount, relations: relationCount },
    context: { project, brief, memories, relations }
  };
}

export function cacheProjectContextSnapshot(
  store: ManifestStore,
  value: unknown,
  options: { version?: number; timestamp?: string } = {}
): ProjectContextSnapshot {
  const snapshot = parseProjectContextSnapshot(value);
  if (!snapshot) {
    throw new LocalProjectContextError(
      502,
      "LOCAL_PROJECT_CONTEXT_INVALID_SNAPSHOT",
      "Core returned an incomplete or unsupported Project context snapshot."
    );
  }
  const timestamp = options.timestamp ?? snapshot.fetchedAt;
  upsertRemoteResource(store, {
    domain: PROJECT_CONTEXT_DOMAIN,
    resourceId: snapshot.projectId,
    version: options.version,
    payload: snapshot as unknown as JsonRecord,
    updatedAt: snapshot.fetchedAt,
    lastSyncedAt: timestamp
  });
  return snapshot;
}

export function removeStaleProjectContextRows(store: ManifestStore, activeProjectIds: Set<string>): string[] {
  const removed: string[] = [];
  for (const resource of listAllRemoteResourcesForDomain(store, PROJECT_CONTEXT_DOMAIN, { includeDeleted: true })) {
    if (activeProjectIds.has(resource.resourceId)) continue;
    removeRemoteResource(store, PROJECT_CONTEXT_DOMAIN, resource.resourceId);
    removed.push(resource.resourceId);
  }
  return removed;
}

function currentProjectRecord(store: ManifestStore, projectId: string): JsonRecord | undefined {
  const resource = getRemoteResource(store, "projects", projectId);
  return resource && !resource.deleted ? resource.payload : undefined;
}

function freshness(resource: RemoteResource, snapshot: ProjectContextSnapshot): LocalProjectContextFreshness {
  return {
    source: "local-daemon",
    snapshotComplete: true,
    fetchedAt: snapshot.fetchedAt,
    lastSyncedAt: resource.lastSyncedAt,
    baselineCursor: snapshot.baselineCursor,
    availableSections: ["brief", "memory", "relations"],
    unavailableSections: ["summary", "index", "links"]
  };
}

export function getCachedProjectContext(store: ManifestStore, projectId: string): {
  snapshot: ProjectContextSnapshot;
  project: JsonRecord;
  freshness: LocalProjectContextFreshness;
} {
  const resource = getRemoteResource(store, PROJECT_CONTEXT_DOMAIN, projectId);
  const projectResource = getRemoteResource(store, "projects", projectId);
  if (projectResource?.deleted) {
    throw new LocalProjectContextError(404, "PROJECT_NOT_FOUND", "Project not found in the local cache.");
  }
  const project = currentProjectRecord(store, projectId);
  if (!resource || resource.deleted) {
    if (!project) {
      throw new LocalProjectContextError(404, "PROJECT_NOT_FOUND", "Project not found in the local cache.");
    }
    const supported = getMeta(store, PROJECT_CONTEXT_SUPPORTED_META_KEY);
    throw new LocalProjectContextError(
      503,
      "LOCAL_PROJECT_CONTEXT_UNAVAILABLE",
      supported === "0"
        ? "The connected Core does not support local Project context snapshots."
        : "A complete local Project context snapshot is not available yet."
    );
  }
  const snapshot = parseProjectContextSnapshot(resource.payload);
  if (!snapshot) {
    throw new LocalProjectContextError(
      503,
      "LOCAL_PROJECT_CONTEXT_UNAVAILABLE",
      "The cached Project context snapshot is incomplete or unsupported."
    );
  }
  return {
    snapshot,
    project: { ...snapshot.context.project, ...(project ?? {}) },
    freshness: freshness(resource, snapshot)
  };
}

function clampLimit(value: number | undefined, fallback: number, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function cursorFor(value: JsonRecord): string {
  const timestamp = canonicalIsoTimestamp(value.updatedAt) ?? canonicalIsoTimestamp(value.createdAt);
  const id = nonEmptyString(value.id) ?? "";
  if (!timestamp || !id) {
    throw new LocalProjectContextError(
      503,
      "LOCAL_PROJECT_CONTEXT_UNAVAILABLE",
      "The cached Project context contains an item that cannot be paginated safely."
    );
  }
  return Buffer.from(JSON.stringify({ t: timestamp, id }), "utf8").toString("base64url");
}

function parseCursor(value: string | undefined): { t: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor encoding");
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("Non-canonical cursor encoding");
    const parsed = record(JSON.parse(decoded.toString("utf8")));
    if (!parsed) throw new Error("Invalid cursor payload");
    const keys = Object.keys(parsed);
    if (keys.length !== 2 || !Object.hasOwn(parsed, "t") || !Object.hasOwn(parsed, "id")) {
      throw new Error("Invalid cursor payload");
    }
    const t = canonicalIsoTimestamp(parsed.t);
    const id = parsed.id;
    if (!t || typeof id !== "string" || id.length === 0) throw new Error("Invalid cursor fields");
    return { t, id };
  } catch {
    throw new LocalProjectContextError(400, "INVALID_CURSOR", "Invalid cursor");
  }
}

function updatedTuple(value: JsonRecord): [string, string] {
  return [nonEmptyString(value.updatedAt) ?? nonEmptyString(value.createdAt) ?? "", nonEmptyString(value.id) ?? ""];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function newestFirst(left: JsonRecord, right: JsonRecord): number {
  const [leftTime, leftId] = updatedTuple(left);
  const [rightTime, rightId] = updatedTuple(right);
  return compareText(rightTime, leftTime) || compareText(rightId, leftId);
}

function afterCursor(value: JsonRecord, cursor: { t: string; id: string }): boolean {
  const [time, id] = updatedTuple(value);
  return time < cursor.t || (time === cursor.t && id < cursor.id);
}

function page(items: JsonRecord[], limit: number, cursor?: string): { items: JsonRecord[]; nextCursor?: string } {
  const parsedCursor = parseCursor(cursor);
  const candidates = items.slice().sort(newestFirst).filter((item) => !parsedCursor || afterCursor(item, parsedCursor));
  const selected = candidates.slice(0, limit);
  return {
    items: selected,
    nextCursor: candidates.length > limit && selected.length > 0 ? cursorFor(selected[selected.length - 1]) : undefined
  };
}

export function getLocalProjectBrief(store: ManifestStore, projectId: string): JsonRecord {
  const cached = getCachedProjectContext(store, projectId);
  return {
    ...(cached.snapshot.context.brief ?? {
      projectId,
      contentMarkdown: "",
      version: 0,
      updatedByKind: "user",
      updatedAt: cached.snapshot.fetchedAt
    }),
    localCache: cached.freshness
  };
}

export function listLocalProjectMemories(
  store: ManifestStore,
  projectId: string,
  options: {
    q?: string;
    kind?: string;
    authority?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  } = {}
): { items: JsonRecord[]; nextCursor?: string; localCache: LocalProjectContextFreshness } {
  if (options.kind && !["decision", "fact", "preference", "pitfall", "observation"].includes(options.kind)) {
    throw new LocalProjectContextError(400, "INVALID_ARGUMENT", "Invalid memory kind");
  }
  if (options.authority && !["user_confirmed", "agent_observed", "imported"].includes(options.authority)) {
    throw new LocalProjectContextError(400, "INVALID_ARGUMENT", "Invalid memory authority");
  }
  if (options.status && !["active", "superseded", "archived"].includes(options.status)) {
    throw new LocalProjectContextError(400, "INVALID_ARGUMENT", "Invalid memory status");
  }
  const cached = getCachedProjectContext(store, projectId);
  if (options.status && options.status !== "active") {
    throw new LocalProjectContextError(
      503,
      "LOCAL_PROJECT_CONTEXT_SECTION_UNAVAILABLE",
      "The E1 local cache contains active Project memories only."
    );
  }
  const query = options.q?.trim().toLowerCase();
  const filtered = cached.snapshot.context.memories.filter((memory) => {
    if ((nonEmptyString(memory.status) ?? "active") !== "active") return false;
    if (options.kind && memory.kind !== options.kind) return false;
    if (options.authority && memory.authority !== options.authority) return false;
    if (query && !(typeof memory.bodyMarkdown === "string" && memory.bodyMarkdown.toLowerCase().includes(query))) return false;
    return true;
  });
  return {
    ...page(filtered, clampLimit(options.limit, 10), options.cursor),
    localCache: cached.freshness
  };
}

export function listLocalProjectRelations(
  store: ManifestStore,
  projectId: string,
  options: { limit?: number; cursor?: string } = {}
): { items: JsonRecord[]; nextCursor?: string; localCache: LocalProjectContextFreshness } {
  const cached = getCachedProjectContext(store, projectId);
  return {
    ...page(cached.snapshot.context.relations, clampLimit(options.limit, 10), options.cursor),
    localCache: cached.freshness
  };
}

const ALL_CONTEXT_SECTIONS = ["brief", "summary", "memory", "index", "relations", "links"] as const;
type ContextSection = typeof ALL_CONTEXT_SECTIONS[number];

function clampMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 12_000;
  return Math.max(1_000, Math.min(50_000, Math.floor(value)));
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function truncateText(value: unknown, max: number): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated]`;
}

function fitProject(project: JsonRecord, base: JsonRecord, maxChars: number): JsonRecord {
  if (serializedLength({ ...base, project }) <= maxChars) return project;
  const compact = {
    ...project,
    name: truncateText(project.name, 0),
    description: truncateText(project.description, 0)
  };
  if (serializedLength({ ...base, project: compact }) > maxChars) {
    throw new LocalProjectContextError(413, "LOCAL_PROJECT_CONTEXT_BUDGET_EXCEEDED", "Project metadata exceeds maxChars.");
  }
  return compact;
}

function deriveBudgetedContext(
  project: JsonRecord,
  sections: Partial<Record<ContextSection, unknown>>,
  freshnessValue: LocalProjectContextFreshness,
  maxChars: number,
  unavailable: ContextSection[]
): JsonRecord {
  const sectionKeys: Partial<Record<ContextSection, string>> = {
    brief: "brief",
    memory: "memories",
    relations: "relations"
  };
  const initialTruncated = new Set<ContextSection>(unavailable);
  for (const section of ["brief", "memory", "relations"] as const) {
    const value = sections[section];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) initialTruncated.add(section);
  }
  const truncation = { maxChars, truncatedSections: [...initialTruncated] };
  const output: JsonRecord = { truncation, localCache: freshnessValue };
  output.project = fitProject(project, output, maxChars);
  let blocked = false;

  for (const section of ["brief", "memory", "relations"] as const) {
    const value = sections[section];
    const key = sectionKeys[section];
    if (!key || value === undefined || blocked) continue;
    if (Array.isArray(value)) {
      const accepted: unknown[] = [];
      for (const item of value) {
        const candidate = { ...output, [key]: [...accepted, item] };
        if (serializedLength(candidate) > maxChars) break;
        accepted.push(item);
      }
      if (accepted.length > 0 || value.length === 0) output[key] = accepted;
      if (accepted.length < value.length) {
        blocked = true;
      } else {
        initialTruncated.delete(section);
        truncation.truncatedSections = [...initialTruncated];
      }
      continue;
    }
    const candidateTruncated = [...initialTruncated].filter((candidate) => candidate !== section);
    if (serializedLength({ ...output, [key]: value, truncation: { maxChars, truncatedSections: candidateTruncated } }) <= maxChars) {
      output[key] = value;
      initialTruncated.delete(section);
      truncation.truncatedSections = [...initialTruncated];
    } else {
      blocked = true;
    }
  }
  return output;
}

export function getLocalProjectContext(
  store: ManifestStore,
  projectId: string,
  options: {
    q?: string;
    include?: string[];
    memoryLimit?: number;
    relationLimit?: number;
    maxChars?: number;
  } = {}
): JsonRecord {
  const invalidSection = options.include?.find(
    (section) => !ALL_CONTEXT_SECTIONS.includes(section as ContextSection)
  );
  if (invalidSection) {
    throw new LocalProjectContextError(400, "INVALID_ARGUMENT", "Invalid context section");
  }
  const cached = getCachedProjectContext(store, projectId);
  const requested = new Set<ContextSection>(
    (options.include?.length ? options.include : [...ALL_CONTEXT_SECTIONS])
      .filter((section): section is ContextSection => ALL_CONTEXT_SECTIONS.includes(section as ContextSection))
  );
  const query = options.q?.trim().toLowerCase();
  const memories = cached.snapshot.context.memories
    .filter((memory) => !query || (typeof memory.bodyMarkdown === "string" && memory.bodyMarkdown.toLowerCase().includes(query)))
    .slice(0, clampLimit(options.memoryLimit, 10));
  const relations = cached.snapshot.context.relations.slice(0, clampLimit(options.relationLimit, 10));
  const unavailable = (["summary", "index", "links"] as ContextSection[]).filter((section) => requested.has(section));
  return deriveBudgetedContext(
    cached.project,
    {
      brief: requested.has("brief") ? cached.snapshot.context.brief : undefined,
      memory: requested.has("memory") ? memories : undefined,
      relations: requested.has("relations") ? relations : undefined
    },
    cached.freshness,
    clampMaxChars(options.maxChars),
    unavailable
  );
}
