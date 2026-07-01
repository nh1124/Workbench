import { createHash } from "node:crypto";
import {
  artifactsClient,
  InternalServiceError,
  mindmapsClient,
  notesClient,
  projectsClient,
  tasksClient,
  wbsClient
} from "./internalClients.js";

export const SECONDARY_MEMBERSHIP_RELATION = "secondary_membership";
export const ARTIFACT_TARGET_SERVICE = "artifacts";
export const ARTIFACT_TARGET_RESOURCE_TYPE = "artifact_item";
export const MINDMAP_TARGET_SERVICE = "mindmaps";
export const MINDMAP_TARGET_RESOURCE_TYPE = "mindmap_document";
export const WBS_TARGET_SERVICE = "wbs";
export const WBS_TARGET_RESOURCE_TYPE = "wbs_plan";

type JsonRecord = Record<string, unknown>;

export type ArtifactItemRecord = JsonRecord & {
  id: string;
  projectId: string;
  projectName?: string;
  kind: "folder" | "note" | "file";
  title: string;
  path: string;
  version: number;
  updatedAt?: string;
  contentMarkdown?: string;
  tags?: string[];
  mimeType?: string;
  sizeBytes?: number;
};

export type ProjectLinkRecord = JsonRecord & {
  id: string;
  projectId: string;
  targetService: string;
  targetResourceType: string;
  targetResourceId: string;
  relationType: string;
  titleSnapshot?: string;
  summarySnapshot?: string;
  metadataJson?: JsonRecord;
};

export type ArtifactDeletionSnapshot = {
  rootArtifactItemId: string;
  items: Array<{ item: ArtifactItemRecord; links: ProjectLinkRecord[] }>;
};

type MindmapNodeRecord = JsonRecord & {
  id: string;
  title: string;
  note?: string;
  children?: MindmapNodeRecord[];
};

export type MindmapDocumentRecord = JsonRecord & {
  id: string;
  title: string;
  description?: string;
  mode: "mindmap" | "logical_tree";
  projectId?: string;
  projectName?: string;
  body: JsonRecord & { root?: MindmapNodeRecord };
  tags?: string[];
  version: number;
  updatedAt?: string;
};

export type WbsPlanRecord = JsonRecord & {
  id: string;
  title: string;
  description?: string;
  projectId?: string;
  projectName?: string;
  settings?: JsonRecord;
  rollup?: JsonRecord;
  version: number;
  updatedAt?: string;
};

export function projectIdsFromArtifactDeletionSnapshot(snapshot: ArtifactDeletionSnapshot): string[] {
  const projectIds = new Set<string>();
  for (const entry of snapshot.items) {
    projectIds.add(entry.item.projectId);
    for (const link of entry.links) projectIds.add(link.projectId);
  }
  return [...projectIds];
}

export class ProjectContextError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function pageItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = asRecord(value).items;
  return Array.isArray(items) ? items : [];
}

function nextCursor(value: unknown): string | undefined {
  const cursor = asRecord(value).nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

export function parseArtifactItem(value: unknown): ArtifactItemRecord {
  const record = asRecord(value);
  const kind = record.kind;
  if (
    typeof record.id !== "string" ||
    typeof record.projectId !== "string" ||
    (kind !== "folder" && kind !== "note" && kind !== "file") ||
    typeof record.title !== "string" ||
    typeof record.path !== "string" ||
    typeof record.version !== "number"
  ) {
    throw new ProjectContextError(502, "INVALID_ARTIFACT_RESPONSE", "Artifacts service returned an invalid item");
  }
  return record as ArtifactItemRecord;
}

export function parseMindmapDocument(value: unknown): MindmapDocumentRecord {
  const record = asRecord(value);
  const mode = record.mode;
  const body = asRecord(record.body);
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    (mode !== "mindmap" && mode !== "logical_tree") ||
    !body.root ||
    typeof record.version !== "number"
  ) {
    throw new ProjectContextError(502, "INVALID_MINDMAP_RESPONSE", "Mindmaps service returned an invalid document");
  }
  return {
    ...record,
    description: boundedText(record.description, 2000),
    projectId: boundedText(record.projectId, 200),
    projectName: boundedText(record.projectName, 500),
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
    body
  } as MindmapDocumentRecord;
}

export function parseWbsPlan(value: unknown): WbsPlanRecord {
  const record = asRecord(value);
  if (
    typeof record.id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.version !== "number"
  ) {
    throw new ProjectContextError(502, "INVALID_WBS_RESPONSE", "WBS service returned an invalid plan");
  }
  return {
    ...record,
    description: boundedText(record.description, 2000),
    projectId: boundedText(record.projectId, 200),
    projectName: boundedText(record.projectName, 500),
    settings: asRecord(record.settings),
    rollup: asRecord(record.rollup)
  } as WbsPlanRecord;
}

function parseProjectLink(value: unknown): ProjectLinkRecord | undefined {
  const record = asRecord(value);
  if (
    typeof record.id !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.targetService !== "string" ||
    typeof record.targetResourceType !== "string" ||
    typeof record.targetResourceId !== "string" ||
    typeof record.relationType !== "string"
  ) {
    return undefined;
  }
  return record as ProjectLinkRecord;
}

type ProjectLinkListOptions = {
  targetService?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  relationType?: string;
  limit?: number;
  cursor?: string;
};

type ResolvedProjectLinkTarget = {
  title: string;
  summary?: string;
  updatedAt?: string;
};

function liveTargetMetadata(link: ProjectLinkRecord, value: unknown): ResolvedProjectLinkTarget | undefined {
  const record = asRecord(value);
  const updatedAt = boundedText(record.updatedAt, 64);

  if (link.targetService === ARTIFACT_TARGET_SERVICE && link.targetResourceType === ARTIFACT_TARGET_RESOURCE_TYPE) {
    const title = boundedText(record.title, 240);
    if (!title) return undefined;
    const kind = boundedText(record.kind, 40);
    const path = boundedText(record.path, 500);
    const summary = boundedText([kind, path].filter(Boolean).join(" · "), 500);
    return { title, ...(summary ? { summary } : {}), ...(updatedAt ? { updatedAt } : {}) };
  }

  if (link.targetService === ARTIFACT_TARGET_SERVICE && link.targetResourceType === "artifact") {
    const title = boundedText(record.name, 240);
    if (!title) return undefined;
    const summary = boundedText(record.description, 500);
    return { title, ...(summary ? { summary } : {}), ...(updatedAt ? { updatedAt } : {}) };
  }

  if (link.targetService === "notes" && link.targetResourceType === "note") {
    const title = boundedText(record.title, 240);
    if (!title) return undefined;
    return { title, ...(updatedAt ? { updatedAt } : {}) };
  }

  if (link.targetService === "tasks" && link.targetResourceType === "task") {
    const title = boundedText(record.title, 240);
    if (!title) return undefined;
    const summary = boundedText(
      [record.status, record.context].filter((part): part is string => typeof part === "string").join(" · "),
      500
    );
    return { title, ...(summary ? { summary } : {}), ...(updatedAt ? { updatedAt } : {}) };
  }

  return undefined;
}

async function readSupportedProjectLinkTarget(token: string, link: ProjectLinkRecord): Promise<unknown | undefined> {
  if (link.targetService === ARTIFACT_TARGET_SERVICE && link.targetResourceType === ARTIFACT_TARGET_RESOURCE_TYPE) {
    return artifactsClient.getItem(token, link.targetResourceId);
  }
  if (link.targetService === ARTIFACT_TARGET_SERVICE && link.targetResourceType === "artifact") {
    return artifactsClient.get(token, link.targetResourceId);
  }
  if (link.targetService === "notes" && link.targetResourceType === "note") {
    return notesClient.get(token, link.targetResourceId);
  }
  if (link.targetService === "tasks" && link.targetResourceType === "task") {
    return tasksClient.get(token, link.targetResourceId);
  }
  return undefined;
}

async function resolveProjectLinkForRead(
  token: string,
  rawLink: unknown,
  expectedProjectId: string
): Promise<unknown> {
  const link = parseProjectLink(rawLink);
  if (!link || link.projectId !== expectedProjectId) return rawLink;

  try {
    const target = await readSupportedProjectLinkTarget(token, link);
    if (target === undefined) return link;
    const resolved = liveTargetMetadata(link, target);
    if (!resolved) return { ...link, targetResolution: "snapshot" };
    return {
      ...link,
      titleSnapshot: resolved.title,
      ...(resolved.summary ? { summarySnapshot: resolved.summary } : {}),
      targetResolution: "live",
      ...(resolved.updatedAt ? { targetUpdatedAt: resolved.updatedAt } : {})
    };
  } catch {
    // The same bearer token is used for the target read. Missing, cross-owner,
    // and temporarily unavailable targets all fall back to the stored snapshot.
    return { ...link, targetResolution: "snapshot" };
  }
}

async function resolveProjectLinkItems(
  token: string,
  expectedProjectId: string,
  rawItems: unknown[]
): Promise<unknown[]> {
  const resolved = new Array<unknown>(rawItems.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < rawItems.length) {
      const index = nextIndex;
      nextIndex += 1;
      resolved[index] = await resolveProjectLinkForRead(token, rawItems[index], expectedProjectId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, rawItems.length) }, worker));
  return resolved;
}

export async function listProjectLinksResolved(
  token: string,
  projectId: string,
  options: ProjectLinkListOptions = {}
): Promise<JsonRecord> {
  const rawPage = await projectsClient.listLinks(token, projectId, options);
  if (!rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_LINK_LIST_RESPONSE", "Projects service returned an invalid link page");
  }
  const page = rawPage as JsonRecord;
  if (!Array.isArray(page.items)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_LINK_LIST_RESPONSE", "Projects service returned an invalid link page");
  }
  if (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || !page.nextCursor.trim() || page.nextCursor.trim() !== page.nextCursor)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_LINK_LIST_RESPONSE", "Projects service returned an invalid link cursor");
  }
  const parsedLinks = page.items.map((item) => parseProjectLink(item));
  if (parsedLinks.some((link) => !link || link.projectId !== projectId)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_LINK_LIST_RESPONSE", "Projects service returned an invalid Project link");
  }
  const items = await resolveProjectLinkItems(token, projectId, parsedLinks as ProjectLinkRecord[]);
  return {
    items,
    ...(typeof page.nextCursor === "string" && page.nextCursor ? { nextCursor: page.nextCursor } : {})
  };
}

export async function getProjectContextWithResolvedLinks(
  token: string,
  projectId: string,
  options: {
    q?: string;
    include?: string;
    memoryLimit?: number;
    indexLimit?: number;
    relationLimit?: number;
    maxChars?: number;
  } = {}
): Promise<JsonRecord> {
  const rawContext = await projectsClient.getContext(token, projectId, options);
  if (!rawContext || typeof rawContext !== "object" || Array.isArray(rawContext)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_CONTEXT_RESPONSE", "Projects service returned an invalid context pack");
  }
  const context = rawContext as JsonRecord;
  const project = asRecord(context.project);
  const truncation = asRecord(context.truncation);
  if (
    project.id !== projectId ||
    typeof project.name !== "string" ||
    typeof truncation.maxChars !== "number" ||
    !Array.isArray(truncation.truncatedSections)
  ) {
    throw new ProjectContextError(502, "INVALID_PROJECT_CONTEXT_RESPONSE", "Projects service returned an invalid context pack");
  }
  for (const section of ["memories", "indexEntries", "relations", "links"] as const) {
    if (context[section] !== undefined && !Array.isArray(context[section])) {
      throw new ProjectContextError(
        502,
        "INVALID_PROJECT_CONTEXT_RESPONSE",
        `Projects service returned an invalid context ${section} section`
      );
    }
  }
  const contextLinks = context.links;
  if (contextLinks === undefined) return context;
  if (!Array.isArray(contextLinks)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_CONTEXT_RESPONSE", "Projects service returned invalid context links");
  }
  const parsedLinks = contextLinks.map((item) => parseProjectLink(item));
  if (parsedLinks.some((link) => !link || link.projectId !== projectId)) {
    throw new ProjectContextError(502, "INVALID_PROJECT_CONTEXT_RESPONSE", "Projects service returned invalid context links");
  }
  const originalLinks = parsedLinks as ProjectLinkRecord[];
  const resolvedLinks = await resolveProjectLinkItems(token, projectId, originalLinks);
  const resolvedContext = {
    ...context,
    links: resolvedLinks
  };
  const maxChars = truncation.maxChars as number;
  if (JSON.stringify(resolvedContext).length <= maxChars) return resolvedContext;

  // Projects already applied the frozen context budget. Prefer live metadata,
  // but fall back link-by-link rather than violating that response invariant.
  for (let index = resolvedLinks.length - 1; index >= 0; index -= 1) {
    resolvedLinks[index] = originalLinks[index];
    if (JSON.stringify(resolvedContext).length <= maxChars) return resolvedContext;
  }
  throw new ProjectContextError(502, "INVALID_PROJECT_CONTEXT_RESPONSE", "Project context exceeds its declared budget");
}

function artifactSummary(item: ArtifactItemRecord): string {
  if (item.kind === "folder") return `Folder: ${item.title} (${item.path})`;
  if (item.kind === "file") {
    const details = [item.mimeType, typeof item.sizeBytes === "number" ? `${item.sizeBytes} bytes` : undefined]
      .filter(Boolean)
      .join(", ");
    return details ? `File: ${item.title} (${details})` : `File: ${item.title}`;
  }

  const markdown = item.contentMarkdown ?? "";
  const paragraph = markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
    .find((line) => line.length > 0);
  return (paragraph ?? `Note: ${item.title}`).slice(0, 280);
}

export function buildArtifactIndexEntry(
  item: ArtifactItemRecord,
  associationKind: "primary" | "secondary",
  associationId?: string
): JsonRecord {
  const contentForHash = [item.title, item.path, item.contentMarkdown ?? "", JSON.stringify(item.tags ?? [])].join("\n");
  return {
    sourceService: ARTIFACT_TARGET_SERVICE,
    resourceType: item.kind,
    resourceId: item.id,
    associationKind,
    ...(associationId ? { associationId } : {}),
    path: item.path,
    title: item.title,
    summaryText: artifactSummary(item),
    summarySource: "deterministic",
    sourceVersion: String(item.version),
    contentHash: createHash("sha256").update(contentForHash).digest("hex"),
    sourceUpdatedAt: item.updatedAt ?? new Date().toISOString(),
    metadataJson: {
      tags: item.tags ?? [],
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes
    }
  };
}

function collectMindmapNodeText(value: unknown, parts: string[], count: { value: number }, maxNodes = 80): void {
  if (count.value >= maxNodes) return;
  const node = asRecord(value);
  const title = boundedText(node.title, 240);
  const note = boundedText(node.note, 360);
  if (title) parts.push(title);
  if (note) parts.push(note);
  count.value += 1;
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) collectMindmapNodeText(child, parts, count, maxNodes);
}

function mindmapSummary(document: MindmapDocumentRecord): { summaryText: string; nodeCount: number } {
  const parts: string[] = [];
  const nodeCount = { value: 0 };
  collectMindmapNodeText(document.body.root, parts, nodeCount);
  const modeLabel = document.mode === "logical_tree" ? "Logical Tree" : "Mindmap";
  const description = boundedText(document.description, 360);
  const nodeSummary = parts.slice(0, 16).join(" / ");
  return {
    nodeCount: nodeCount.value,
    summaryText: boundedText([modeLabel, description, nodeSummary].filter(Boolean).join(": "), 500) ?? modeLabel
  };
}

export function buildMindmapIndexEntry(document: MindmapDocumentRecord): JsonRecord {
  const { summaryText, nodeCount } = mindmapSummary(document);
  const tags = document.tags ?? [];
  const contentForHash = [
    document.title,
    document.description ?? "",
    document.mode,
    JSON.stringify(tags),
    JSON.stringify(document.body)
  ].join("\n");

  return {
    sourceService: MINDMAP_TARGET_SERVICE,
    resourceType: MINDMAP_TARGET_RESOURCE_TYPE,
    resourceId: document.id,
    associationKind: "primary",
    path: `mindmaps/${document.id}`,
    title: document.title,
    summaryText,
    summarySource: "deterministic",
    sourceVersion: String(document.version),
    contentHash: createHash("sha256").update(contentForHash).digest("hex"),
    sourceUpdatedAt: document.updatedAt ?? new Date().toISOString(),
    metadataJson: {
      mode: document.mode,
      projectName: document.projectName,
      tags,
      nodeCount
    }
  };
}

function wbsSummary(plan: WbsPlanRecord): string {
  const rollup = asRecord(plan.rollup);
  const effort = typeof rollup.effortHours === "number" ? `${rollup.effortHours}h` : undefined;
  const progress = typeof rollup.progress === "number" ? `${Math.round(rollup.progress)}%` : undefined;
  const dates = [boundedText(rollup.startDate, 40), boundedText(rollup.dueDate, 40)].filter(Boolean).join(" to ");
  const parts = [
    "WBS",
    boundedText(plan.description, 360),
    plan.projectName,
    effort ? `effort ${effort}` : undefined,
    progress ? `progress ${progress}` : undefined,
    dates || undefined
  ].filter(Boolean);
  return boundedText(parts.join(": "), 500) ?? "WBS";
}

export function buildWbsIndexEntry(plan: WbsPlanRecord): JsonRecord {
  const contentForHash = [
    plan.title,
    plan.description ?? "",
    plan.projectName ?? "",
    JSON.stringify(plan.settings ?? {}),
    JSON.stringify(plan.rollup ?? {})
  ].join("\n");

  return {
    sourceService: WBS_TARGET_SERVICE,
    resourceType: WBS_TARGET_RESOURCE_TYPE,
    resourceId: plan.id,
    associationKind: "primary",
    path: `wbs/${plan.id}`,
    title: plan.title,
    summaryText: wbsSummary(plan),
    summarySource: "deterministic",
    sourceVersion: String(plan.version),
    contentHash: createHash("sha256").update(contentForHash).digest("hex"),
    sourceUpdatedAt: plan.updatedAt ?? new Date().toISOString(),
    metadataJson: {
      projectName: plan.projectName,
      rollup: plan.rollup ?? {}
    }
  };
}

async function listSecondaryLinks(token: string, artifactItemId: string): Promise<ProjectLinkRecord[]> {
  const links: ProjectLinkRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await projectsClient.listLinksByTarget(token, {
      targetService: ARTIFACT_TARGET_SERVICE,
      targetResourceType: ARTIFACT_TARGET_RESOURCE_TYPE,
      targetResourceId: artifactItemId,
      relationType: SECONDARY_MEMBERSHIP_RELATION,
      limit: 200,
      cursor
    });
    links.push(...pageItems(page).map(parseProjectLink).filter((link): link is ProjectLinkRecord => Boolean(link)));
    cursor = nextCursor(page);
  } while (cursor);
  return links;
}

export async function listArtifactProjectIdsBestEffort(token: string, rawItem: unknown): Promise<string[]> {
  let root: ArtifactItemRecord;
  try {
    root = parseArtifactItem(rawItem);
  } catch (error) {
    console.warn("[project-context-sync] failed to identify the Artifact Project", {
      message: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
  const projectIds = new Set<string>([root.projectId]);
  try {
    const items = new Map<string, ArtifactItemRecord>([[root.id, root]]);
    if (root.kind === "folder") {
      let cursor: string | undefined;
      do {
        const page = await artifactsClient.treeListPage(token, {
          projectId: root.projectId,
          pathPrefix: root.path,
          includeContent: false,
          limit: 500,
          cursor
        });
        for (const value of pageItems(page)) {
          const item = parseArtifactItem(value);
          items.set(item.id, item);
        }
        cursor = nextCursor(page);
      } while (cursor);
    }
    for (const item of items.values()) {
      projectIds.add(item.projectId);
      for (const link of await listSecondaryLinks(token, item.id)) projectIds.add(link.projectId);
    }
  } catch (error) {
    console.warn("[project-context-sync] failed to enumerate every Artifact Project", {
      artifactItemId: root.id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  return [...projectIds];
}

async function upsertArtifactEntry(
  token: string,
  projectId: string,
  item: ArtifactItemRecord,
  associationKind: "primary" | "secondary",
  associationId?: string
): Promise<void> {
  await projectsClient.upsertIndexEntry(token, projectId, {
    entry: buildArtifactIndexEntry(item, associationKind, associationId)
  });
}

async function tombstoneArtifactEntry(token: string, projectId: string, item: ArtifactItemRecord): Promise<void> {
  await projectsClient.tombstoneIndexEntry(token, projectId, {
    sourceService: ARTIFACT_TARGET_SERVICE,
    resourceType: item.kind,
    resourceId: item.id
  });
}

function logDerivedFailure(operation: string, itemId: string, error: unknown): void {
  console.warn("[project-index] derived update failed", {
    operation,
    artifactItemId: itemId,
    message: error instanceof Error ? error.message : String(error)
  });
}

export async function maintainArtifactIndex(token: string, rawItem: unknown): Promise<void> {
  const item = parseArtifactItem(rawItem);
  const links = await listSecondaryLinks(token, item.id);
  const activeSecondary: ProjectLinkRecord[] = [];

  for (const link of links) {
    if (link.projectId === item.projectId) {
      await projectsClient.removeLink(token, link.id);
      continue;
    }
    activeSecondary.push(link);
  }

  await upsertArtifactEntry(token, item.projectId, item, "primary");
  await Promise.all(
    activeSecondary.map((link) => upsertArtifactEntry(token, link.projectId, item, "secondary", link.id))
  );
}

export async function maintainArtifactIndexBestEffort(token: string, rawItem: unknown): Promise<void> {
  const itemId = typeof asRecord(rawItem).id === "string" ? String(asRecord(rawItem).id) : "unknown";
  try {
    await maintainArtifactIndex(token, rawItem);
  } catch (error) {
    logDerivedFailure("upsert", itemId, error);
  }
}

function logMindmapDerivedFailure(operation: string, documentId: string, error: unknown): void {
  console.warn("[project-index] mindmap derived update failed", {
    operation,
    documentId,
    message: error instanceof Error ? error.message : String(error)
  });
}

async function upsertMindmapEntry(token: string, document: MindmapDocumentRecord): Promise<void> {
  if (!document.projectId) return;
  await projectsClient.upsertIndexEntry(token, document.projectId, {
    entry: buildMindmapIndexEntry(document)
  });
}

async function tombstoneMindmapEntry(token: string, projectId: string, documentId: string): Promise<void> {
  await projectsClient.tombstoneIndexEntry(token, projectId, {
    sourceService: MINDMAP_TARGET_SERVICE,
    resourceType: MINDMAP_TARGET_RESOURCE_TYPE,
    resourceId: documentId
  });
}

export function mindmapProjectIdsBestEffort(rawDocument: unknown): string[] {
  try {
    const document = parseMindmapDocument(rawDocument);
    return document.projectId ? [document.projectId] : [];
  } catch (error) {
    console.warn("[project-context-sync] failed to identify the Mindmap Project", {
      message: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

export async function maintainMindmapIndex(token: string, rawDocument: unknown): Promise<void> {
  const document = parseMindmapDocument(rawDocument);
  await upsertMindmapEntry(token, document);
}

export async function maintainMindmapIndexBestEffort(token: string, rawDocument: unknown): Promise<void> {
  const documentId = typeof asRecord(rawDocument).id === "string" ? String(asRecord(rawDocument).id) : "unknown";
  try {
    await maintainMindmapIndex(token, rawDocument);
  } catch (error) {
    logMindmapDerivedFailure("upsert", documentId, error);
  }
}

export async function reconcileMindmapMutationBestEffort(
  token: string,
  beforeValue: unknown,
  afterValue: unknown
): Promise<void> {
  const documentId = typeof asRecord(afterValue).id === "string" ? String(asRecord(afterValue).id) : "unknown";
  try {
    const before = parseMindmapDocument(beforeValue);
    const after = parseMindmapDocument(afterValue);
    if (before.projectId && before.projectId !== after.projectId) {
      await tombstoneMindmapEntry(token, before.projectId, before.id);
    }
    await maintainMindmapIndex(token, after);
  } catch (error) {
    logMindmapDerivedFailure("reconcile", documentId, error);
  }
}

export async function cleanupDeletedMindmapBestEffort(token: string, rawDocument: unknown): Promise<void> {
  const documentId = typeof asRecord(rawDocument).id === "string" ? String(asRecord(rawDocument).id) : "unknown";
  try {
    const document = parseMindmapDocument(rawDocument);
    if (document.projectId) {
      await tombstoneMindmapEntry(token, document.projectId, document.id);
    }
  } catch (error) {
    logMindmapDerivedFailure("delete", documentId, error);
  }
}

async function listAllMindmapsForProject(token: string, projectId: string): Promise<MindmapDocumentRecord[]> {
  const documents: MindmapDocumentRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await mindmapsClient.list(token, {
      projectId,
      limit: 100,
      cursor
    });
    documents.push(...pageItems(page).map(parseMindmapDocument));
    cursor = nextCursor(page);
  } while (cursor);
  return documents;
}

export async function rebuildProjectMindmapIndex(token: string, projectId: string): Promise<JsonRecord> {
  await projectsClient.get(token, projectId);
  const documents = await listAllMindmapsForProject(token, projectId);
  const entries = documents.map(buildMindmapIndexEntry);
  const activeResourceIds = new Set(documents.map((document) => document.id));

  const batchSize = 100;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    await projectsClient.bulkUpsertIndexEntries(token, projectId, { entries: entries.slice(offset, offset + batchSize) });
  }

  let cursor: string | undefined;
  let tombstoned = 0;
  do {
    const indexed = await projectsClient.listIndexEntries(token, projectId, {
      sourceService: MINDMAP_TARGET_SERVICE,
      resourceType: MINDMAP_TARGET_RESOURCE_TYPE,
      limit: 200,
      cursor
    });
    for (const rawEntry of pageItems(indexed)) {
      const entry = asRecord(rawEntry);
      const resourceId = boundedText(entry.resourceId, 200);
      if (resourceId && !activeResourceIds.has(resourceId)) {
        await projectsClient.tombstoneIndexEntry(token, projectId, {
          sourceService: MINDMAP_TARGET_SERVICE,
          resourceType: MINDMAP_TARGET_RESOURCE_TYPE,
          resourceId
        });
        tombstoned += 1;
      }
    }
    cursor = nextCursor(indexed);
  } while (cursor);

  return {
    projectId,
    indexed: entries.length,
    tombstoned
  };
}

function logWbsDerivedFailure(operation: string, planId: string, error: unknown): void {
  console.warn("[project-index] wbs derived update failed", {
    operation,
    planId,
    message: error instanceof Error ? error.message : String(error)
  });
}

async function upsertWbsEntry(token: string, plan: WbsPlanRecord): Promise<void> {
  if (!plan.projectId) return;
  await projectsClient.upsertIndexEntry(token, plan.projectId, {
    entry: buildWbsIndexEntry(plan)
  });
}

async function tombstoneWbsEntry(token: string, projectId: string, planId: string): Promise<void> {
  await projectsClient.tombstoneIndexEntry(token, projectId, {
    sourceService: WBS_TARGET_SERVICE,
    resourceType: WBS_TARGET_RESOURCE_TYPE,
    resourceId: planId
  });
}

export function wbsProjectIdsBestEffort(rawPlan: unknown): string[] {
  try {
    const plan = parseWbsPlan(rawPlan);
    return plan.projectId ? [plan.projectId] : [];
  } catch (error) {
    console.warn("[project-context-sync] failed to identify the WBS Project", {
      message: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

export async function maintainWbsIndex(token: string, rawPlan: unknown): Promise<void> {
  const plan = parseWbsPlan(rawPlan);
  await upsertWbsEntry(token, plan);
}

export async function maintainWbsIndexBestEffort(token: string, rawPlan: unknown): Promise<void> {
  const planId = typeof asRecord(rawPlan).id === "string" ? String(asRecord(rawPlan).id) : "unknown";
  try {
    await maintainWbsIndex(token, rawPlan);
  } catch (error) {
    logWbsDerivedFailure("upsert", planId, error);
  }
}

export async function reconcileWbsMutationBestEffort(
  token: string,
  beforeValue: unknown,
  afterValue: unknown
): Promise<void> {
  const planId = typeof asRecord(afterValue).id === "string" ? String(asRecord(afterValue).id) : "unknown";
  try {
    const before = parseWbsPlan(beforeValue);
    const after = parseWbsPlan(afterValue);
    if (before.projectId && before.projectId !== after.projectId) {
      await tombstoneWbsEntry(token, before.projectId, before.id);
    }
    await maintainWbsIndex(token, after);
  } catch (error) {
    logWbsDerivedFailure("reconcile", planId, error);
  }
}

export async function cleanupDeletedWbsBestEffort(token: string, rawPlan: unknown): Promise<void> {
  const planId = typeof asRecord(rawPlan).id === "string" ? String(asRecord(rawPlan).id) : "unknown";
  try {
    const plan = parseWbsPlan(rawPlan);
    if (plan.projectId) {
      await tombstoneWbsEntry(token, plan.projectId, plan.id);
    }
  } catch (error) {
    logWbsDerivedFailure("delete", planId, error);
  }
}

async function listAllWbsPlansForProject(token: string, projectId: string): Promise<WbsPlanRecord[]> {
  const plans: WbsPlanRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await wbsClient.listPlans(token, {
      projectId,
      limit: 100,
      cursor
    });
    plans.push(...pageItems(page).map(parseWbsPlan));
    cursor = nextCursor(page);
  } while (cursor);
  return plans;
}

export async function rebuildProjectWbsIndex(token: string, projectId: string): Promise<JsonRecord> {
  await projectsClient.get(token, projectId);
  const plans = await listAllWbsPlansForProject(token, projectId);
  const entries = plans.map(buildWbsIndexEntry);
  const activeResourceIds = new Set(plans.map((plan) => plan.id));

  const batchSize = 100;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    await projectsClient.bulkUpsertIndexEntries(token, projectId, { entries: entries.slice(offset, offset + batchSize) });
  }

  let cursor: string | undefined;
  let tombstoned = 0;
  do {
    const indexed = await projectsClient.listIndexEntries(token, projectId, {
      sourceService: WBS_TARGET_SERVICE,
      resourceType: WBS_TARGET_RESOURCE_TYPE,
      limit: 200,
      cursor
    });
    for (const rawEntry of pageItems(indexed)) {
      const entry = asRecord(rawEntry);
      const resourceId = boundedText(entry.resourceId, 200);
      if (resourceId && !activeResourceIds.has(resourceId)) {
        await projectsClient.tombstoneIndexEntry(token, projectId, {
          sourceService: WBS_TARGET_SERVICE,
          resourceType: WBS_TARGET_RESOURCE_TYPE,
          resourceId
        });
        tombstoned += 1;
      }
    }
    cursor = nextCursor(indexed);
  } while (cursor);

  return {
    projectId,
    indexed: entries.length,
    tombstoned
  };
}

function mindmapExportExtension(format: "json" | "markdown" | "svg"): string {
  return format === "json" ? "json" : format === "svg" ? "svg" : "md";
}

function wbsExportExtension(format: "json" | "markdown" | "csv"): string {
  return format === "markdown" ? "md" : format;
}

function slugifyResourceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mindmap";
}

function splitResourcePath(pathValue: string | undefined): { directoryPath?: string; filename?: string } {
  const normalized = pathValue?.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return {};
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.pop();
  const directoryPath = parts.length > 0 ? parts.join("/") : undefined;
  return { directoryPath, filename };
}

export async function saveMindmapExportArtifact(
  token: string,
  documentId: string,
  options: {
    format: "json" | "markdown" | "svg";
    artifactTitle?: string;
    artifactPath?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<{ artifact: unknown; exportRecord: unknown }> {
  const exported = asRecord(await mindmapsClient.exportContent(token, documentId, { format: options.format }));
  const title = boundedText(exported.title, 240) ?? options.artifactTitle ?? "Mindmap";
  const sourceVersion = typeof exported.sourceVersion === "number" ? exported.sourceVersion : 1;
  const projectId = options.projectId ?? boundedText(exported.projectId, 200);
  const projectName = options.projectName ?? boundedText(exported.projectName, 500);
  const { directoryPath, filename } = splitResourcePath(options.artifactPath);
  const tags = [
    "mindmap-export",
    boundedText(exported.mode, 80) === "logical_tree" ? "logical-tree" : "mindmap"
  ];

  let created: unknown;
  if (options.format === "markdown") {
    const notePath =
      options.artifactPath?.trim() ||
      `mindmaps/${slugifyResourceName(options.artifactTitle ?? title)}.${mindmapExportExtension(options.format)}`;
    created = await createArtifactNoteWithIndex(token, {
      projectId,
      projectName,
      path: notePath,
      title: options.artifactTitle ?? title,
      scope: "project",
      tags,
      contentMarkdown: typeof exported.contentText === "string" ? exported.contentText : ""
    });
  } else {
    const uploadFilename =
      filename ||
      (options.artifactTitle
        ? `${slugifyResourceName(options.artifactTitle)}.${mindmapExportExtension(options.format)}`
        : boundedText(exported.filename, 240) ?? `${slugifyResourceName(title)}.${mindmapExportExtension(options.format)}`);
    created = await uploadArtifactFileWithIndex(token, {
      projectId,
      projectName,
      directoryPath: directoryPath ?? "mindmaps",
      scope: "project",
      tags,
      filename: uploadFilename,
      mimeType: boundedText(exported.mimeType, 120),
      contentBase64: typeof exported.contentBase64 === "string" ? exported.contentBase64 : Buffer.from("", "utf8").toString("base64")
    });
  }

  const createdRecord = asRecord(created);
  const artifactItemId = boundedText(createdRecord.id, 200);
  if (!artifactItemId) {
    throw new ProjectContextError(502, "MINDMAP_ARTIFACT_EXPORT_FAILED", "Mindmap export did not create an artifact item id");
  }

  const exportRecord = await mindmapsClient.recordArtifactExport(token, documentId, {
    sourceVersion,
    artifactItemId,
    artifactItemPath: boundedText(createdRecord.path, 800),
    artifactTitle: boundedText(createdRecord.title, 240) ?? options.artifactTitle ?? title,
    projectId: boundedText(createdRecord.projectId, 200) ?? projectId,
    projectName: boundedText(createdRecord.projectName, 500) ?? projectName,
    exportFormat: options.format
  });

  return { artifact: created, exportRecord };
}

export async function saveWbsExportArtifact(
  token: string,
  planId: string,
  options: {
    format: "json" | "markdown" | "csv";
    artifactTitle?: string;
    artifactPath?: string;
    projectId?: string;
    projectName?: string;
  }
): Promise<{ artifact: unknown; exportRecord: unknown }> {
  const exported = asRecord(await wbsClient.exportContent(token, planId, { format: options.format }));
  const title = boundedText(exported.title, 240) ?? options.artifactTitle ?? "WBS";
  const sourceVersion = typeof exported.sourceVersion === "number" ? exported.sourceVersion : 1;
  const projectId = options.projectId ?? boundedText(exported.projectId, 200);
  const projectName = options.projectName ?? boundedText(exported.projectName, 500);
  const { directoryPath, filename } = splitResourcePath(options.artifactPath);
  const tags = ["wbs-export"];

  let created: unknown;
  if (options.format === "markdown") {
    const notePath =
      options.artifactPath?.trim() ||
      `wbs/${slugifyResourceName(options.artifactTitle ?? title)}.${wbsExportExtension(options.format)}`;
    created = await createArtifactNoteWithIndex(token, {
      projectId,
      projectName,
      path: notePath,
      title: options.artifactTitle ?? title,
      scope: "project",
      tags,
      contentMarkdown: typeof exported.contentText === "string" ? exported.contentText : ""
    });
  } else {
    const uploadFilename =
      filename ||
      (options.artifactTitle
        ? `${slugifyResourceName(options.artifactTitle)}.${wbsExportExtension(options.format)}`
        : boundedText(exported.filename, 240) ?? `${slugifyResourceName(title)}.${wbsExportExtension(options.format)}`);
    created = await uploadArtifactFileWithIndex(token, {
      projectId,
      projectName,
      directoryPath: directoryPath ?? "wbs",
      scope: "project",
      tags,
      filename: uploadFilename,
      mimeType: boundedText(exported.mimeType, 120),
      contentBase64: typeof exported.contentBase64 === "string" ? exported.contentBase64 : Buffer.from("", "utf8").toString("base64")
    });
  }

  const createdRecord = asRecord(created);
  const artifactItemId = boundedText(createdRecord.id, 200);
  if (!artifactItemId) {
    throw new ProjectContextError(502, "WBS_ARTIFACT_EXPORT_FAILED", "WBS export did not create an artifact item id");
  }

  const exportRecord = await wbsClient.recordArtifactExport(token, planId, {
    sourceVersion,
    artifactItemId,
    artifactPath: boundedText(createdRecord.path, 800),
    format: options.format
  });

  return { artifact: created, exportRecord };
}

export async function createArtifactNoteWithIndex(token: string, payload: unknown): Promise<unknown> {
  const result = await artifactsClient.createNote(token, payload);
  await maintainArtifactIndexBestEffort(token, result);
  return result;
}

export async function uploadArtifactFileWithIndex(
  token: string,
  payload: Parameters<typeof artifactsClient.uploadFile>[1]
): Promise<unknown> {
  const result = await artifactsClient.uploadFile(token, payload);
  await maintainArtifactIndexBestEffort(token, result);
  return result;
}

export async function reconcileArtifactMutationBestEffort(
  token: string,
  beforeValue: unknown,
  afterValue: unknown
): Promise<void> {
  const itemId = typeof asRecord(afterValue).id === "string" ? String(asRecord(afterValue).id) : "unknown";
  try {
    const before = parseArtifactItem(beforeValue);
    const after = parseArtifactItem(afterValue);
    if (before.projectId !== after.projectId) {
      await tombstoneArtifactEntry(token, before.projectId, before);
    }
    await maintainArtifactIndex(token, after);

    if (before.kind === "folder") {
      let cursor: string | undefined;
      do {
        const page = await artifactsClient.treeListPage(token, {
          projectId: after.projectId,
          pathPrefix: after.path,
          includeContent: true,
          limit: 500,
          cursor
        });
        for (const descendant of pageItems(page)) await maintainArtifactIndex(token, descendant);
        cursor = nextCursor(page);
      } while (cursor);

      if (before.projectId !== after.projectId) {
        await rebuildProjectArtifactIndex(token, before.projectId);
      }
    }
  } catch (error) {
    logDerivedFailure("reconcile", itemId, error);
  }
}

export async function cleanupDeletedArtifactBestEffort(
  token: string,
  rawItem: unknown,
  knownLinks?: ProjectLinkRecord[]
): Promise<void> {
  const itemId = typeof asRecord(rawItem).id === "string" ? String(asRecord(rawItem).id) : "unknown";
  try {
    const item = parseArtifactItem(rawItem);
    const links = knownLinks ?? (await listSecondaryLinks(token, item.id));
    await Promise.all([
      tombstoneArtifactEntry(token, item.projectId, item),
      ...links.map(async (link) => {
        await projectsClient.removeLink(token, link.id);
        await tombstoneArtifactEntry(token, link.projectId, item);
      })
    ]);
  } catch (error) {
    logDerivedFailure("delete", itemId, error);
  }
}

export async function snapshotArtifactDeletion(token: string, artifactItemId: string): Promise<ArtifactDeletionSnapshot> {
  const root = parseArtifactItem(await artifactsClient.getItem(token, artifactItemId));
  const itemsById = new Map<string, ArtifactItemRecord>([[root.id, root]]);

  if (root.kind === "folder") {
    let cursor: string | undefined;
    do {
      const page = await artifactsClient.treeListPage(token, {
        projectId: root.projectId,
        pathPrefix: root.path,
        includeContent: true,
        limit: 500,
        cursor
      });
      for (const rawItem of pageItems(page)) {
        const item = parseArtifactItem(rawItem);
        itemsById.set(item.id, item);
      }
      cursor = nextCursor(page);
    } while (cursor);
  }

  const items = await Promise.all(
    [...itemsById.values()].map(async (item) => ({
      item,
      links: await listSecondaryLinks(token, item.id)
    }))
  );
  return { rootArtifactItemId: root.id, items };
}

export async function cleanupArtifactDeletionSnapshotBestEffort(
  token: string,
  snapshot: ArtifactDeletionSnapshot
): Promise<void> {
  await Promise.all(
    snapshot.items.map(({ item, links }) => cleanupDeletedArtifactBestEffort(token, item, links))
  );
}

export async function removeArtifactItemWithProjectCleanup(
  token: string,
  artifactItemId: string
): Promise<ArtifactDeletionSnapshot> {
  const snapshot = await snapshotArtifactDeletion(token, artifactItemId);
  await artifactsClient.removeItem(token, artifactItemId);
  await cleanupArtifactDeletionSnapshotBestEffort(token, snapshot);
  return snapshot;
}

export async function getArtifactProjectMemberships(token: string, artifactItemId: string): Promise<JsonRecord> {
  const item = parseArtifactItem(await artifactsClient.getItem(token, artifactItemId));
  const links = await listSecondaryLinks(token, artifactItemId);
  const projectIds = [item.projectId, ...links.map((link) => link.projectId)];
  const projects = await Promise.all(
    projectIds.map(async (projectId) => {
      try {
        return asRecord(await projectsClient.get(token, projectId));
      } catch {
        return {};
      }
    })
  );

  const primaryProject = projects[0];
  return {
    artifactItemId,
    memberships: [
      {
        projectId: item.projectId,
        projectName:
          typeof primaryProject.name === "string" ? primaryProject.name : item.projectName ?? item.projectId,
        role: "primary"
      },
      ...links.map((link, index) => {
        const project = projects[index + 1];
        const metadata = asRecord(link.metadataJson);
        return {
          projectId: link.projectId,
          projectName: typeof project.name === "string" ? project.name : link.projectId,
          role: "secondary",
          linkId: link.id,
          ...(typeof metadata.note === "string" ? { note: metadata.note } : {})
        };
      })
    ]
  };
}

export async function linkArtifactToProject(
  token: string,
  artifactItemId: string,
  input: { projectId: string; note?: string; expectedArtifactVersion?: number }
): Promise<JsonRecord> {
  const before = parseArtifactItem(await artifactsClient.getItem(token, artifactItemId));
  await projectsClient.get(token, input.projectId);

  if (before.projectId === input.projectId) {
    throw new ProjectContextError(409, "PROJECT_IS_PRIMARY_MEMBERSHIP", "Project is already the primary membership");
  }
  if (input.expectedArtifactVersion !== undefined && input.expectedArtifactVersion !== before.version) {
    throw new ProjectContextError(409, "ARTIFACT_VERSION_CONFLICT", "Artifact item version has changed");
  }

  const rawLink = await projectsClient.createLink(token, input.projectId, {
    targetService: ARTIFACT_TARGET_SERVICE,
    targetResourceType: ARTIFACT_TARGET_RESOURCE_TYPE,
    targetResourceId: artifactItemId,
    relationType: SECONDARY_MEMBERSHIP_RELATION,
    titleSnapshot: before.title,
    summarySnapshot: artifactSummary(before),
    metadataJson: input.note ? { note: input.note } : {}
  });
  const link = parseProjectLink(rawLink);
  if (!link) throw new ProjectContextError(502, "INVALID_PROJECT_LINK_RESPONSE", "Projects service returned an invalid link");

  const after = parseArtifactItem(await artifactsClient.getItem(token, artifactItemId));
  if (after.projectId === input.projectId) {
    await projectsClient.removeLink(token, link.id);
    await maintainArtifactIndexBestEffort(token, after);
    return getArtifactProjectMemberships(token, artifactItemId);
  }

  await maintainArtifactIndexBestEffort(token, after);
  return {
    ...(await getArtifactProjectMemberships(token, artifactItemId)),
    link
  };
}

export async function unlinkArtifactFromProject(
  token: string,
  artifactItemId: string,
  projectId: string
): Promise<void> {
  const item = parseArtifactItem(await artifactsClient.getItem(token, artifactItemId));
  if (item.projectId === projectId) {
    throw new ProjectContextError(
      409,
      "PRIMARY_MEMBERSHIP_CANNOT_BE_REMOVED",
      "The primary Project membership cannot be removed"
    );
  }

  const link = (await listSecondaryLinks(token, artifactItemId)).find((candidate) => candidate.projectId === projectId);
  if (!link) throw new ProjectContextError(404, "PROJECT_MEMBERSHIP_NOT_FOUND", "Secondary membership not found");
  await projectsClient.removeLink(token, link.id);
  try {
    await tombstoneArtifactEntry(token, projectId, item);
  } catch (error) {
    logDerivedFailure("unlink", item.id, error);
  }
}

export async function removeProjectLinkWithValidation(token: string, linkId: string): Promise<ProjectLinkRecord> {
  const link = parseProjectLink(await projectsClient.getLink(token, linkId));
  if (!link) throw new ProjectContextError(502, "INVALID_PROJECT_LINK_RESPONSE", "Projects service returned an invalid link");
  if (link.relationType === SECONDARY_MEMBERSHIP_RELATION) {
    await unlinkArtifactFromProject(token, link.targetResourceId, link.projectId);
    return link;
  }
  await projectsClient.removeLink(token, linkId);
  return link;
}

export async function createProjectLinkWithValidation(
  token: string,
  projectId: string,
  rawInput: unknown
): Promise<unknown> {
  const input = asRecord(rawInput);
  if (Object.prototype.hasOwnProperty.call(input, "relationType") && typeof input.relationType !== "string") {
    throw new ProjectContextError(400, "INVALID_RELATION_TYPE", "relationType must be a string when provided");
  }
  const relationType = typeof input.relationType === "string" ? input.relationType.trim() : undefined;
  const normalizedInput = { ...input };
  if (relationType) normalizedInput.relationType = relationType;
  else delete normalizedInput.relationType;

  if (relationType !== SECONDARY_MEMBERSHIP_RELATION) {
    return projectsClient.createLink(token, projectId, normalizedInput);
  }
  if (
    input.targetService !== ARTIFACT_TARGET_SERVICE ||
    input.targetResourceType !== ARTIFACT_TARGET_RESOURCE_TYPE ||
    typeof input.targetResourceId !== "string"
  ) {
    throw new ProjectContextError(
      400,
      "INVALID_SECONDARY_MEMBERSHIP_TARGET",
      "secondary_membership is only valid for an artifacts/artifact_item target"
    );
  }
  const metadata = asRecord(input.metadataJson);
  const result = await linkArtifactToProject(token, input.targetResourceId, {
    projectId,
    note: typeof metadata.note === "string" ? metadata.note : undefined
  });
  return asRecord(result).link ?? result;
}

async function listAllArtifactItemsForProject(token: string, projectId: string): Promise<ArtifactItemRecord[]> {
  const items: ArtifactItemRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await artifactsClient.treeListPage(token, {
      projectId,
      includeContent: true,
      limit: 500,
      cursor
    });
    items.push(...pageItems(page).map(parseArtifactItem));
    cursor = nextCursor(page);
  } while (cursor);
  return items;
}

async function listAllProjectLinks(token: string, projectId: string): Promise<ProjectLinkRecord[]> {
  const links: ProjectLinkRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await projectsClient.listLinks(token, projectId, {
      targetService: ARTIFACT_TARGET_SERVICE,
      targetResourceType: ARTIFACT_TARGET_RESOURCE_TYPE,
      relationType: SECONDARY_MEMBERSHIP_RELATION,
      limit: 200,
      cursor
    });
    links.push(...pageItems(page).map(parseProjectLink).filter((link): link is ProjectLinkRecord => Boolean(link)));
    cursor = nextCursor(page);
  } while (cursor);
  return links;
}

export async function getProjectDeletionImpact(token: string, projectId: string): Promise<JsonRecord> {
  await projectsClient.get(token, projectId);
  const [primaryItems, secondaryLinks] = await Promise.all([
    listAllArtifactItemsForProject(token, projectId),
    listAllProjectLinks(token, projectId)
  ]);
  return {
    projectId,
    canDelete: primaryItems.length === 0,
    primaryArtifactCount: primaryItems.length,
    secondaryArtifactCount: secondaryLinks.length,
    primaryArtifacts: primaryItems.slice(0, 20).map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      path: item.path
    })),
    secondaryMemberships: secondaryLinks.slice(0, 20).map((link) => ({
      linkId: link.id,
      artifactItemId: link.targetResourceId
    }))
  };
}

export async function assertProjectCanBeDeleted(token: string, projectId: string): Promise<JsonRecord> {
  const impact = await getProjectDeletionImpact(token, projectId);
  if (Number(impact.primaryArtifactCount) > 0) {
    throw new ProjectContextError(
      409,
      "PROJECT_HAS_PRIMARY_ARTIFACTS",
      "Move or delete primary Artifact items before deleting this Project"
    );
  }
  return impact;
}

export async function deleteProjectWithGuard(token: string, projectId: string): Promise<void> {
  await assertProjectCanBeDeleted(token, projectId);
  await projectsClient.remove(token, projectId);
}

export async function rebuildProjectArtifactIndex(token: string, projectId: string): Promise<JsonRecord> {
  await projectsClient.get(token, projectId);
  const [primaryItems, secondaryLinks] = await Promise.all([
    listAllArtifactItemsForProject(token, projectId),
    listAllProjectLinks(token, projectId)
  ]);

  const entries = primaryItems.map((item) => buildArtifactIndexEntry(item, "primary"));
  const activeResourceKeys = new Set(entries.map((entry) => `${entry.resourceType}:${entry.resourceId}`));
  let staleLinksRemoved = 0;

  for (const link of secondaryLinks) {
    try {
      const item = parseArtifactItem(await artifactsClient.getItem(token, link.targetResourceId));
      if (item.projectId === projectId) {
        await projectsClient.removeLink(token, link.id);
        staleLinksRemoved += 1;
        continue;
      }
      entries.push(buildArtifactIndexEntry(item, "secondary", link.id));
      activeResourceKeys.add(`${item.kind}:${item.id}`);
    } catch (error) {
      if (error instanceof InternalServiceError && error.service === "artifacts" && error.status === 404) {
        await projectsClient.removeLink(token, link.id);
        staleLinksRemoved += 1;
        console.warn("[project-index] removed stale secondary membership during rebuild", {
          projectId,
          linkId: link.id,
          message: error.message
        });
        continue;
      }
      throw error;
    }
  }

  const batchSize = 100;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    await projectsClient.bulkUpsertIndexEntries(token, projectId, { entries: entries.slice(offset, offset + batchSize) });
  }

  let cursor: string | undefined;
  let tombstoned = 0;
  do {
    const indexed = await projectsClient.listIndexEntries(token, projectId, {
      sourceService: ARTIFACT_TARGET_SERVICE,
      limit: 200,
      cursor
    });
    for (const rawEntry of pageItems(indexed)) {
      const entry = asRecord(rawEntry);
      if (
        typeof entry.resourceType === "string" &&
        typeof entry.resourceId === "string" &&
        !activeResourceKeys.has(`${entry.resourceType}:${entry.resourceId}`)
      ) {
        await projectsClient.tombstoneIndexEntry(token, projectId, {
          sourceService: ARTIFACT_TARGET_SERVICE,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId
        });
        tombstoned += 1;
      }
    }
    cursor = nextCursor(indexed);
  } while (cursor);

  return {
    projectId,
    indexed: entries.length,
    primary: primaryItems.length,
    secondary: entries.length - primaryItems.length,
    tombstoned,
    staleLinksRemoved
  };
}

function optionalServiceRebuildFailure(service: string, error: unknown): JsonRecord {
  if (error instanceof InternalServiceError) {
    return {
      status: "error",
      service,
      statusCode: error.status,
      message: `${error.service} service request failed with HTTP ${error.status}`
    };
  }
  return {
    status: "error",
    service,
    message: boundedText(error instanceof Error ? error.message : String(error), 500) ?? "Rebuild failed"
  };
}

export async function rebuildProjectIndex(token: string, projectId: string): Promise<JsonRecord> {
  const artifacts = await rebuildProjectArtifactIndex(token, projectId);
  let mindmaps: unknown;
  try {
    mindmaps = await rebuildProjectMindmapIndex(token, projectId);
  } catch (error) {
    mindmaps = optionalServiceRebuildFailure(MINDMAP_TARGET_SERVICE, error);
    console.warn("[project-index] mindmap rebuild failed; preserving artifact rebuild result", {
      projectId,
      mindmaps
    });
  }
  let wbs: unknown;
  try {
    wbs = await rebuildProjectWbsIndex(token, projectId);
  } catch (error) {
    wbs = optionalServiceRebuildFailure(WBS_TARGET_SERVICE, error);
    console.warn("[project-index] wbs rebuild failed; preserving other rebuild results", {
      projectId,
      wbs
    });
  }
  return { projectId, artifacts, mindmaps, wbs };
}
