import { createHash } from "node:crypto";
import { artifactsClient, InternalServiceError, projectsClient } from "./internalClients.js";

export const SECONDARY_MEMBERSHIP_RELATION = "secondary_membership";
export const ARTIFACT_TARGET_SERVICE = "artifacts";
export const ARTIFACT_TARGET_RESOURCE_TYPE = "artifact_item";

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
